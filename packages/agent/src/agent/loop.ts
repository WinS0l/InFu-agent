/**
 * InFu Agent 循环 — Planner/Executor 单 Agent 实现（一期）
 *
 * 手动工具循环（可控、可插审批），模型调用走自研 OpenAI 兼容流式客户端：
 *   1. streamChat 调用模型（含 reasoning 流）
 *   2. 消费 delta → 推送 text / reasoning 事件
 *   3. 若模型请求工具调用：逐工具执行（高风险先审批）
 *   4. 把 assistant 消息 + tool 结果回填，进入下一轮
 *   5. 直到模型不再调用工具或超过最大步数 → 输出交付报告
 *
 * 二期（M4）：支持分层编排——通过 phase/suppressFinal 参数让本循环可被
 * orchestrator 复用于 Planner（只读规划）/ Executor（执行）/ Reviewer（审查）阶段，
 * 终态事件（report/done）由编排层统一汇总发出。
 */

import type { AgentEvent, PhaseId, ProviderKind, RiskLevel, ToolContext, ToolDef, HookFn, ToolHookInput } from "@infu/shared";
import { randomUUID } from "node:crypto";
import { streamChatWithFailover, ModelChain, type ModelCandidate } from "../providers/gateway.js";
import { zodToJsonSchema, isContextWindowExceeded, type ChatMessageLike } from "../providers/chat.js";
import { resolveContextWindow, buildThinkingParamsForModel, mapThinkingLevel } from "../providers/registry.js";
import {
  compressMessages, estimateTokens, SUMMARIZE_PROMPT,
  COMPRESS_TRIGGER_RATIO,
  recordUsageCalibration, contextCalibrationFactor,
} from "./context.js";
import { currentApprovalPolicy, isToolDisabled, resolveToolRisk } from "../approval/policy.js";
// v3.6：runAgent 收尾清理本层后台子 Agent/job（子任务随父循环结束；顶层 server/cli
// finally 清全部 depth<0，此处互补清本级——修复子智能体/定时任务内部启动的后台任务孤儿）
import { abortBackgroundAgentsByDepth } from "./subagent.js";
import { abortJobsByDepth } from "../tools/jobs.js";
// v6.0（S1）：写后自动验证（写工具成功后自动跑测试，结果回填模型）
import { maybeAutoVerify } from "./auto-verify.js";

export interface AgentRunOptions {
  /** 模型配置（provider/model/baseURL/apiKey） */
  modelConfig: {
    provider: string;
    model: string;
    baseURL?: string;
    apiKey: string;
    contextWindow?: number;
    thinkingLevels?: number;
    thinkingOverride?: Array<Record<string, unknown> | null>;
  };
  /** 备用模型链（v2.2 降级：主模型重试耗尽后依次切换；本任务内保持不自动回主模型） */
  fallbackModelConfigs?: Array<{
    provider: string;
    model: string;
    baseURL?: string;
    apiKey: string;
    contextWindow?: number;
    thinkingLevels?: number;
    thinkingOverride?: Array<Record<string, unknown> | null>;
  }>;
  /** 思考级别（v2 模型管理：4 档 UI，按模型实际级别数自动映射；1-4，缺省 2） */
  thinkingLevel?: number;
  system: string;
  /** v3.1：任务 prompt（附件图片走 content parts 数组） */
  prompt: PromptInput;
  /** 初始对话消息（v2.2 断点恢复/继续会话的消息级重建；提供时追加在 system 之后，prompt 作为新 user 消息在最后） */
  initialMessages?: ChatMessageLike[];
  tools: Record<string, ToolDef>;
  /** 项目根目录（工具操作边界） */
  root: string;
  /** 事件推送（CLI/SSE） */
  emit: (event: AgentEvent) => void;
  /** 审批实现（CLI 自动批准；Web 挂 UI） */
  /** 审批（requireExplicit：联网放行等 -y 自动批准也不放行的场景） */
  requestApproval: (
    description: string,
    risk: ToolDef["risk"],
    requireExplicit?: boolean
  ) => Promise<boolean>;
  maxSteps?: number;
  /** 中止信号（Web 停止按钮 / 服务端连接断开） */
  abortSignal?: AbortSignal;
  /** 分层编排阶段标识（进入时 emit phase-start，前端按阶段分组）；model 为该阶段所用模型（角色路由后） */
  phase?: { id: PhaseId; label: string; model?: string };
  /** 抑制终态事件（report/done），由编排层汇总后统一发出（Planner/Reviewer 阶段用） */
  suppressFinal?: boolean;
  /**
   * 函数式钩子（v2.3 批 2，插件注册）：
   *  - preToolUse：execute 前调用（tool-start 事件后）；block → 不执行直接返回拒绝文本；args 可改写
   *  - postToolUse：execute 后调用；result 可改写（回填模型的工具结果文本）
   * 钩子抛错不阻塞主流程（emit 错误事件后放行/原样返回）。
   */
  hooks?: { preToolUse?: HookFn[]; postToolUse?: HookFn[] };
  /** 委派深度（v2.5 子智能体内部字段：0=顶层；子循环 +1；入 ToolContext 供 delegate_task 深度限制） */
  delegationDepth?: number;
  /** v2.6 路径作用域规则（INFU.md「路径作用域」节；文件类工具校验；子智能体由委派方传入） */
  scopeRules?: import("@infu/shared").ScopeRule[];
  /** v3.1 附件只读白名单（用户附加文件/文件夹绝对路径；read_file/read_files 放行） */
  extraReadDirs?: string[];
  /** v2.9：当前会话 id（per-session 子 Agent 上限计数；子智能体继承） */
  sessionId?: string;
  /** v2.6 收尾：向用户提问（ask_user 工具通道；CLI 读 stdin / Web 弹窗；未提供时工具返回不可用） */
  askUser?: (
    question: string,
    options?: Array<string | { label: string; desc?: string; recommended?: boolean }>
  ) => Promise<string | null>;
  /** v2.11：后台子智能体父级消息通道（startBackgroundSubagent 注入；agent_message 工具用） */
  agentChannel?: { waitForMessage: (message: string) => Promise<string | null> };
  /** v2.14 批 18：沙箱档位覆盖（子智能体 agent 文件 sandbox 字段 → 工具执行） */
  sandboxMode?: "off" | "soft" | "restricted" | "docker" | "auto";
  /** v6.0（S4）：任务级 Token 预算（累计真实用量 prompt+completion 上限；0/缺省=不限制） */
  taskTokenBudget?: number;
}

/** runAgent 运行结果（供编排层汇总报告 / 调用方打印） */
export interface RunResult {
  text: string;
  steps: number;
  toolCount: number;
  approvals: { required: number; approved: number; denied: number };
  toolLogs: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; summary: string }>;
  /** v3：LLM usage 聚合（DeepSeek 缓存命中统计 → StatsLine 命中率；v2.12 四桶） */
  usage?: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number };
}

/**
 * preToolUse 钩子链（v2.3 批 2）：逐个执行——block → 立即返回拒绝；args 可改写；抛错放行不阻塞。
 * 返回 { args: 最终参数, blocked: 拦截原因或 null }。
 */
