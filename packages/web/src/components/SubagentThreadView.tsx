/**
 * v2.9 子智能体详情（右侧栏 tab 内容）— 对齐主流：完整消息流
 * （思考/文本/工具过程，与父 Agent 一致，实时流式更新）；名称显示在 tab 条上。
 */

import { Bot, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { SubagentThread } from "../store";
import ReasoningBlock from "./ReasoningBlock";
import Timeline from "./Timeline";
import { useCleanMarkdownBoxes } from "./markdown-clean";

/** 子智能体详情面板（右侧栏 tab 内容；tab 条负责关闭） */
export default function SubagentThreadView({ thread }: { thread: SubagentThread }) {
  const running = thread.status === "running";
  const [summaryOpen, setSummaryOpen] = useState(true);
  const flowRef = useRef<HTMLDivElement>(null);
  // v2.9：与聊天区一致——去 streamdown 表格/代码块卡片框
  useCleanMarkdownBoxes(flowRef, [thread.messages]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：名称 + 模型 + 状态（关闭由 tab 条负责） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <Bot className="h-4 w-4 shrink-0 text-info" strokeWidth={2} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-text">子智能体 · {thread.name}</span>
        {thread.model && <span className="shrink-0 font-mono text-[11px] text-sub">{thread.model}</span>}
        <span className="shrink-0 text-xs text-sub">
          {running ? (
            <span className="flex items-center gap-1.5 text-ongoing">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              运行中
            </span>
          ) : thread.ok ? (
            <span className="text-success">完成（{thread.steps} 步 / {thread.toolCount} 次工具）</span>
          ) : (
            <span className="text-danger">异常</span>
          )}
        </span>
      </div>

      {/* 委派任务描述 */}
      <div className="shrink-0 border-b border-line px-4 py-2 text-xs leading-5 text-sub">
        <span className="text-caption">委派任务：</span>
        {thread.prompt}
      </div>

      {/* 最终摘要（完成时；可折叠） */}
      {!running && thread.summary && (
        <div className="shrink-0 border-b border-line px-4 py-2">
          <button
            className="flex w-full cursor-pointer items-center gap-1.5 text-left"
            onClick={() => setSummaryOpen(!summaryOpen)}
          >
            <span className="text-xs font-medium text-info">最终摘要</span>
            <span className="ml-auto text-sub">
              {summaryOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
          </button>
          {summaryOpen && (
            <div className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-code px-3 py-2 text-[13px] leading-[22px] text-text/90">
              {thread.summary}
            </div>
          )}
        </div>
      )}

      {/* 消息流（与父 Agent 一致：思考/文本/工具过程，实时流式） */}
      <div ref={flowRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {thread.messages.length === 0 && running && (
          <div className="flex items-center gap-2 py-6 text-[13px] text-sub">
            <Loader2 className="h-4 w-4 animate-spin text-ongoing" />
            子智能体正在思考…
          </div>
        )}
        {thread.messages.map((m) => (
          <div key={m.id} className="mb-4">
            {m.reasoning && <ReasoningBlock text={m.reasoning} running={running} />}
            {m.text && (
              <div className="text-text/90">
                <Streamdown controls={{ table: false, code: false, mermaid: false }}>{m.text}</Streamdown>
              </div>
            )}
            {m.tools.length > 0 && <Timeline tools={m.tools} />}
          </div>
        ))}
        {running && (
          <div className="flex items-center gap-2 py-1 text-xs text-sub">
            <span className="shimmer-text">子智能体运行中…</span>
          </div>
        )}
      </div>
    </div>
  );
}
