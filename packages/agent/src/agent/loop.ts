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
import { zodToJsonSchema, type ChatMessageLike } from "../providers/chat.js";
import { resolveContextWindow, buildThinkingParamsForModel, mapThinkingLevel } from "../providers/registry.js";
import {
  compressMessages, estimateTokens, serializeHistory, SUMMARIZE_PROMPT,
  COMPRESS_TRIGGER_RATIO,
} from "./context.js";
import { currentApprovalPolicy, isToolDisabled, resolveToolRisk } from "../approval/policy.js";

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
  prompt: string;
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
}

/** runAgent 运行结果（供编排层汇总报告 / 调用方打印） */
export interface RunResult {
  text: string;
  report: string;
  steps: number;
  toolCount: number;
  approvals: { required: number; approved: number; denied: number };
  toolLogs: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; summary: string }>;
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

export const DEFAULT_SYSTEM_PROMPT = `你是 InFu，一个软件工程智能体，负责在用户的代码仓库中完成开发任务。你的名字就是"Infu"，自我介绍时直接说"我是 Infu"，不要自称"InFu Agent"。

工作方式：
1. 先理解任务与项目（project_scan / list_directory / read_file / search_code）。
2. 规划后使用工具执行：修改文件、运行命令、跑测试。
3. 所有工具执行结果必须基于事实（工具返回），不要臆测文件内容。
4. 高风险操作（删除、覆盖、外部命令）会触发用户审批，被拒绝时换一种方案。
5. 任务完成时用中文输出简明总结：做了什么、改动了哪些文件、测试结果、遗留风险。
6. 只做用户要求的事，不要擅自扩大范围。
`;

/**
 * 交付报告生成 — 基于工具执行记录的结构化总结（PRD 验收标准第 6 条）
 * 不依赖模型总结（模型可能遗漏），由系统侧收集事实生成。
 */
export function buildReport(opts: {
  prompt: string;
  toolLogs: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; summary: string }>;
  approvals: { required: number; approved: number; denied: number };
  steps: number;
}): string {
  const { prompt, toolLogs, approvals, steps } = opts;

  // 文件改动（write/edit）
  const fileChanges = toolLogs.filter((t) => t.tool === "write_file" || t.tool === "edit_file");
  // 测试
  const tests = toolLogs.filter((t) => t.tool === "run_test");
  // 命令
  const commands = toolLogs.filter((t) => t.tool === "run_command");
  const failed = toolLogs.filter((t) => !t.ok);

  const lines: string[] = [];
  lines.push("## 📋 交付报告");
  lines.push("");
  lines.push(`**任务**：${prompt.slice(0, 120)}`);
  lines.push(`**执行**：${steps} 轮 · ${toolLogs.length} 次工具调用 · 审批 ${approvals.required} 次（批准 ${approvals.approved} / 拒绝 ${approvals.denied}）`);
  lines.push("");

  if (fileChanges.length) {
    lines.push(`### 改动文件（${fileChanges.length}）`);
    for (const t of fileChanges) {
      const p = String(t.args.path ?? "?");
      const kind = t.tool === "write_file" ? "写入" : "修改";
      lines.push(`- ${p}（${kind}）${t.ok ? "" : "【失败】"}`);
    }
    lines.push("");
  } else {
    lines.push("### 改动文件\n- （无文件改动）\n");
  }

  if (tests.length) {
    lines.push(`### 测试结果（${tests.length} 次）`);
    for (const t of tests) {
      const pass = /pass|passed|ok|success|通过|成功|\b0\s+fail/i.test(t.summary) && t.ok;
      lines.push(`- ${t.ok ? (pass ? "✅ 通过" : "⚠️ 有失败/警告") : "❌ 执行失败"}：${t.summary.slice(0, 100)}`);
    }
    lines.push("");
  } else {
    lines.push("### 测试结果\n- （未运行测试）\n");
  }

  if (commands.length) {
    lines.push(`### 命令执行（${commands.length}）`);
    for (const t of commands.slice(0, 10)) {
      lines.push(`- ${t.ok ? "✓" : "✗"} \`${String(t.args.command ?? "").slice(0, 80)}\``);
    }
    lines.push("");
  }

  if (failed.length) {
    lines.push("### ⚠️ 失败/异常项");
    for (const t of failed.slice(0, 5)) {
      lines.push(`- ${t.tool}：${t.summary.slice(0, 100)}`);
    }
    lines.push("");
  }

  lines.push("### 风险提示");
  lines.push("- 以上改动为 Agent 自动生成，建议人工 review 后再提交（Diff 面板可查看详情）");
  lines.push("- 如需回滚：`git checkout -- <文件>` 或让 InFu 撤销改动");
  return lines.join("\n");
}