export async function applyPreToolUseHooks(
  hooks: NonNullable<AgentRunOptions["hooks"]>["preToolUse"] | undefined,
  input: ToolHookInput,
  emit: (e: AgentEvent) => void
): Promise<{ args: Record<string, unknown>; blocked: string | null }> {
  let args = input.args;
  for (const hook of hooks ?? []) {
    try {
      const r = (await hook(input)) as { decision?: string; reason?: string; args?: Record<string, unknown> } | void;
      if (r && r.decision === "block") {
        return { args, blocked: r.reason ?? `工具 ${input.tool} 被钩子拦截` };
      }
      if (r && r.args) {
        args = r.args;
        input = { ...input, args };
      }
    } catch (e) {
      emit({ type: "error", message: `插件钩子 preToolUse 异常（已放行）：${(e as Error).message}` });
    }
  }
  return { args, blocked: null };
}

/**
 * postToolUse 钩子链：改写回填模型的工具结果文本；抛错放行（原样返回）。
 */
export async function applyPostToolUseHooks(
  hooks: NonNullable<AgentRunOptions["hooks"]>["postToolUse"] | undefined,
  input: ToolHookInput,
  result: string,
  emit: (e: AgentEvent) => void
): Promise<string> {
  let out = result;
  for (const hook of hooks ?? []) {
    try {
      const r = (await hook(input)) as { result?: string } | void;
      if (r && typeof r.result === "string") out = r.result;
    } catch (e) {
      emit({ type: "error", message: `插件钩子 postToolUse 异常（已放行）：${(e as Error).message}` });
    }
  }
  return out;
}

export const DEFAULT_SYSTEM_PROMPT = `你是"InFu"，一个务实的 AI 助手。

工作方式：
1. 开发任务：先理解任务与项目（project_scan / project_tree / list_directory / read_file / search_code / git_status），复杂多步任务可先用 todo_write 建立任务清单跟踪进度。
2. 所有工具执行结果必须基于事实（工具返回），不要臆测文件内容。
3. 高风险操作（删除、覆盖、外部命令）会触发用户审批，被拒绝时换一种方案。
4. 任务完成时用中文输出简明总结：做了什么、改动了哪些文件、测试结果、遗留风险。
5. 只做用户要求的事，不要擅自扩大范围。

工具使用纪律（v3.1）：
6. 探索项目结构优先 project_tree（一次看全貌），不要用 list_directory 逐层递归。
7. 文件级操作（移动/复制/删除/建目录）用 file_ops 工具，不要用 run_command 调 mv/cp/rm——file_ops 有路径边界与保护检查且无需 shell，审批更轻。
8. 读文件优先 read_file 指定行号范围，不要整文件转储（大文件截断会浪费上下文）；批量读多个文件用 read_files。
9. 运行测试用 run_test（自动检测框架），只有需要自定义命令时才用 run_command。
10. 每轮只做一个状态改变（一次写操作后先观察结果再继续），成功路径上不要重复执行同一命令——重复调用会打扰用户审批。

异步任务纪律（v3.3，对齐 ZCode <task-notification> 机制）：
11. 耗时任务（长命令、独立子任务、搜索调研）优先异步启动：run_command background=true 或 delegate_task background=true——立即拿到 job id / 子智能体 id，**先去做其他工作**，不要阻塞空等。
12. 后台任务完成时你会收到一条 <task-notification> 系统消息（含 task-id/status/summary）——看到通知后：结果有用就回收（子智能体用 report，job 用 job_output），需要继续驱动就用 send_message，任务已死就中断（interrupt_agent / job_kill）。
13. 需要结果才能继续时才等待：wait_task（阻塞等待指定任务完成，可设超时）；未完成会返回进度——此时要么继续等，要么先做别的，不要反复轮询同一任务。

Agent Team 拆解纪律（v6.0 S3，复杂任务的并行协作模式）：
14. 大型任务（多模块改动、跨领域调研、可独立验证的多项产出）优先拆解为**团队并行**：识别互相独立、边界清晰的子任务（如「A 模块重构」「B 模块测试补齐」「调研某库的用法」），用 delegate_task 的 tasks 数组一次并行委派（最多 6 个，各子智能体独立上下文互不干扰），或 background=true 后台拆分后回收。
15. 拆解边界：子任务必须**无共享写冲突**（不同文件/模块）、依赖关系清晰（有依赖的串行做，先做上游再委派下游）；需要同一文件的改动不要拆给多个子智能体。汇总由你自己完成——委派前先想清楚各子任务产出的整合方式。
16. 小任务（单文件改动、单点查找、简单问答）**不要拆**——团队拆解有启动开销，只有"拆了明显更快"时才拆；拆解失败或结果冲突时，亲自重做该子任务，不要反复重派。

修复与自检闭环（v5.0）：
17. 任务涉及「修复测试失败/报错」时按收敛闭环执行：先 run_test 复现失败 → 根据失败信息定位修复 → 再 run_test 验证 → 循环直到全绿；连续 3 轮无进展必须**改变策略**（换方案/换文件/缩小范围）或如实说明卡点，不要原样重试同一命令。
18. 交付前自检：任务改动过代码且项目有测试框架时，交付前用 run_test 验证一次（自动检测框架即可）；测试失败先修复再交付，不要带着已知失败收尾。`;

/**
 * v3.1 附件：用户消息内容 parts（text + 图片视觉 base64）。
 * ChatMessageLike.content 原生支持 part 数组，模型侧按 OpenAI wire 格式消费。
 */
export type PromptPart = { type: "text"; text: string } | { type: "image"; image: string };
export type PromptInput = string | PromptPart[];

/** 提取 prompt 的纯文本（报告/拼接用；图片 part 忽略） */
export function promptText(p: PromptInput): string {
  return typeof p === "string" ? p : p.filter((x): x is { type: "text"; text: string } => x.type === "text").map((x) => x.text).join("");
}

/**
 * v2.10 批 7 视觉降级：模型不支持图片（API 拒绝 image content part）时自动降级重试——
 * 图片 parts 替换为文本提示，任务继续（不因图片附件整体失败）。
 * v2.13 精确化：只检查/替换**末尾 user 消息**（当前轮的图片）；历史消息的图片
 * （断点恢复/多轮）不剥离——剥离后后续轮次视觉能力永久丢失。
 */
function lastUserHasImages(msgs: ChatMessageLike[]): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    return Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((p) => p?.type === "image");
  }
  return false;
}
function replaceLastUserImagesWithText(msgs: ChatMessageLike[]): ChatMessageLike[] {
  const out = msgs.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const parts = m.content as Array<Record<string, unknown>>;
    if (!parts.some((p) => p?.type === "image")) continue;
    const texts = parts
      .filter((p) => p?.type !== "image")
      .map((p) => (p?.type === "text" ? String(p.text ?? "") : ""))
      .filter(Boolean);
    out[i] = {
      ...m,
      content: [...texts, "（图片已附加但当前模型不支持视觉输入，图片未发送给模型；如需分析图片请更换支持视觉的模型）"].join("\n"),
    };
    break; // 只处理末尾 user 消息
  }
  return out;
}

