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

import type { AgentEvent, PhaseId, ToolContext, ToolDef } from "@infu/shared";
import { randomUUID } from "node:crypto";
import { streamChat, zodToJsonSchema, type ChatMessageLike } from "../providers/chat.js";

export interface AgentRunOptions {
  /** 模型配置（provider/model/baseURL/apiKey） */
  modelConfig: {
    provider: string;
    model: string;
    baseURL?: string;
    apiKey: string;
  };
  system: string;
  prompt: string;
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
  /** 无工具调用能力的模型降级：只出方案不执行 */
  suggestOnly?: boolean;
  /** 中止信号（Web 停止按钮 / 服务端连接断开） */
  abortSignal?: AbortSignal;
  /** 分层编排阶段标识（进入时 emit phase-start，前端按阶段分组） */
  phase?: { id: PhaseId; label: string };
  /** 抑制终态事件（report/done），由编排层汇总后统一发出（Planner/Reviewer 阶段用） */
  suppressFinal?: boolean;
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

export const DEFAULT_SYSTEM_PROMPT = `你是 InFu，一个软件工程智能体，负责在用户的代码仓库中完成开发任务。你的名字就是"Infu"，自我介绍时直接说"我是 Infu"，不要自称"InFu Agent"。

工作方式：
1. 先理解任务与项目（project_scan / list_directory / read_file / search_code）。
2. 规划后使用工具执行：修改文件、运行命令、跑测试。
3. 所有工具执行结果必须基于事实（工具返回），不要臆测文件内容。
4. 高风险操作（删除、覆盖、外部命令）会触发用户审批，被拒绝时换一种方案。
5. 任务完成时用中文输出简明总结：做了什么、改动了哪些文件、测试结果、遗留风险。
6. 只做用户要求的事，不要擅自扩大范围。

（若处于"建议模式"：你只输出方案与命令建议，不执行任何工具——**不要输出任何工具调用格式**（如 XML <invoke> / JSON tool_calls），直接用中文给出方案文本。）`;

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
    modelConfig, system, prompt, tools, root,
    emit, requestApproval, maxSteps = 30, suggestOnly = false, abortSignal,
    phase, suppressFinal = false,
  } = opts;

  const ctx: ToolContext = {
    root,
    cwd: root,
    requestApproval,
    emit,
  };

  // 阶段边界事件（前端按此分组展示）
  if (phase) emit({ type: "phase-start", phase: phase.id, label: phase.label });

  // 组装 OpenAI tools 格式（zod schema → JSON Schema）
  const openaiTools = suggestOnly
    ? undefined
    : Object.entries(tools).map(([name, t]) => ({
        type: "function" as const,
        function: {
          name,
          description: t.description,
          parameters: zodToJsonSchema(t.schema),
        },
      }));
  const toolExecutors = new Map(Object.entries(tools).map(([name, t]) => [name, t.execute]));

  // 会话消息（OpenAI 兼容格式）
  const messages: ChatMessageLike[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
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

    // 1) 调用模型（流式：reasoning / text / toolCalls）
    let text = "";
    let reasoningText = "";
    let rawToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let callError: string | null = null;

    try {
      for await (const delta of streamChat({
        baseURL: modelConfig.baseURL || "https://api.deepseek.com/v1",
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        messages,
        tools: openaiTools,
        signal: abortSignal,
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
    const calls = rawToolCalls
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
      // 建议模式兜底：模型仍可能输出工具调用格式文本（DeepSeek 实测会模仿 XML <invoke>），
      // 明确提示未执行，避免用户误以为任务在跑
      let finalText = text;
      if (suggestOnly && /<tool_calls|<invoke\b|"tool_calls"/i.test(text)) {
        finalText +=
          "\n\n⚠ 当前为「方案」模式（只出方案，不执行工具），以上工具调用格式仅为模型文本、未被执行。如需实际执行任务，请切换到「编排」或「直接」模式后重发。";
      }
      const report = finishWithReport(step + 1);
      if (!suppressFinal) emit({ type: "done", text: finalText, toolCount, steps: step + 1 });
      return { text: finalText, report, steps: step + 1, toolCount, approvals, toolLogs };
    }

    // 3) 执行工具（含审批）
    const toolResultParts: Array<{ role: "tool"; tool_call_id: string; content: string }> = [];
    for (const call of calls) {
      const execute = toolExecutors.get(call.toolName);
      if (!execute) {
        toolResultParts.push({
          role: "tool", tool_call_id: call.toolCallId,
          content: `错误：未知工具 ${call.toolName}`,
        });
        continue;
      }
      emit({ type: "tool-start", tool: call.toolName, args: call.input, risk: tools[call.toolName]?.risk ?? "low" });
      toolCount++;
      try {
        const out = await execute(call.input, ctx);
        emit({ type: "tool-result", tool: call.toolName, ok: true, summary: out.slice(0, 200) });
        toolLogs.push({ tool: call.toolName, args: call.input, ok: true, summary: out });
        toolResultParts.push({ role: "tool", tool_call_id: call.toolCallId, content: out });
      } catch (e) {
        const msg = `工具执行异常: ${(e as Error).message}`;
        emit({ type: "tool-result", tool: call.toolName, ok: false, summary: msg });
        toolLogs.push({ tool: call.toolName, args: call.input, ok: false, summary: msg });
        toolResultParts.push({ role: "tool", tool_call_id: call.toolCallId, content: msg });
      }
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
    for await (const delta of streamChat({
      baseURL: modelConfig.baseURL || "https://api.deepseek.com/v1",
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
      messages,
      signal: abortSignal,
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
