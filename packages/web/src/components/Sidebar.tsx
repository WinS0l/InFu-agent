import { useStore } from "../store";

/** 左侧栏：项目与任务信息（M2 简化版） */
export default function Sidebar() {
  const { messages, fileChanges, diffContent, reset } = useStore();
  const toolCount = messages.reduce((n, m) => n + m.tools.length, 0);
  const steps = messages.reduce((n, m) => n + (m.role === "assistant" && m.text ? 1 : 0), 0);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
      {/* 任务概览 */}
      <div className="border-b border-line p-3">
        <div className="mb-2 text-xs font-semibold text-sub">任务概览</div>
        <div className="grid grid-cols-3 gap-1 text-center">
          <div className="rounded-md bg-muted py-1.5">
            <div className="text-sm font-semibold text-text">{steps}</div>
            <div className="text-[10px] text-sub">轮次</div>
          </div>
          <div className="rounded-md bg-muted py-1.5">
            <div className="text-sm font-semibold text-accent">{toolCount}</div>
            <div className="text-[10px] text-sub">工具</div>
          </div>
          <div className="rounded-md bg-muted py-1.5">
            <div className="text-sm font-semibold text-warn">{fileChanges.length}</div>
            <div className="text-[10px] text-sub">改动</div>
          </div>
        </div>
      </div>

      {/* 文件改动列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-2 text-xs font-semibold text-sub">文件改动</div>
        {fileChanges.length === 0 && (
          <div className="text-[11px] leading-relaxed text-sub/60">
            暂无文件改动。
            <br />
            可尝试任务：
            <br />• 分析这个项目的结构
            <br />• 修复 README 的拼写错误
          </div>
        )}
        {fileChanges.map((c, i) => (
          <div
            key={i}
            className="mb-1.5 cursor-default rounded-md border border-line bg-muted px-2 py-1.5 text-[11px] leading-snug text-text/90 transition-colors hover:border-accent/50"
          >
            {c}
          </div>
        ))}
        {diffContent && (
          <div className="mt-2 text-[11px] text-sub">（右侧面板有 Diff 详情）</div>
        )}
      </div>

      {/* 操作区 */}
      <div className="border-t border-line p-3">
        <button
          className="w-full cursor-pointer rounded-md border border-line bg-muted px-2 py-1.5 text-xs text-text transition-colors duration-150 hover:border-danger/60 hover:text-danger"
          onClick={reset}
        >
          清空对话
        </button>
      </div>
    </aside>
  );
}
