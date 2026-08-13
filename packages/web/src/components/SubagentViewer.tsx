/**
 * v2.5 子智能体详情弹窗（右侧栏）— 对齐 opencode / Claude Code：点击子 Agent 条目，
 * 在右侧栏打开其**完整消息流**（思考/文本/工具过程，与父 Agent 一致，实时流式更新）。
 */

import { X, Bot, Loader2, Check, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Streamdown } from "streamdown";
import { useStore, type SubagentThread } from "../store";
import ReasoningBlock from "./ReasoningBlock";
import Timeline from "./Timeline";

/** 子智能体详情面板（右侧栏；subagentViewer 非空时显示） */
export default function SubagentViewer() {
  const subagentId = useStore((s) => s.subagentViewer);
  const thread = useStore((s) => (subagentId ? s.subagentThreads[subagentId] : undefined));
  const close = useStore((s) => s.closeSubagentViewer);
  const [summaryOpen, setSummaryOpen] = useState(true);

  if (!subagentId || !thread) return null;
  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-[420px] max-w-[85vw] flex-col border-l border-line bg-panel shadow-2xl">
      <SubagentViewerInner thread={thread} summaryOpen={summaryOpen} setSummaryOpen={setSummaryOpen} onClose={close} />
    </div>
  );
}

function SubagentViewerInner({ thread, summaryOpen, setSummaryOpen, onClose }: {
  thread: SubagentThread;
  summaryOpen: boolean;
  setSummaryOpen: (v: boolean) => void;
  onClose: () => void;
}) {
  const running = thread.status === "running";
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：名称 + 状态 + 关闭 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Bot className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={2} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text">子智能体 · {thread.name}</span>
        {thread.model && <span className="shrink-0 font-mono text-[9px] text-sub">{thread.model}</span>}
        <span className="shrink-0 text-[10px]">
          {running ? (
            <span className="flex items-center gap-1 text-accent">
              <Loader2 className="h-3 w-3 animate-spin" />
              运行中
            </span>
          ) : thread.ok ? (
            <span className="flex items-center gap-1 text-accent">
              <Check className="h-3 w-3" />
              完成（{thread.steps} 步 / {thread.toolCount} 次工具）
            </span>
          ) : (
            <span className="text-danger">✗ 异常</span>
          )}
        </span>
        <button
          className="cursor-pointer rounded p-1 text-sub transition-colors hover:bg-muted hover:text-text"
          onClick={onClose}
          title="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 委派任务描述 */}
      <div className="shrink-0 border-b border-line/50 px-3 py-1.5 text-[10px] leading-relaxed text-sub/80">
        <span className="text-sub/60">委派任务：</span>
        {thread.prompt}
      </div>

      {/* 最终摘要（完成时；可折叠） */}
      {!running && thread.summary && (
        <div className="shrink-0 border-b border-line/50 px-3 py-2">
          <button
            className="flex w-full cursor-pointer items-center gap-1.5 text-left"
            onClick={() => setSummaryOpen(!summaryOpen)}
          >
            <span className="text-[10px] font-semibold text-accent">最终摘要</span>
            <span className="ml-auto text-sub">
              {summaryOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </span>
          </button>
          {summaryOpen && (
            <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed text-text/90">
              {thread.summary}
            </div>
          )}
        </div>
      )}

      {/* 消息流（与父 Agent 一致：思考/文本/工具过程，实时流式） */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {thread.messages.length === 0 && running && (
          <div className="flex items-center gap-2 py-6 text-[11px] text-sub">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            子智能体正在思考…
          </div>
        )}
        {thread.messages.map((m) => (
          <div key={m.id} className="mb-3">
            {m.reasoning && <ReasoningBlock text={m.reasoning} />}
            {m.text && (
              <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text/90">
                <Streamdown>{m.text}</Streamdown>
              </div>
            )}
            {m.tools.length > 0 && <Timeline tools={m.tools} />}
          </div>
        ))}
        {running && (
          <div className="flex items-center gap-1.5 text-[10px] text-sub/60">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            运行中…
          </div>
        )}
      </div>
    </div>
  );
}
