import { GitCompare, FileDiff, FlaskConical } from "lucide-react";
import { useStore } from "../store";

/** 右侧栏：Diff / 修改预览 / 测试结果 */
export default function DiffPanel() {
  const { diffContent, fileChanges, messages } = useStore();
  const lastTest = [...messages]
    .reverse()
    .flatMap((m) => m.tools)
    .find((t) => t.tool === "run_test");

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <GitCompare className="h-4 w-4 text-accent" />
        <span className="text-xs font-semibold">Diff / 测试结果</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* Diff 区 */}
        <div className="mb-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-sub">
            <FileDiff className="h-3.5 w-3.5" />
            代码改动（Git Diff）
          </div>
          {diffContent ? (
            <pre className="max-h-72 overflow-auto rounded-md border border-line bg-ink p-2 font-mono text-[10px] leading-relaxed text-text/90">
              {diffContent}
            </pre>
          ) : (
            <div className="rounded-md border border-dashed border-line/60 p-3 text-center text-[11px] text-sub/50">
              暂无 Diff
              <br />
              <span className="text-[10px]">Agent 调用 git_diff 后展示在这里</span>
            </div>
          )}
        </div>

        {/* 文件改动 */}
        <div className="mb-3">
          <div className="mb-1.5 text-[11px] font-semibold text-sub">文件改动记录</div>
          {fileChanges.length === 0 ? (
            <div className="text-[11px] text-sub/50">（无）</div>
          ) : (
            fileChanges.map((c, i) => (
              <div key={i} className="mb-1 rounded border border-line/50 bg-muted px-2 py-1 font-mono text-[10px] text-text/85">
                {c}
              </div>
            ))
          )}
        </div>

        {/* 测试结果 */}
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-sub">
            <FlaskConical className="h-3.5 w-3.5" />
            测试结果
          </div>
          {lastTest ? (
            <pre className="max-h-56 overflow-auto rounded-md border border-line bg-ink p-2 font-mono text-[10px] leading-relaxed text-text/90">
              {lastTest.summary}
            </pre>
          ) : (
            <div className="rounded-md border border-dashed border-line/60 p-3 text-center text-[11px] text-sub/50">
              暂无测试
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