/** 文本 + 图片 parts（无图片时保持纯字符串，省一次 content 数组包装） */
export function withImages(text: string, images: string[]): PromptInput {
  return images.length
    ? [{ type: "text", text }, ...images.map((image): PromptPart => ({ type: "image", image }))]
    : text;
}
/**
 * v2.6 收尾：工具调用参数 JSON 修复。
 * 模型常产出 markdown 围栏、尾逗号、单引号、多余括号等，逐个尝试修复；
 * 无法修复返回 null（上层回填错误让模型重发，不把垃圾参数丢给工具执行）。
 */
export function repairToolArgs(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return {};
  let s = raw.trim();
  // 去 markdown 围栏（```json ... ``` / ``` ... ```）
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) s = fence[1].trim();
  // 去外层包裹括号（模型偶发输出 ({...})）
  s = s.replace(/^\s*\(/, "").replace(/\)\s*$/, "");
  // 统一解析 + 校验必须是普通对象（数组/标量不是工具参数）
  const parse = (str: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(str);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = parse(s);
  if (direct) return direct;
  // 修尾逗号（对象/数组结尾）
  const noTrailing = s.replace(/,\s*([}\]])/g, "$1");
  const fixedTrailing = parse(noTrailing);
  if (fixedTrailing) return fixedTrailing;
  // 单引号键/值 → 双引号（仅在无内嵌双引号时安全）
  if (!/"[^"]*"[^,}\]"]*"/.test(s)) {
    const single = s
      .replace(/([{,]\s*)'([^']*?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*?)'/g, ':"$1"');
    const fixedSingle = parse(single);
    if (fixedSingle) return fixedSingle;
  }
  return null;
}

/** v2.6 收尾：回填模型的工具结果上限（完整输出仍走事件/落库；仅裁剪模型上下文里的副本） */
export const TRIM_TOOL_RESULT = 8000;
export function trimToolResult(out: string, max = TRIM_TOOL_RESULT): string {
  if (out.length <= max) return out;
  return out.slice(0, max) + `\n…（输出过长已截断，完整内容见会话记录；共 ${out.length} 字符）`;
}

// ── v2.12 工具 schema 精简（Token 成本杠杆：MCP 大 schema 可吃 67K token）──
// 纯裁剪（不影响工具执行——执行端直接读 args，不依赖 schema 完整）；只作用于
// 组装给模型的 JSON Schema，zod 原 schema（事件/落库/校验）不动。

/** 参数 description 截断长度（保留可读性，砍掉冗余长文） */
const SCHEMA_MAX_DESC = 150;
/** 嵌套深度上限（>5 层的结构折叠——模型对深层嵌套参数几乎不会传） */
const SCHEMA_MAX_DEPTH = 5;
/** enum 保留项数（合法值够用即可） */
const SCHEMA_MAX_ENUM = 12;
/** 对象属性保留数（MCP 常见 30+ 属性的大 schema） */
const SCHEMA_MAX_PROPS = 20;
/** 工具 description 截断（内置工具手写描述普遍 <800 无感；MCP 超长被裁） */
export const TOOL_DESC_MAX = 800;

/**
 * JSON Schema 精简（递归）：
 * - 删除冗余元字段（$schema/title/default/examples/additionalProperties/definitions 等）
 * - description 截断 / enum 截断 / 属性数限制 / 深度限制（深层 properties/items 折叠）
 */
export function compactJsonSchema(s: unknown, depth = 0): unknown {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map((x) => compactJsonSchema(x, depth));
  const o = s as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    // 冗余/展示性元字段（模型不需要，纯吃 token）
    if (
      k === "$schema" || k === "title" || k === "default" || k === "examples" ||
      k === "$defs" || k === "definitions" || k === "additionalProperties"
    ) continue;
    // description 截断
    if (k === "description") {
      if (typeof v === "string" && v.length > SCHEMA_MAX_DESC) out[k] = v.slice(0, SCHEMA_MAX_DESC) + "…";
      else out[k] = v;
      continue;
    }
    // enum 截断
    if (k === "enum" && Array.isArray(v) && v.length > SCHEMA_MAX_ENUM) {
      out[k] = v.slice(0, SCHEMA_MAX_ENUM);
      continue;
    }
    // 深度限制：深层结构折叠（字段名保留、子结构不展开）
    if (depth >= SCHEMA_MAX_DEPTH && (k === "properties" || k === "items" || k === "anyOf" || k === "oneOf" || k === "allOf")) {
      continue;
    }
    // properties 属性数限制（保留前 N 个，执行端容忍未知字段）
    if (k === "properties" && typeof v === "object" && v !== null && !Array.isArray(v)) {
      const props = v as Record<string, unknown>;
      const outProps: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(props).slice(0, SCHEMA_MAX_PROPS)) {
        outProps[pk] = compactJsonSchema(pv, depth + 1);
      }
      out[k] = outProps;
      continue;
    }
    // 其余嵌套对象递归、标量原样
    out[k] = v && typeof v === "object" ? compactJsonSchema(v, depth + 1) : v;
  }
  return out;
}

/**
 * v2.6 收尾：写工具集合（串行执行——防两个写操作并行互相覆盖/竞态）。
 * 只读/委派/网络只读工具保持 v2.5 并行语义（同一消息多个工具并发运行）。
 * git_branch 保守计入（list 只读但 create/switch 写）；ask_user 必须串行（阻塞等人）。
 */
const MUTATING_TOOLS = new Set([
  "write_file", "edit_file", "run_command", "run_test",
  "git_add", "git_commit", "git_branch",
  "mcp_register", "plugin_add", "memory_write", "todo_write", "ask_user",
  // v3.1：file_ops（mv/cp/rm/mkdir）写工具串行执行
  "file_ops",
]);
export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

