/**
 * 子智能体委派执行（v2.5 批 1）— opencode 式委派
 *
 * delegate_task 工具的执行核心：以「独立消息上下文 + 工具子集（白名单）+ 独立步数预算」
 * 再跑一个 runAgent 子循环，结果回收给父级。
 *
 * 设计要点：
 *  - 复用 runAgent（Planner/Executor/Reviewer 本就是它的三次调用）——零循环架构改动；
 *    子循环事件经 emit 包装打 subagentId 标（共享父级审批链与落库通道），UI 按委派卡片内嵌展示
 *  - 独立上下文：子循环 messages 全新，父级只收一条截断的工具结果文本
 *  - 并行执行：tasks 数组 → Promise.all 多路并行，结果合并回收
 *  - 安全边界：
 *    · 深度限制 MAX_DELEGATION_DEPTH=1（子智能体不可再委派，防递归失控）
 *    · root 参数越界检查（只能在父级 root 内）
 *    · 工具白名单只对内置 TOOLS 生效；delegate_task/mcp_register/plugin_add 架构级排除
 *      （子智能体不能再委派、不能自注册——防提权/投毒）
 *    · 未显式授权时默认只读 + run_test（写能力需 tools 白名单显式给出）
 */

import path from "node:path";
import type { AgentEvent, RuntimeModelInfo, ToolContext, ToolDef } from "@infu/shared";
import { runAgent } from "./loop.js";
import { readAgentFile, READONLY_TOOLS } from "./agents.js";
import { loadConfig, resolveFallbackModels, resolveModel, toRuntimeModel } from "../providers/registry.js";

/** 最大委派深度（0=顶层；子智能体 +1；达到上限拒绝再委派） */
export const MAX_DELEGATION_DEPTH = 1;

/** 子智能体返回给父级的文本兜底上限（防失控；正常路径靠摘要字数约束，父完整接收） */
export const MAX_SUBAGENT_RESULT = 20000;

/** 架构级不可注入子智能体的工具（防递归委派/自注册提权）；白名单写明也拒绝 */
export const SUBAGENT_FORBIDDEN_TOOLS = new Set(["delegate_task", "mcp_register", "plugin_add"]);

/** 子智能体默认角色 system prompt（未指定 agent 文件时使用；内置 general-purpose 同款语义） */
export const DEFAULT_SUBAGENT_SYSTEM =
  "你是 InFu 的通用子智能体，专注完成被父智能体委派的子任务。\n" +
  "要求：\n" +
  "1. 只处理委派范围的任务，不要越界修改范围外的代码；\n" +
  "2. 只使用可用工具，基于工具返回的事实行动，不要臆测；\n" +
  "3. 完成后输出结构化摘要：结论 / 关键发现 / 建议，总字数不超过 2000 字。";

/** 单路子任务规格（delegate_task 的 prompt 或 tasks[] 元素） */
export interface SubagentSpec {
  prompt: string;
  /** agent 文件角色名（.infu/agents/<name>.md；缺省用默认角色） */
  agent?: string;
  /** 工具白名单（内置工具名；缺省 = 只读 + run_test） */
  tools?: string[];
  /** 子工作目录（相对父级 root 或绝对路径；越界拒绝） */
  root?: string;
  /** 子循环步数上限（缺省 12） */
  maxSteps?: number;
  /** 子模型 id（config models 引用；缺省继承父级模型） */
  modelId?: string;
}

/** 委派执行上下文（delegate_task 的 ToolContext + 父级运行信息） */
export interface DelegationContext {
  /** 全量工具注册表（白名单解析；不含 MCP/插件——子智能体 v1 仅内置工具） */
  tools: Record<string, ToolDef>;
  root: string;
  emit: (e: AgentEvent) => void;
  requestApproval: ToolContext["requestApproval"];
  modelConfig?: RuntimeModelInfo;
  fallbackModelConfigs?: RuntimeModelInfo[];
  thinkingLevel?: number;
  delegationDepth?: number;
  abortSignal?: AbortSignal;
  /** 父级 delegate_task 的工具调用 id（subagent-start 的 parentCallId，UI 关联委派条目） */
  parentCallId?: string;
  /** 只读委派（免审批）标记：subagent-start 事件携带，前端据此展示审批状态 */
  readOnly?: boolean;
}

/** 子任务结果（回收给父级） */
export interface SubagentResult {
  id: string;
  name: string;
  text: string;
  steps: number;
  toolCount: number;
  ok: boolean;
}

/** 打标事件类型白名单（顶层事件 done/error/report 等不打标——子循环 suppressFinal 本就不发终态） */
const TAGGABLE_TYPES = new Set([
  "text", "reasoning", "step-start", "phase-start", "tool-start", "tool-result",
  "approval-required", "approval-result", "model-fallback", "context-compressed",
]);

/** 给事件打 subagentId 标（非打标类型原样返回） */
export function tagSubagent(event: AgentEvent, subagentId: string): AgentEvent {
  if (!TAGGABLE_TYPES.has(event.type)) return event;
  return { ...event, subagentId } as AgentEvent;
}

