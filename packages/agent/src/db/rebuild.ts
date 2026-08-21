/**
 * InFu 消息级上下文重建（v2.2）— 从会话事件流重建 OpenAI wire 格式 messages
 *
 * v2.1 遗留边界：继续会话只做「摘要注入」（buildContinuationPrompt）；
 * 本模块把 DB 全量事件流还原为完整对话（user/assistant/tool），
 * 断点恢复与继续会话由此获得完整上下文，且工具副作用不重放
 * （工具结果直接来自事件流，而非重新执行）。
 *
 * 重建规则：
 *  - user-message → user 消息（轮次边界）
 *  - step-start → 开新 assistant 轮（text/reasoning/tool_calls 累积）
 *  - text / reasoning → 拼进当前轮（reasoning 进 reasoning_content，DeepSeek 兼容字段）
 *  - tool-start（args+callId）→ assistant 的 tool_calls 条目（arguments = JSON.stringify(args)）
 *  - tool-result（完整 summary+callId）→ tool 消息（按 callId 消费式配对）
 *  - 兜底：assistant 有 tool_calls 但结果缺失（rewind 截断/中断）→ 补占位 tool 消息防 API 400；
 *          孤儿 tool-result（无对应调用）丢弃；空轮丢弃
 *  - 不重建 system（各阶段 system 由运行时注入，避免混入旧阶段提示词）
 */

import type { StoredEvent } from "@infu/shared";
import type { ChatMessageLike } from "../providers/chat.js";

export interface RebuildOptions {
  /** 是否携带 reasoning_content（DeepSeek 兼容；默认 true） */
  includeReasoning?: boolean;
  /** 只重建最近 N 个事件（长会话截断；默认全量） */
  maxEvents?: number;
  /** 诊断日志（缺失兜底等）；默认静默 */
  log?: (msg: string) => void;
}

interface RebuiltToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export function rebuildMessages(events: StoredEvent[], opts: RebuildOptions = {}): ChatMessageLike[] {
  const { includeReasoning = true, maxEvents, log } = opts;
  const slice = maxEvents != null && maxEvents > 0 ? events.slice(-maxEvents) : events;

  const messages: ChatMessageLike[] = [];
  // 工具结果队列（全局消费式配对：顺序异常也能配对；重复 callId 理论不出现，后写覆盖）
  const toolResults = new Map<string, string>();
  // 当前 assistant 轮的累积
  let curText = "";
  let curReasoning = "";
  let curCalls: RebuiltToolCall[] = [];

  let placeholderSeq = 0;
  const flush = () => {
    if (!curText && !curReasoning && !curCalls.length) return; // 空轮丢弃
    const assistant: ChatMessageLike = { role: "assistant", content: curText || "" };
    if (includeReasoning && curReasoning) assistant.reasoning_content = curReasoning;
    if (curCalls.length) {
      assistant.tool_calls = curCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
    }
    messages.push(assistant);
    // 逐调用配对工具结果（消费式）；缺失补占位（OpenAI 协议要求 assistant 有 tool_calls 必有 tool 消息）
    for (const c of curCalls) {
      const content = toolResults.get(c.id);
      if (content !== undefined) {
        toolResults.delete(c.id);
        messages.push({ role: "tool", tool_call_id: c.id, content });
      } else {
        log?.(`[rebuild] 工具结果缺失（callId=${c.id} tool=${c.name}），补占位消息`);
        messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: "（该工具结果已丢失——会话中断或回滚，无法恢复，请以工具实际读取为准）",
        });
      }
    }
    curText = "";
    curReasoning = "";
    curCalls = [];
  };

  for (const { event } of slice) {
    // v2.5：子智能体内部事件（带 subagentId）跳过——父级上下文只保留委派工具的结果文本，
    // 内部工具调用/步骤不进入父上下文（防孤儿 tool-result 误配对与上下文爆炸）
    if (event && "subagentId" in event && event.subagentId) continue;
    switch (event.type) {
      case "rewind": {
        // v2.14 批 9：回滚标记 → 注入 system 消息（AI 意识到历史被截断、知道回滚位置）
        const rw = event as Extract<import("@infu/shared").AgentEvent, { type: "rewind" }>;
        messages.push({
          role: "system",
          content: `（系统提示：对话历史曾在 seq ${rw.to} 处被回滚截断——该点之后的内容已被删除，之前的对话仍有效；请基于当前可见历史继续，不要提及已删除的内容）`,
        });
        break;
      }
      case "user-message":
        flush();
        messages.push({ role: "user", content: event.text });
        break;
      case "task-notification": {
        // v3.3 异步任务编排：后台任务完成通知 → 同运行时注入格式的 user XML 消息
        // 纯文本 user 消息，不破坏 assistant/tool 配对。
        const n = event as Extract<import("@infu/shared").AgentEvent, { type: "task-notification" }>;
        flush();
        messages.push({
          role: "user",
          content:
            `<task-notification>\n` +
            `<task-type>${n.taskType}</task-type>\n` +
            `<task-id>${n.taskId}</task-id>\n` +
            `<status>${n.status}</status>\n` +
            `<summary>${n.summary.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</summary>\n` +
            (n.outputFile ? `<output-file>${n.outputFile}</output-file>\n` : "") +
            `</task-notification>`,
        });
        break;
      }
      case "step-start":
        flush(); // 新一轮 = 新 assistant 消息
        break;
      case "text":
        curText += event.text;
        break;
      case "reasoning":
        curReasoning += event.text;
        break;
      case "tool-start": {
        // 旧数据可能缺 callId：生成占位 id（无法配对结果，会补占位 tool 消息）
        const id = event.callId || `rebuilt-${placeholderSeq++}`;
        curCalls.push({ id, name: event.tool, args: event.args });
        break;
      }
      case "tool-result":
        if (event.callId) toolResults.set(event.callId, event.summary);
        break;
      default:
        break; // phase-start/plan/report/review/done/error/approval/model-fallback/session 不进入模型上下文
    }
  }
  flush();
  return messages;
}