export async function runAgent(opts: AgentRunOptions): Promise<RunResult> {
  const {
    modelConfig, fallbackModelConfigs, system, prompt, tools, root,
    emit, requestApproval, maxSteps = 30, abortSignal,
    phase, suppressFinal = false, initialMessages, thinkingLevel = 2, hooks,
    delegationDepth = 0, scopeRules, askUser, extraReadDirs, sessionId, agentChannel, sandboxMode,
    taskTokenBudget = 0,
  } = opts;

  /**
   * v3.3 异步任务编排：后台任务完成通知局部队列（ctx.enqueueTaskNotification 写入；
   * drainTaskNotifications 每步开始消费为 user XML 消息；随循环结束自然消亡无泄漏）。
   * v3.6：声明移到 ctx 之前——ctx 的 enqueueTaskNotification 闭包引用本队列，
   * try/finally 包裹后原声明落入 try 块作用域导致闭包不可见（TS2304）。
   */
  type TaskNotificationNote = Parameters<NonNullable<ToolContext["enqueueTaskNotification"]>>[0];
  const pendingNotes: TaskNotificationNote[] = [];

  const ctx: ToolContext = {
    root,
    cwd: root,
    requestApproval,
    emit,
    // ── v2.5 子智能体委派：模型/深度信息随 ctx 传递给工具（delegate_task 解析子模型）──
    modelConfig,
    fallbackModelConfigs,
    thinkingLevel,
    delegationDepth,
    abortSignal,
    // v2.6 路径作用域（INFU.md「路径作用域」节解析结果；文件类工具校验）
    scopeRules,
    // v2.6 收尾：ask_user 通道（CLI/服务端接线；缺省工具层报不可用）
    askUser,
    // v3.1 附件只读白名单（read_file/read_files 放行）
    extraReadDirs,
    // v2.9：会话 id（per-session 子 Agent 上限计数）
    sessionId,
    // v2.11：后台子智能体消息通道（agent_message 工具；仅后台委派注入）
    agentChannel,
    // v2.14 批 18：沙箱档位覆盖（子智能体 agent 文件 sandbox 字段）
    sandboxMode,
    // v3.3 异步任务编排：后台任务完成通知入队（drainTaskNotifications 消费 →
    // 每步开始注入 user XML 消息，模型实时感知等待的任务已完成）
    enqueueTaskNotification: (note) => pendingNotes.push(note),
    // v3.0 vision 底座 / v3.4 审计修复（H1）：visionQueue 必须挂在原 ctx 上——
    // 工具执行时收到的是 `{ ...ctx, callId }` 浅拷贝，若此处不预置，push 发生在
    // 拷贝上而 loop 读回原 ctx 恒为空（read_image/screen_capture 图片永远进不了模型）
    visionQueue: [],
  };

  /**
   * v3.6：后台子 Agent/job 随本层循环结束清理（finally——覆盖正常/中止/异常全部退出路径）。
   * 按本层委派深度（delegationDepth）中止：子智能体内部启动的后台任务随子循环结束终止
   * （此前只有顶层 server/cli finally 清全部，子层与定时任务路径的后台任务会残留孤儿进程
   * 持续消耗模型配额）。与顶层 depth<0 全清互补，幂等安全。
   */
  try {

  /**
   * v3.3 异步任务编排（对齐 ZCode <task-notification> 机制）：
   * 后台任务（delegate_task background / run_command background）完成时，
   * 完成点 emit task-notification 事件（前端通知行 + 落库）+ 通过
   * ctx.enqueueTaskNotification 入队本循环的 pendingNotes——每步开始 drain 为
   * role=user 的 XML 消息注入 messages，模型下一轮请求即看到「任务已完成」通知，
   * 自主决定回收结果 / 继续其他工作。局部队列随循环结束自然消亡（无泄漏）。
   * （pendingNotes 声明已上移见 ctx 上方——try 块作用域）
   */
  /** 渲染 <task-notification> XML（与 rebuild 同格式；纯文本 user 消息，不破坏工具配对） */
  const renderTaskNotificationXml = (n: TaskNotificationNote): string =>
    `<task-notification>\n` +
    `<task-type>${n.taskType}</task-type>\n` +
    `<task-id>${n.taskId}</task-id>\n` +
    `<status>${n.status}</status>\n` +
    `<summary>${n.summary.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</summary>\n` +
    (n.outputFile ? `<output-file>${n.outputFile}</output-file>\n` : "") +
    `</task-notification>`;
  /** 每步开始消费队列（队列是用户消息——下一步请求前注入即可；模型自行决定下一步动作） */
  const drainTaskNotifications = (): void => {
    if (!pendingNotes.length) return;
    const notes = pendingNotes.splice(0);
    for (const n of notes) {
      messages.push({ role: "user", content: renderTaskNotificationXml(n) });
    }
  };

  // 模型降级链（v2.2）：主模型重试耗尽 → 依次切换备用模型；切换时发事件（审计/前端徽标）
  const chain = new ModelChain(
    [{ provider: modelConfig.provider, model: modelConfig.model, baseURL: modelConfig.baseURL, apiKey: modelConfig.apiKey, contextWindow: modelConfig.contextWindow, thinkingLevels: modelConfig.thinkingLevels, thinkingOverride: modelConfig.thinkingOverride },
     ...(fallbackModelConfigs ?? []).map((f) => ({
       provider: f.provider, model: f.model, baseURL: f.baseURL, apiKey: f.apiKey, contextWindow: f.contextWindow, thinkingLevels: f.thinkingLevels, thinkingOverride: f.thinkingOverride,
     }))],
    { onFallback: (from, to, reason) => emit({ type: "model-fallback", from, to, reason }) }
  );

  /**
   * v2 思考级别参数：4 档 UI → 按「当前活动模型」实际级别数映射 → 供应商协议参数。
   * 降级切模型后参数跟随新模型；无思考能力（levels=1）不注入。
   */
  const thinkingParamsFor = (c: ModelCandidate): Record<string, unknown> | undefined => {
    const levels = c.thinkingLevels ?? 1;
    if (levels <= 1) return undefined;
    // 小众模型：配置了 thinkingOverride 时按其每档参数注入；否则走供应商协议映射
    return buildThinkingParamsForModel(c.provider as ProviderKind, mapThinkingLevel(thinkingLevel, levels), levels, c.thinkingOverride);
  };

  // 阶段边界事件（前端按此分组展示；model = 本阶段模型，角色路由后由编排层传入）
  if (phase) emit({ type: "phase-start", phase: phase.id, label: phase.label, model: phase.model ?? chain.active.model });

  // 组装 OpenAI tools 格式（zod schema → JSON Schema）
  // v2.12：schema 精简（compactJsonSchema）——MCP/插件大 schema 吃大量 token 的最大成本杠杆；
  // 工具 description 也截断（内置工具手写描述普遍 <800 无感，MCP 超长被裁）
  const allowed = Object.entries(tools);
  const openaiTools = allowed.map(([name, t]) => ({
    type: "function" as const,
    function: {
      name,
      description: t.description.length > TOOL_DESC_MAX ? t.description.slice(0, TOOL_DESC_MAX) + "…" : t.description,
      parameters: compactJsonSchema(zodToJsonSchema(t.schema)) as Record<string, unknown>,
    },
  }));
  const toolExecutors = new Map(allowed.map(([name, t]) => [name, { execute: t.execute, schema: t.schema }]));

  // 会话消息（OpenAI 兼容格式）：system + 重建历史（断点恢复/继续会话时注入）+ 本次 prompt
  let messages: ChatMessageLike[] = [
    { role: "system", content: system },
    ...(initialMessages ?? []),
    { role: "user", content: prompt },
  ];

  /**
   * v2.2 上下文压缩：估算超「当前活动模型窗口 ×80%」→ 摘要化最早部分（DB 事件流无损，
   * 只作用于运行时 messages）。预算跟当前活动模型走——降级切模型后自动跟随。
   * v3.2：force=true 强制压缩一次（API 400 上下文超限时——估算可能低估，直接压到目标）。
   */
  const ensureContextBudget = async (force = false) => {
    const window = resolveContextWindow({
      provider: chain.active.provider as any,
      model: chain.active.model,
      contextWindow: chain.active.contextWindow, // 显式配置优先（模型弹窗可配）
    });
    // v6.0（D1/S2）：触发判定用校准因子（API 真实用量 vs 本地估算的 EWMA 比值）修正估算
    const calibFactor = contextCalibrationFactor(sessionId ?? "cli");
    if (!force && estimateTokens(messages) * calibFactor <= window * COMPRESS_TRIGGER_RATIO) return;
    const summarize = async (history: ChatMessageLike[]): Promise<string> => {
      const out: string[] = [];
      // v2.10 缓存友好：摘要请求 = 当前 system（稳定前缀）+ 原样历史消息 + 末尾摘要指令
      // ——使摘要调用成为会话最后一个请求的真前缀，复用 provider 的 warm KV cache
      // v3.4 审计修复：摘要调用补齐 usage 统计 + model-call 事件（此前统计页漏记压缩调用，
      // 长会话的 token 用量被系统性低估；模型 = 当前活跃模型，与主线一致）
      const sumUsage = { cacheHit: 0, cacheMiss: 0, promptTokens: 0, completionTokens: 0 };
      for await (const delta of streamChatWithFailover({
        chain,
        messages: [
          messages[0] ?? { role: "system", content: "你是 InFu 的上下文摘要器：把历史对话压缩为简洁中文摘要，保留任务目标、关键决策、文件改动、测试结果、未完成事项；不要编造内容。" },
          ...history,
          { role: "user", content: SUMMARIZE_PROMPT },
        ],
        signal: abortSignal,
      })) {
        if (delta.text) out.push(delta.text);
        if (delta.usage) {
          sumUsage.cacheHit += delta.usage.cacheHit;
          sumUsage.cacheMiss += delta.usage.cacheMiss;
          sumUsage.promptTokens += delta.usage.promptTokens;
          sumUsage.completionTokens += delta.usage.completionTokens;
        }
      }
      if (sumUsage.promptTokens > 0 || sumUsage.completionTokens > 0) {
        usage.cacheHit += sumUsage.cacheHit;
        usage.cacheMiss += sumUsage.cacheMiss;
        usage.promptTokens += sumUsage.promptTokens;
        usage.completionTokens += sumUsage.completionTokens;
        emit({
          type: "model-call",
          model: chain.active.model,
          promptTokens: sumUsage.promptTokens,
          completionTokens: sumUsage.completionTokens,
          cacheHit: sumUsage.cacheHit,
          cacheMiss: sumUsage.cacheMiss,
          summary: true,
        });
      }
      return out.join("").trim() || "（空摘要）";
    };
    // v3.9 审计修复（C1）：force 透传 compressMessages——原实现 ensureContextBudget(true)
    // 只跳过 loop 侧估算早退，compressMessages 内部仍按 trigger 早退（400 恢复 = 空操作）
    const r = await compressMessages(messages, window, summarize, force, calibFactor);
    // v3.5 审计修复（H5）：压缩降级死代码——原 `if (r.summary)` 门槛导致「摘要过大拒绝/
    // 摘要生成失败 → 直接丢弃最老部分」的降级路径永不生效（messages 保持未压缩，
    // 上下文持续超限）。改为「压缩确实变小才应用」（无论摘要是否可用）。
    // v3.7 审计修复：纯剪枝路径（before==after，早退返回）此前被 `after < before` 门槛丢弃
    // ——pruneToolResults 的零成本裁剪从不生效（每步白算 + 400 恢复在剪枝即可解决时失效）。
    // pruneToolResults 无剪枝时返回原数组引用（context.ts:78），`r.messages !== messages`
    // 精确区分「真发生剪枝」与「无需处理」，应用剪枝结果无副作用。
    if (r.after < r.before || r.messages !== messages) {
      messages = r.messages;
      emit({ type: "context-compressed", before: r.before, after: r.after, summary: r.summary });
    }
  };
  let toolCount = 0;
  const toolLogs: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; summary: string }> = [];
  const approvals = { required: 0, approved: 0, denied: 0 };
  // v3：LLM usage 聚合（模型 API 返回缓存命中 tokens → 命中率；v2.12 四桶）
  const usage = { cacheHit: 0, cacheMiss: 0, promptTokens: 0, completionTokens: 0 };
  // v2.10 重复调用守卫（借鉴 主流 repeat-tool-reminder）：连续同工具同参数达 3/5/8 次注入提醒
  // v2.13 修复：计数 Map 在**循环外**（原来每轮重建——跨轮累计失效，注释承诺的"连续 N 次"永不触发）
  const repeatCount = new Map<string, number>();
  // v3.0 批 6.5：记录每次调用成败——提醒仅在「连续失败」时注入（成功重复是合理确认，不打扰）
  const repeatLastOk = new Map<string, boolean>();
  const REPEAT_REMIND_AT = new Set([3, 5, 8]);

  // 审批计数（包装 requestApproval），工具层走计数版
  const guardedApproval = async (
    description: string,
    risk: ToolDef["risk"],
    requireExplicit?: boolean
  ) => {
    approvals.required++;
    const approved = await requestApproval(description, risk, requireExplicit);
    if (approved) approvals.approved++;
    else approvals.denied++;
    return approved;
  };
  ctx.requestApproval = guardedApproval;

  for (let step = 0; step < maxSteps; step++) {
    if (abortSignal?.aborted) {
      const msg = "任务已停止（用户中止）";
      emit({ type: "error", message: msg });
      return { text: msg, steps: step, toolCount, approvals, toolLogs, usage };
    }
    // v6.0（S4）+ 审计修复：任务级 Token 预算守卫——已达预算则优雅停止（不再产生
    // 任何模型调用）。负值 = 「预算已耗尽」哨兵（编排模式跨阶段剩余 0 时传 -1——
    // 原 Math.max(0, 剩余) 使剩余 0 时本守卫判「预算未启用 = 不限制」，任一阶段
    // 耗尽后后续阶段无限额跑模型）；0/缺省 = 不限制语义不变。
    if (taskTokenBudget !== 0) {
      const spent = usage.promptTokens + usage.completionTokens;
      if (taskTokenBudget < 0 || spent >= taskTokenBudget) {
        const msg = taskTokenBudget < 0
          ? `任务 Token 预算已用尽（编排阶段累计用量已超预算），任务在此停止。已完成的工作已保存，可调整预算后发送「继续」接着干。`
          : `任务 Token 预算已用尽（已用 ${spent.toLocaleString("en-US")} / 预算 ${taskTokenBudget.toLocaleString("en-US")}），任务在此停止。已完成的工作已保存，可调整预算后发送「继续」接着干。`;
        emit({ type: "error", message: msg });
        if (!suppressFinal) emit({ type: "done", text: msg, toolCount, steps: step, usage });
        return { text: msg, steps: step, toolCount, approvals, toolLogs, usage };
      }
    }
    // 阶段边界事件（前端 Timeline 按此分组）
    emit({ type: "step-start", step: step + 1 });

    // v2.2 上下文压缩：超当前模型窗口预算 → 摘要化最老部分（DB 无损；预算跟当前活动模型走）
    await ensureContextBudget();

    // v3.3 异步任务编排：drain 后台任务完成通知（注入 user XML 消息——本步请求即可见）
    drainTaskNotifications();

    // 1) 调用模型（流式：reasoning / text / toolCalls）
    let text = "";
    let reasoningText = "";
    let rawToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let callError: string | null = null;

    // v2.10 批 7：图片请求失败（模型不支持视觉）→ 自动降级重试一次（图片转文本提示）
    // v2.13 修复：① 仅当错误**含图片/视觉特征**时降级（429/网络抖动等不该触发）；
    //            ② 只检查/替换**当前轮末尾 user 消息**的图片（历史消息的图片不剥离）；
    //            ③ 重试前重置累加器（失败轮已产出的文本/工具调用残留会与重试拼接）
    let imageDegraded = false;
    // v3.2：400 上下文窗口超限重试标志（每轮一次；估算可能低估——强制压缩后重试）
    let ctxRetried = false;
    // v3.0 UI 审查：本轮模型调用的 usage（成功才 emit model-call——失败重试轮不污染统计）
    const stepUsage = { cacheHit: 0, cacheMiss: 0, promptTokens: 0, completionTokens: 0 };
    for (;;) {
      try {
        for await (const delta of streamChatWithFailover({
          chain,
          messages,
          tools: openaiTools,
          signal: abortSignal,
          extraBody: thinkingParamsFor,
          // v3.2：断网/瞬时故障重试可见性——退避期间 emit retry 事件（前端状态行倒计时）
          onRetry: (r) => emit({ type: "retry", attempt: r.attempt, maxAttempts: r.maxAttempts, delayMs: r.delayMs, message: r.message }),
        })) {
          if (delta.reasoning) {
            reasoningText += delta.reasoning;
            emit({ type: "reasoning", text: delta.reasoning });
          }
          if (delta.text) {
            text += delta.text;
            emit({ type: "text", text: delta.text });
          }
          if (delta.toolCalls?.length) {
            rawToolCalls = delta.toolCalls.map((tc) => ({
              id: tc.id ?? "",
              name: tc.name ?? "",
              arguments: tc.arguments ?? "",
            }));
          }
          // v3：usage 聚合（DeepSeek 末尾 chunk 的缓存命中统计）
          // v3.1 审计修复：失败重试轮不得污染全局——循环内只累加 stepUsage，
          // 成功 break 后统一并入全局 usage（视觉降级重试不再双计）
          if (delta.usage) {
            stepUsage.cacheHit += delta.usage.cacheHit;
            stepUsage.cacheMiss += delta.usage.cacheMiss;
            stepUsage.promptTokens += delta.usage.promptTokens;
            stepUsage.completionTokens += delta.usage.completionTokens;
          }
        }
        break; // 成功：跳出重试循环
      } catch (e) {
        const err = e as Error;
        if (abortSignal?.aborted || err.name === "AbortError") {
          const msg = "任务已停止（用户中止）";
          emit({ type: "error", message: msg });
          return { text: msg, steps: step, toolCount, approvals, toolLogs, usage };
        }
        const looksVision = /image|vision|multimodal|content part|not support|unsupported|invalid.*(content|message)/i.test(err.message);
        if (!imageDegraded && looksVision && lastUserHasImages(messages)) {
          // 模型不支持视觉：把当前轮末尾 user 消息的图片替换为文本提示后重试（仅一次）
          imageDegraded = true;
          messages = replaceLastUserImagesWithText(messages);
          // 重试前重置累加器（失败轮残留内容不拼接）
          text = "";
          reasoningText = "";
          rawToolCalls = [];
          stepUsage.cacheHit = 0;
          stepUsage.cacheMiss = 0;
          stepUsage.promptTokens = 0;
          stepUsage.completionTokens = 0;
          emit({ type: "text", text: "（当前模型不支持图片输入，已自动将图片转为文本提示继续任务）" });
          continue;
        }
        // v3.2 上下文窗口超限（对齐 主流：request-error 且 CONTEXT_WINDOW_EXCEEDED →
        // 先裁剪再压缩再重试）：估算可能低估（如 reasoning 长/工具结果大），强制压缩一次
        if (!ctxRetried && isContextWindowExceeded(e)) {
          ctxRetried = true;
          try {
            await ensureContextBudget(true);
          } catch {
            /* 压缩失败：继续透出原错误 */
          }
          text = "";
          reasoningText = "";
          rawToolCalls = [];
          stepUsage.cacheHit = 0;
          stepUsage.cacheMiss = 0;
          stepUsage.promptTokens = 0;
          stepUsage.completionTokens = 0;
          emit({ type: "text", text: "（上下文超出模型窗口，已自动压缩历史后重试）" });
          continue;
        }
        callError = err.message;
        break;
      }
    }
    if (callError) {
      emit({ type: "error", message: callError });
      throw new Error(callError);
    }
    // v3.1 审计修复：成功轮才并入全局 usage（失败重试轮的 stepUsage 已在重试前清零）
    usage.cacheHit += stepUsage.cacheHit;
    usage.cacheMiss += stepUsage.cacheMiss;
    usage.promptTokens += stepUsage.promptTokens;
    usage.completionTokens += stepUsage.completionTokens;
    // v6.0（D1/S2）：usage 校准——API 真实 prompt 用量 vs 本地估算（发送前的 messages），
    // 按会话 EWMA 更新因子；压缩触发判定时用因子修正估算（主流双轨制：真实为基准、估算作预测）
    if (stepUsage.promptTokens > 0) {
      recordUsageCalibration(sessionId ?? "cli", stepUsage.promptTokens, estimateTokens(messages));
    }
    // v3.0 UI 审查：单次模型调用落库（统计页真实数据源——时间/模型/prompt/completion；
    // 模型 = 当前活跃（降级切换后即备用模型）；provider 未返回 usage 时跳过，由估算兜底）
    if (stepUsage.promptTokens > 0 || stepUsage.completionTokens > 0) {
      emit({
        type: "model-call",
        model: chain.active.model,
        promptTokens: stepUsage.promptTokens,
        completionTokens: stepUsage.completionTokens,
        cacheHit: stepUsage.cacheHit,
        cacheMiss: stepUsage.cacheMiss,
      });
    }

    // 2) 解析工具调用参数（JSON；v2.6 收尾：畸形 JSON 自动修复，修复失败回填错误不执行）
    type ParsedCall = { toolCallId: string; toolName: string; input: Record<string, unknown>; inputError?: string };
    // v3.4 审计修复：无效调用（缺 id/name）在此统一过滤——原实现只过滤了执行列表，
    // 但 825 行回填 assistant 消息时用的是**完整 rawToolCalls**，导致 assistant.tool_calls
    // 含无对应 tool 结果的调用 → 部分 provider 校验失败返回 400 整轮报废
    const validToolCalls = rawToolCalls.filter((c) => c.id && c.name);
    const calls: ParsedCall[] = validToolCalls
      .map((c) => {
        const parsed = repairToolArgs(c.arguments ?? "");
        if (parsed === null) {
          return {
            toolCallId: c.id,
            toolName: c.name,
            input: {},
            inputError: `工具参数 JSON 解析失败（无法自动修复）：${(c.arguments ?? "").slice(0, 200)}。请重新调用该工具，给出合法 JSON 参数。`,
          };
        }
        return { toolCallId: c.id, toolName: c.name, input: parsed };
      });

    if (!calls.length) {
      const finalText = text;
      // v3.0 批 12：done 携带 usage（统计按天真实用量；无 usage 数据回退字符估算）
      if (!suppressFinal) emit({ type: "done", text: finalText, toolCount, steps: step + 1, usage });
      return { text: finalText, steps: step + 1, toolCount, approvals, toolLogs, usage };
    }

    // 3) 执行工具（含审批；v2.3 批 2 函数式钩子：preToolUse 拦截/改参，postToolUse 改结果）
    // v2.5：同轮多个工具调用**并行执行**（同轮多工具调用并发——
    // 模型可一次派发多个 delegate_task 等长任务，同时跑；结果按原调用顺序回填）
    const toolResultParts: Array<{ role: "tool"; tool_call_id: string; content: string }> = [];

    // 3.1) 预处理（顺序）：禁用检查 + tool-start 事件 + preToolUse 钩子；收集待执行调用
    const execs: Array<{
      call: typeof calls[number];
      args: Record<string, unknown>;
      risk: RiskLevel;
      /** 占位结果（禁用/钩子拦截：不执行，直接回填） */
      skipped?: { ok: boolean; msg: string };
    }> = [];
    for (const call of calls) {
      const execEntry = toolExecutors.get(call.toolName);
      if (!execEntry) {
        const available = [...toolExecutors.keys()].join("、");
        execs.push({ call, args: call.input, risk: "low", skipped: { ok: false, msg: `错误：未知工具 ${call.toolName}（可用工具：${available}）` } });
        continue;
      }
      if (call.inputError) {
        execs.push({ call, args: call.input, risk: "low", skipped: { ok: false, msg: call.inputError } });
        continue;
      }
      // v2.4 审批策略：工具级覆盖统一生效（禁用拦截 + 风险覆盖；对全部工具含 MCP/插件）
      const policy = currentApprovalPolicy();
      if (isToolDisabled(call.toolName, policy.toolOverrides)) {
        execs.push({ call, args: call.input, risk: "low", skipped: { ok: false, msg: `错误：工具 ${call.toolName} 已被审批策略禁用` } });
        continue;
      }
      const risk = resolveToolRisk(call.toolName, tools[call.toolName]?.risk ?? "low", policy.toolOverrides);
      emit({ type: "tool-start", tool: call.toolName, args: call.input, risk, callId: call.toolCallId });
      toolCount++;
      // ── preToolUse 钩子（插件注册；block → 不执行返回拒绝文本；args 可改写；抛错放行不阻塞）──
      const { args, blocked } = await applyPreToolUseHooks(
        hooks?.preToolUse,
        { tool: call.toolName, args: call.input, callId: call.toolCallId, risk, phase: phase?.id },
        emit
      );
      if (blocked) {
        execs.push({ call, args, risk, skipped: { ok: false, msg: `用户拒绝：${blocked}` } });
        continue;
      }
      execs.push({ call, args, risk });
    }

    // 3.2) 执行（v2.5 并行 + v2.6 收尾安全分组）：只读工具并行、写工具串行——
    // 模型一次派多个只读/委派任务同时跑（对齐主流）；写工具（write/edit/命令/commit 等）
    // 串行执行，防止并行写同一文件互相覆盖。每个调用独立 ctx 浅拷贝（callId 隔离）。
    const runOne = async ({ call, args, risk, skipped }: (typeof execs)[number]) => {
      if (skipped) return { call, args, ok: skipped.ok, out: skipped.msg };
      // v2.5：执行前检查中止——父已终止时不再启动新工具（正在执行的工具由各工具尽快返回）
      if (abortSignal?.aborted) {
        return { call, args, ok: false, out: "任务已停止（用户中止）" };
      }
      const key = `${call.toolName}::${JSON.stringify(args ?? {})}`;
      const n = (repeatCount.get(key) ?? 0) + 1;
      repeatCount.set(key, n);
      let out = "";
      let ok = true;
      try {
        const execEntry = toolExecutors.get(call.toolName)!; // 预处理已确认存在
        // v3.0 审计修复（D1）：运行时 schema 校验——模型传错类型/字段名时友好报错回填，
        // 让模型自纠（原实现静默透传畸形参数，工具内部各自兜底且口径不一）
        let execArgs = args;
        try {
          const parsed = execEntry.schema.safeParse(args ?? {});
          if (!parsed.success) {
            const issues = parsed.error.issues.slice(0, 3)
              .map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`)
              .join("；");
            out = `工具参数校验失败：${issues}。请检查参数类型与字段名后重新调用（不要原样重试）。`;
            ok = false;
          } else {
            execArgs = parsed.data;
          }
        } catch {
          /* schema 本身异常（z.any/宽松 schema 罕见路径）→ 按原参数执行 */
        }
        if (ok) {
          out = await execEntry.execute(execArgs as never, { ...ctx, callId: call.toolCallId });
        }
        // ── postToolUse 钩子（改写回填模型的工具结果文本；抛错放行）──
        out = await applyPostToolUseHooks(
          hooks?.postToolUse,
          { tool: call.toolName, args: execArgs, callId: call.toolCallId, risk, phase: phase?.id },
          out,
          emit
        );
        // ── v6.0（S1）写后自动验证：写工具成功改动后自动跑测试（general.autoVerify 开关；
        //    按会话+根去抖 60s；结果附在工具结果回填模型；失败静默不阻塞写操作）──
        out = await maybeAutoVerify({
          tool: call.toolName,
          ok,
          out,
          root: ctx.root,
          sessionId: ctx.sessionId,
          phase: phase?.id,
        });
      } catch (e) {
        ok = false;
        out = `工具执行异常: ${(e as Error).message}`;
      }
// v2.10 重复调用提醒（v3.0 批 6.5 优化：仅「上次同参调用失败」时注入——
      // 防死循环重试；成功重复是合理确认（如 tab 切换），不打扰）
      // v3.0 审计修复（B1）：原条件 `ok &&` 与注释相反——本次成功才提醒，而死循环
      // 重试场景（连续失败）恰好不提醒；改回「第 N 次且上次失败」即提醒（与批 6.5 意图一致）
      const prevOk = repeatLastOk.get(key) ?? true;
      repeatLastOk.set(key, ok);
      if (REPEAT_REMIND_AT.has(n) && prevOk === false) {
        out = `⚠️ 提醒：你已连续 ${n} 次以完全相同参数调用 ${call.toolName}，且上次结果失败——请检查并改变策略（路径/参数/权限/格式），勿原样重试。\n\n${out}`;
      }
      return { call, args, ok, out };
    };
    const execResults: Awaited<ReturnType<typeof runOne>>[] = [];
    // 只读组：有界滚动池并行（v2.10：单批 ≤10，防单轮 20+ 只读调用同时跑爆内存；主流 maxParallel 同款）；
    // 写组：串行（按原顺序）
    const readOnlyExecs = execs.filter((e) => !isMutatingTool(e.call.toolName));
    for (let i = 0; i < readOnlyExecs.length; i += 10) {
      execResults.push(...(await Promise.all(readOnlyExecs.slice(i, i + 10).map(runOne))));
    }
    for (const e of execs.filter((e) => isMutatingTool(e.call.toolName))) {
      execResults.push(await runOne(e));
    }
    // 按原调用顺序重组（3.3 回填顺序必须与 assistant tool_calls 一致）
    const byCallId = new Map(execResults.map((r) => [r.call.toolCallId, r]));
    const results = execs.map((e) => byCallId.get(e.call.toolCallId)!);

    // 3.3) 按原调用顺序回填（tool-result 事件 + 日志 + 消息——顺序与 assistant tool_calls 一致）
    for (const { call, args, ok, out } of results) {
      // summary 推完整输出（v2.1 会话落库与 Diff 面板需要完整内容；显示层自行截断）
      emit({ type: "tool-result", tool: call.toolName, ok, summary: out, callId: call.toolCallId });
      toolLogs.push({ tool: call.toolName, args, ok, summary: out });
      // v2.6 收尾：回填模型的消息副本统一裁剪（事件/落库保持完整，仅控模型侧上下文预算）
      toolResultParts.push({ role: "tool", tool_call_id: call.toolCallId, content: trimToolResult(out) });
    }

    // v3.0 vision 底座：本轮工具注入的视觉图片（read_image/screen_capture 推入
    // ctx.visionQueue）合并进下一条 user 消息（image part，视觉模型看到）；
    // 非视觉模型由上方降级机制（图片特征错误 → 转文本重试）兜底
    const visionImages = ctx.visionQueue?.slice() ?? [];
    if (ctx.visionQueue) ctx.visionQueue.length = 0;

    // 4) 回填消息，进入下一轮
    messages.push({
      role: "assistant",
      content: text,
      // v3.4 审计修复：回填只含有效调用（与执行列表一致——无效条目已在上方过滤，
      // 避免 assistant.tool_calls 与 tool 结果不配对被 provider 400 拒绝）
      ...(validToolCalls.length
        ? {
            tool_calls: validToolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.arguments || "{}" },
            })),
          }
        : {}),
    });
    messages.push(...toolResultParts);
    if (visionImages.length) {
      messages.push({ role: "user", content: withImages("（以下是工具注入的图片，请基于图片内容继续）", visionImages) });
    }
  }

  // 达到最大步数：不硬断，让模型输出进度总结（用户可继续发"继续"接着干）
  // v3.1 审计修复：总结调用前先压缩上下文——最后一轮工具结果已回填，若已超窗口预算
  // 直接发全量会 API 400 以 error 收尾；先 ensureContextBudget 再调用（与每轮开头一致）
  await ensureContextBudget();
  const finalMsg = `已达到本轮最大执行步数（${maxSteps}）。请立即输出当前进度总结，不要调用任何工具：`;
  messages.push({ role: "user", content: finalMsg });
  try {
    let summary = "";
    // 审计修复：收尾总结调用此前丢弃 usage——不并入全局统计、不发 model-call 事件、
    // 不被预算扣减（统计页漏记、--budget 可被最后一调用突破）。与主路径同款聚合。
    const summaryUsage = { cacheHit: 0, cacheMiss: 0, promptTokens: 0, completionTokens: 0 };
    for await (const delta of streamChatWithFailover({
      chain,
      messages,
      signal: abortSignal,
      extraBody: thinkingParamsFor,
    })) {
      if (delta.reasoning) emit({ type: "reasoning", text: delta.reasoning });
      if (delta.text) {
        summary += delta.text;
        emit({ type: "text", text: delta.text });
      }
      if (delta.usage) {
        summaryUsage.cacheHit += delta.usage.cacheHit;
        summaryUsage.cacheMiss += delta.usage.cacheMiss;
        summaryUsage.promptTokens += delta.usage.promptTokens;
        summaryUsage.completionTokens += delta.usage.completionTokens;
      }
    }
    usage.cacheHit += summaryUsage.cacheHit;
    usage.cacheMiss += summaryUsage.cacheMiss;
    usage.promptTokens += summaryUsage.promptTokens;
    usage.completionTokens += summaryUsage.completionTokens;
    if (summaryUsage.promptTokens > 0 || summaryUsage.completionTokens > 0) {
      emit({
        type: "model-call",
        model: chain.active.model,
        promptTokens: summaryUsage.promptTokens,
        completionTokens: summaryUsage.completionTokens,
        cacheHit: summaryUsage.cacheHit,
        cacheMiss: summaryUsage.cacheMiss,
      });
    }
    if (!suppressFinal) emit({ type: "done", text: summary, toolCount, steps: maxSteps, usage });
    return { text: summary, steps: maxSteps, toolCount, approvals, toolLogs, usage };
  } catch (e) {
    const err = e as Error;
    if (abortSignal?.aborted || err.name === "AbortError") {
      const msg = "任务已停止（用户中止）";
      emit({ type: "error", message: msg });
      return { text: msg, steps: maxSteps, toolCount, approvals, toolLogs, usage };
    }
    // v3.4 审计修复：max-steps 收尾总结失败不再整体 throw——任务实际已完成（工具副作用、
    // 进度全部落库），仅总结调用失败却把任务标记为 error、前端无最终输出。
    // 降级：输出「达到步数上限」完成提示（含错误信息），任务按完成收尾。
    emit({ type: "error", message: `收尾总结生成失败：${err.message}` });
    const fallback = `已达到本轮最大执行步数（${maxSteps}）但总结生成失败（${err.message}）。工作进度已保存，可继续发送「继续」让我接着干。`;
    if (!suppressFinal) emit({ type: "done", text: fallback, toolCount, steps: maxSteps, usage });
    return { text: fallback, steps: maxSteps, toolCount, approvals, toolLogs, usage };
  }
  } finally {
    try { abortBackgroundAgentsByDepth(sessionId, delegationDepth); } catch { /* 忽略 */ }
    try { abortJobsByDepth(sessionId, delegationDepth); } catch { /* 忽略 */ }
  }
}

/** 审批请求辅助：生成唯一 id 并推送事件（CLI/定时任务/子智能体路径）
 *  v3.5：full 档（完全信任）直接放行——CLI/定时任务同样生效（用户显式配置的档位） */
export function makeApprovalHandler(
  emit: (e: AgentEvent) => void,
  decide: (
    description: string,
    risk: ToolDef["risk"],
    requireExplicit?: boolean
  ) => Promise<boolean>
): (
  description: string,
  risk: ToolDef["risk"],
  requireExplicit?: boolean
) => Promise<boolean> {
  return async (description, risk, requireExplicit) => {
    if (currentApprovalPolicy().mode === "full") return true;
    const id = randomUUID();
    emit({ type: "approval-required", id, description, risk });
    const approved = await decide(description, risk, requireExplicit);
    emit({ type: "approval-result", id, approved });
    return approved;
  };
}