export async function runAgent(opts: AgentRunOptions): Promise<RunResult> {
  const {
    modelConfig, fallbackModelConfigs, system, prompt, tools, root,
    emit, requestApproval, maxSteps = 30, abortSignal,
    phase, suppressFinal = false, initialMessages, thinkingLevel = 2, hooks,
    delegationDepth = 0, scopeRules,
  } = opts;

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
  const allowed = Object.entries(tools);
  const openaiTools = allowed.map(([name, t]) => ({
    type: "function" as const,
    function: {
      name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema),
    },
  }));
  const toolExecutors = new Map(allowed.map(([name, t]) => [name, t.execute]));

  // 会话消息（OpenAI 兼容格式）：system + 重建历史（断点恢复/继续会话时注入）+ 本次 prompt
  let messages: ChatMessageLike[] = [
    { role: "system", content: system },
    ...(initialMessages ?? []),
    { role: "user", content: prompt },
  ];

  /**
   * v2.2 上下文压缩：估算超「当前活动模型窗口 ×80%」→ 摘要化最早部分（DB 事件流无损，
   * 只作用于运行时 messages）。预算跟当前活动模型走——降级切模型后自动跟随。
   */
  const ensureContextBudget = async () => {
    const window = resolveContextWindow({
      provider: chain.active.provider as any,
      model: chain.active.model,
      contextWindow: chain.active.contextWindow, // 显式配置优先（模型弹窗可配）
    });
    if (estimateTokens(messages) <= window * COMPRESS_TRIGGER_RATIO) return;
    const summarize = async (history: ChatMessageLike[]): Promise<string> => {
      const out: string[] = [];
      for await (const delta of streamChatWithFailover({
        chain,
        messages: [
          { role: "system", content: "你是 InFu 的上下文摘要器：把历史对话压缩为简洁中文摘要，保留任务目标、关键决策、文件改动、测试结果、未完成事项；不要编造内容。" },
          { role: "user", content: SUMMARIZE_PROMPT + serializeHistory(history) },
        ],
        signal: abortSignal,
      })) {
        if (delta.text) out.push(delta.text);
      }
      return out.join("").trim() || "（空摘要）";
    };
    const r = await compressMessages(messages, window, summarize);
    if (r.summary) {
      messages = r.messages;
      emit({ type: "context-compressed", before: r.before, after: r.after, summary: r.summary });
    }
  };
  let toolCount = 0;
  const toolLogs: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; summary: string }> = [];
  const approvals = { required: 0, approved: 0, denied: 0 };

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

  /** 任务收尾：生成交付报告（suppressFinal 时不推送，由编排层汇总后统一发） */
  const finishWithReport = (stepsUsed: number) => {
    const report = buildReport({ prompt, toolLogs, approvals, steps: stepsUsed });
    if (!suppressFinal) emit({ type: "report", content: report });
    return report;
  };

  for (let step = 0; step < maxSteps; step++) {
    if (abortSignal?.aborted) {
      const msg = "任务已停止（用户中止）";
      emit({ type: "error", message: msg });
      return { text: msg, report: "", steps: step, toolCount, approvals, toolLogs };
    }
    // 阶段边界事件（前端 Timeline 按此分组）
    emit({ type: "step-start", step: step + 1 });

    // v2.2 上下文压缩：超当前模型窗口预算 → 摘要化最老部分（DB 无损；预算跟当前活动模型走）
    await ensureContextBudget();

    // 1) 调用模型（流式：reasoning / text / toolCalls）
    let text = "";
    let reasoningText = "";
    let rawToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let callError: string | null = null;

    try {
      for await (const delta of streamChatWithFailover({
        chain,
        messages,
        tools: openaiTools,
        signal: abortSignal,
        extraBody: thinkingParamsFor,
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
      }
    } catch (e) {
      const err = e as Error;
      if (abortSignal?.aborted || err.name === "AbortError") {
        const msg = "任务已停止（用户中止）";
        emit({ type: "error", message: msg });
        return { text: msg, report: "", steps: step, toolCount, approvals, toolLogs };
      }
      callError = err.message;
    }
    if (callError) {
      emit({ type: "error", message: callError });
      throw new Error(callError);
    }

    // 2) 解析工具调用参数（JSON）
    type ParsedCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };
    const calls: ParsedCall[] = rawToolCalls
      .filter((c) => c.id && c.name)
      .map((c) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(c.arguments || "{}");
        } catch {
          input = { _raw: c.arguments };
        }
        return { toolCallId: c.id, toolName: c.name, input };
      });

    if (!calls.length) {
      const finalText = text;
      const report = finishWithReport(step + 1);
      if (!suppressFinal) emit({ type: "done", text: finalText, toolCount, steps: step + 1 });
      return { text: finalText, report, steps: step + 1, toolCount, approvals, toolLogs };
    }

    // 3) 执行工具（含审批；v2.3 批 2 函数式钩子：preToolUse 拦截/改参，postToolUse 改结果）
    // v2.5：同轮多个工具调用**并行执行**（对齐 ZCode「同一消息多个工具调用并发运行」——
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
      const execute = toolExecutors.get(call.toolName);
      if (!execute) {
        execs.push({ call, args: call.input, risk: "low", skipped: { ok: false, msg: `错误：未知工具 ${call.toolName}` } });
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

    // 3.2) 并行执行（v2.5）：每个调用独立 ctx 浅拷贝（callId 隔离，防并行时相互覆盖）
    const results = await Promise.all(
      execs.map(async ({ call, args, risk, skipped }) => {
        if (skipped) return { call, args, ok: skipped.ok, out: skipped.msg };
        // v2.5：执行前检查中止——父已终止时不再启动新工具（正在执行的工具由各工具尽快返回）
        if (abortSignal?.aborted) {
          return { call, args, ok: false, out: "任务已停止（用户中止）" };
        }
        try {
          const execute = toolExecutors.get(call.toolName)!; // 预处理已确认存在
          let out = await execute(args, { ...ctx, callId: call.toolCallId });
          // ── postToolUse 钩子（改写回填模型的工具结果文本；抛错放行）──
          out = await applyPostToolUseHooks(
            hooks?.postToolUse,
            { tool: call.toolName, args, callId: call.toolCallId, risk, phase: phase?.id },
            out,
            emit
          );
          return { call, args, ok: true, out };
        } catch (e) {
          return { call, args, ok: false, out: `工具执行异常: ${(e as Error).message}` };
        }
      })
    );

    // 3.3) 按原调用顺序回填（tool-result 事件 + 日志 + 消息——顺序与 assistant tool_calls 一致）
    for (const { call, args, ok, out } of results) {
      // summary 推完整输出（v2.1 会话落库与 Diff 面板需要完整内容；显示层自行截断）
      emit({ type: "tool-result", tool: call.toolName, ok, summary: out, callId: call.toolCallId });
      toolLogs.push({ tool: call.toolName, args, ok, summary: out });
      toolResultParts.push({ role: "tool", tool_call_id: call.toolCallId, content: out });
    }

    // 4) 回填消息，进入下一轮
    messages.push({
      role: "assistant",
      content: text,
      ...(rawToolCalls.length
        ? {
            tool_calls: rawToolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.arguments || "{}" },
            })),
          }
        : {}),
    });
    messages.push(...toolResultParts);
  }

  // 达到最大步数：不硬断，让模型输出进度总结（用户可继续发"继续"接着干）
  const finalMsg = `已达到本轮最大执行步数（${maxSteps}）。请立即输出当前进度总结，不要调用任何工具：`;
  messages.push({ role: "user", content: finalMsg });
  try {
    let summary = "";
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
    }
    const report = finishWithReport(maxSteps);
    if (!suppressFinal) emit({ type: "done", text: summary, toolCount, steps: maxSteps });
    return { text: summary, report, steps: maxSteps, toolCount, approvals, toolLogs };
  } catch (e) {
    const err = e as Error;
    if (abortSignal?.aborted || err.name === "AbortError") {
      const msg = "任务已停止（用户中止）";
      emit({ type: "error", message: msg });
      return { text: msg, report: "", steps: maxSteps, toolCount, approvals, toolLogs };
    }
    throw e;
  }
}

/** 审批请求辅助：生成唯一 id 并推送事件 */
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
    const id = randomUUID();
    emit({ type: "approval-required", id, description, risk });
    const approved = await decide(description, risk, requireExplicit);
    emit({ type: "approval-result", id, approved });
    return approved;
  };
}