function genId(): string {
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 解析子工作目录：相对父级 root 解析，越界拒绝；缺省 = 父级 root */
function resolveSubRoot(spec: SubagentSpec, parentRoot: string): string {
  if (!spec.root) return parentRoot;
  const abs = path.isAbsolute(spec.root) ? path.normalize(spec.root) : path.resolve(parentRoot, spec.root);
  const base = path.resolve(parentRoot) + path.sep;
  if (!abs.startsWith(base) && abs !== path.resolve(parentRoot)) {
    throw new Error(`错误：子智能体 root 越界（${spec.root} 不在项目根 ${parentRoot} 内）`);
  }
  return abs;
}

/** 解析子模型：modelId 显式（config 引用）> agent 文件 model > 父级模型；缺模型配置报错 */
function resolveSubModel(
  spec: SubagentSpec,
  agentModel: string | undefined,
  parent: RuntimeModelInfo | undefined,
  parentFallbacks: RuntimeModelInfo[] | undefined
): { modelConfig: RuntimeModelInfo; fallbackModelConfigs?: RuntimeModelInfo[] } {
  const explicitId = spec.modelId ?? agentModel;
  if (explicitId) {
    const cfg = loadConfig();
    if (!cfg || !cfg.models?.length) throw new Error(`错误：无法解析子模型 "${explicitId}"（未配置模型）`);
    const m = resolveModel(cfg, explicitId); // 找不到直接抛错（含可用模型列表）
    const runtime = toRuntimeModel(cfg, m);
    const fallbacks = resolveFallbackModels(cfg, m).map((f) => toRuntimeModel(cfg, f));
    return { modelConfig: runtime, fallbackModelConfigs: fallbacks.length ? fallbacks : undefined };
  }
  if (!parent) throw new Error("错误：缺少子模型配置（delegate_task 需要 modelConfig 上下文或 modelId 参数）");
  return { modelConfig: parent, fallbackModelConfigs: parentFallbacks };
}

/**
 * 解析工具白名单（agent 文件 tools > 参数 tools > 缺省 = 全部内置工具，对齐 ZCode general-purpose）；
 * 未知/禁用工具报错。写能力不再需要显式授权（默认全工具），只读 agent 用白名单收窄。
 */
function resolveSubTools(
  spec: SubagentSpec,
  agentTools: string[] | undefined,
  registry: Record<string, ToolDef>
): Record<string, ToolDef> {
  const names = agentTools ?? spec.tools;
  if (!names) {
    // 缺省 = 全部内置工具（架构级排除项除外）
    const out: Record<string, ToolDef> = {};
    for (const [n, t] of Object.entries(registry)) {
      if (!SUBAGENT_FORBIDDEN_TOOLS.has(n)) out[n] = t;
    }
    return out;
  }
  const out: Record<string, ToolDef> = {};
  const valid = new Set(Object.keys(registry));
  for (const n of names) {
    if (SUBAGENT_FORBIDDEN_TOOLS.has(n)) {
      throw new Error(`错误：工具 "${n}" 不可注入子智能体（架构级限制：子智能体不能委派/自注册）`);
    }
    if (!valid.has(n)) {
      throw new Error(`错误：工具 "${n}" 不存在或不可用，可用内置工具: ${[...valid].join(", ")}`);
    }
    out[n] = registry[n];
  }
  return out;
}

/** 判断一次委派是否只读（agent 文件 tools / 参数 tools 全部 ∈ 只读集；缺省 = 全工具 = 非只读） */
export function isReadOnlyDelegation(spec: SubagentSpec, root: string): boolean {
  let tools: string[] | undefined;
  if (spec.agent) {
    const def = readAgentFile(spec.agent, root);
    tools = def?.tools;
  }
  const names = tools ?? spec.tools;
  if (!names) return false; // 缺省全工具（有写能力）
  return names.every((n) => READONLY_TOOLS.includes(n));
}

/** 委派审批描述（delegate_task 授权：有写能力的委派需一次审批；只读委派免审批；描述含工具范围） */
export function describeDelegation(spec: SubagentSpec, root: string): string {
  const parts = [`委派子智能体执行任务（一次授权，内部工具不再逐个询问）：${spec.prompt.slice(0, 200)}`];
  let tools: string[] | undefined;
  if (spec.agent) {
    const def = readAgentFile(spec.agent, root);
    if (def) {
      parts.push(`角色 ${def.name}：${def.description.slice(0, 100)}`);
      tools = def.tools;
    }
  }
  // 工具范围：参数 tools > agent 文件 tools > 缺省 = 全部内置工具
  const scope = spec.tools?.length ? spec.tools : tools;
  parts.push(`工具范围：${scope?.join(", ") || "全部内置工具（缺省）"}`);
  if (spec.maxSteps) parts.push(`步数上限 ${spec.maxSteps}`);
  return parts.join("\n");
}

/** 子智能体内部免审批包装（父级已批准委派 = 显式授权；安全红线 requireExplicit 仍逐条询问） */
function makeSubagentApproval(ctx: DelegationContext): ToolContext["requestApproval"] {
  return async (description, risk, requireExplicit) => {
    if (requireExplicit) return ctx.requestApproval(description, risk, requireExplicit);
    return true; // 继承委派授权（审计仍在：tool-start/tool-result 全量落库）
  };
}

/** 执行单路子智能体（独立上下文 + 事件打标 + 结果回收） */
export async function runSubagent(spec: SubagentSpec, ctx: DelegationContext): Promise<SubagentResult> {
  // 深度限制：子智能体不可再委派（防递归失控）
  if ((ctx.delegationDepth ?? 0) >= MAX_DELEGATION_DEPTH) {
    throw new Error(`错误：委派深度超限（最大 ${MAX_DELEGATION_DEPTH} 层）——子智能体不可再委派子任务`);
  }

  // agent 文件角色定义（可选）：正文 = system prompt，frontmatter 覆盖工具/模型/步数
  const agentDef = spec.agent ? readAgentFile(spec.agent, ctx.root) : null;
  if (spec.agent && !agentDef) {
    throw new Error(`错误：未找到 agent 定义 "${spec.agent}"（写入 .infu/agents/${spec.agent}.md 即自动注册）`);
  }

  const id = genId();
  const name = agentDef?.name ?? "子智能体";
  const subRoot = resolveSubRoot(spec, ctx.root);
  const { modelConfig, fallbackModelConfigs } = resolveSubModel(spec, agentDef?.model, ctx.modelConfig, ctx.fallbackModelConfigs);
  const tools = resolveSubTools(spec, agentDef?.tools, ctx.tools);
  const maxSteps = spec.maxSteps ?? agentDef?.maxSteps ?? 12;
  const thinkingLevel = agentDef?.thinkingLevel ?? ctx.thinkingLevel ?? 2;

  // 事件打标包装：子循环全部过程事件带 subagentId（UI 路由进委派卡片；DB 审计可追溯）
  const taggedEmit = (e: AgentEvent) => ctx.emit(tagSubagent(e, id));

  // 子智能体启动事件（parentCallId 由 delegate_task 传入，UI 关联委派工具条目；
  // readOnly 标记：只读委派免审批，前端据此展示徽标而非红色 high）
  ctx.emit({
    type: "subagent-start",
    id,
    name,
    prompt: spec.prompt.slice(0, 500),
    parentCallId: ctx.parentCallId,
    model: modelConfig.model,
    readOnly: ctx.readOnly,
  });

  const result = await runAgent({
    modelConfig,
    fallbackModelConfigs,
    thinkingLevel,
    system: agentDef?.body ?? DEFAULT_SUBAGENT_SYSTEM,
    prompt: spec.prompt,
    tools,
    root: subRoot,
    emit: taggedEmit,
    // 内部工具权限（v2.5 返工）：allow（默认）= 父批准委派后继承授权（requireExplicit 安全红线仍转发）；
    // ask = 内部工具仍逐条走父级审批（agent 文件 permission: ask）
    requestApproval: agentDef?.permission === "ask" ? ctx.requestApproval : makeSubagentApproval(ctx),
    maxSteps,
    abortSignal: ctx.abortSignal,
    // 子循环阶段标识：前端按 phase 分组；suppressFinal 抑制 report/done（终态由本层回收）
    phase: { id: "executor", label: `子智能体 · ${name}`, model: modelConfig.model },
    suppressFinal: true,
    delegationDepth: (ctx.delegationDepth ?? 0) + 1,
  });

  const done: SubagentResult = {
    id,
    name,
    text: result.text,
    steps: result.steps,
    toolCount: result.toolCount,
    ok: result.steps > 0 && !result.text.startsWith("任务已停止"),
  };
  ctx.emit({
    type: "subagent-done",
    id,
    // v2.5 返工⑥：父 Agent 完整接收子智能体摘要（字数由 system 输出约定约束，
    // 不物理截断；完整输出同时全量落库可审计）
    text: done.text,
    steps: done.steps,
    toolCount: done.toolCount,
    ok: done.ok,
  });
  return done;
}

/** 委派入口：单任务或 tasks 并行批量，合并结果文本回收给父级 */
export async function delegateTasks(specs: SubagentSpec[], ctx: DelegationContext): Promise<string> {
  const results = await Promise.all(specs.map((s) => runSubagent(s, ctx)));
  const parts = results.map(
    (r, i) =>
      `\n${specs.length > 1 ? `【子任务 ${i + 1}】` : ""}${r.name}（${r.steps} 步 / ${r.toolCount} 次工具）：\n${r.text}`
  );
  const joined = parts.join("\n").trim();
  return joined.length > MAX_SUBAGENT_RESULT
    ? `${joined.slice(0, MAX_SUBAGENT_RESULT)}\n\n…（结果已截断）`
    : joined;
}
