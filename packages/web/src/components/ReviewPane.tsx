import { useEffect, useRef, useState } from "react";
import { FileDiff, FlaskConical, GitCompare, Loader2, ArrowLeft } from "lucide-react";
import { useStore } from "../store";
import { fetchReviewFiles, fetchReviewFileDiff, type ReviewFileInfo } from "../api";
import { CodeBlock } from "./ui";

/**
 * v2.9 审查（审查式）：项目所有改动文件列表（+N 绿 / -M 红）→
 * 点击文件名查看该文件 diff——新增行绿色填充、删除行红色填充、@@ 块高亮。
 * 未跟踪（新）文件 = 全新增；非 git 仓库显示提示。
 */

/** unified diff → 行级类型（行级着色渲染用） */
type DiffLine = { type: "hunk" | "add" | "del" | "ctx" | "meta"; text: string };
function parseDiff(text: string): DiffLine[] {
  return text.split("\n").map((l) => {
    if (l.startsWith("@@")) return { type: "hunk", text: l };
    if (l.startsWith("+++") || l.startsWith("---")) return { type: "meta", text: l };
    if (l.startsWith("+")) return { type: "add", text: l.slice(1) };
    if (l.startsWith("-")) return { type: "del", text: l.slice(1) };
    return { type: "ctx", text: l };
  });
}

/** 行级 diff 视图（+ 绿底 / - 红底 / @@ 高亮 / 上下文默认） */
function DiffView({ diff }: { diff: string }) {
  const lines = parseDiff(diff);
  if (!lines.length || (lines.length === 1 && !lines[0].text)) {
    return <div className="py-2 text-[13px] text-caption">该文件无改动</div>;
  }
  return (
    <div className="rounded-xl border border-line bg-code">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`flex gap-2 whitespace-pre-wrap break-all px-2.5 py-px font-mono text-[12px] leading-[18px] ${
            l.type === "add"
              ? "bg-[rgba(34,197,94,0.14)] text-text"
              : l.type === "del"
                ? "bg-[rgba(239,68,68,0.13)] text-text/90"
                : l.type === "hunk"
                  ? "bg-hover/70 text-caption"
                  : l.type === "meta"
                    ? "text-caption"
                    : "text-text/75"
          }`}
        >
          <span className={`w-4 shrink-0 select-none text-center ${l.type === "add" ? "text-success" : l.type === "del" ? "text-danger" : "text-transparent"}`}>
            {l.type === "add" ? "+" : l.type === "del" ? "-" : " "}
          </span>
          <span className="min-w-0 flex-1">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

export default function ReviewPane() {
  const root = useStore((s) => s.root);
  const { messages } = useStore();
  const lastTest = [...messages]
    .reverse()
    .flatMap((m) => m.tools)
    .find((t) => t.tool === "run_test");

  // v2.9：审查文件列表 + 选中文件 diff（审查式）
  const [files, setFiles] = useState<ReviewFileInfo[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(false);
  // v3.4 审计修复：diff 请求竞态守卫——快速连续点两个文件（或期间 root 变化）时，
  // 旧请求的响应晚到会覆盖新选中文件的 diff；序号守卫让过期响应丢弃
  const diffSeq = useRef(0);
  useEffect(() => {
    diffSeq.current++; // root 变化 → 作废在途请求
    setFiles(null);
    setSel(null);
    setDiff("");
    if (!root) return;
    // v2.9：初始只加载文件列表（不自动选中任何文件——点击文件后才显示其更改）
    // v3.0 审计：失败不再永久卡「加载中」——降级为空列表 + 错误提示
    fetchReviewFiles(root)
      .then((f) => setFiles(f))
      .catch(() => {
        setFiles([]);
        useStore.getState().addError("审查文件列表加载失败（服务未就绪或目录不可读）");
      });
  }, [root]);

  const pickFile = async (path: string) => {
    const seq = ++diffSeq.current;
    setSel(path);
    setLoading(true);
    setDiff("");
    try {
      const d = await fetchReviewFileDiff(root, path);
      if (seq === diffSeq.current) setDiff(d);
    } catch (e) {
      if (seq === diffSeq.current) setDiff(`加载 diff 失败：${(e as Error).message}`);
    } finally {
      if (seq === diffSeq.current) setLoading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 宏观 ↔ 微观：sel 非空时整个 tab 切换为该文件的 diff 视图（返回按钮回列表） */}
      {sel !== null ? (
        <>
          {/* diff 视图头部：返回列表 + 文件名 + 增删统计 */}
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <button
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sub transition-colors hover:bg-hover hover:text-text"
              onClick={() => setSel(null)}
              title="返回文件列表"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text/90">{sel}</span>
            {(() => {
              const f = files?.find((x) => x.path === sel);
              if (!f) return null;
              return (
                <span className="shrink-0 font-mono text-[11px]">
                  {f.added > 0 && <span className="text-success">+{f.added}</span>}
                  {f.removed > 0 && <span className="ml-1 text-danger">-{f.removed}</span>}
                </span>
              );
            })()}
          </div>
          {/* 该文件行级 diff（新增绿填充 / 删除红填充），全屏滚动 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {loading ? (
              <div className="flex items-center gap-2 py-2 text-[13px] text-caption">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-ongoing" />
                加载 diff…
              </div>
            ) : (
              <DiffView diff={diff} />
            )}
          </div>
        </>
      ) : (
        <>
          {/* 宏观视图：整个 tab 只显示文件列表（点击文件 → 切入该文件 diff 视图） */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium leading-[18px] text-sub">
              <GitCompare className="h-3.5 w-3.5" />
              改动文件（{files?.length ?? 0}）
            </div>
            {files === null ? (
              /* v3.0 UI 审查：root 为空（会话未关联工作目录）时显示空态，
                 而非永久「加载中」——自由会话不展示无关目录的改动 */
              !root ? (
                <div className="py-1 text-[13px] leading-5 text-caption">
                  该会话未关联工作目录，审查不可用。
                  <br />
                  请选择项目或配置默认工作目录。
                </div>
              ) : (
                <div className="flex items-center gap-2 py-1 text-[13px] text-caption">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-ongoing" />
                  加载中…
                </div>
              )
            ) : files.length === 0 ? (
              <div className="py-1 text-[13px] text-caption">
                暂无改动{root && !files.length && "（非 git 仓库或工作区干净）"}
              </div>
            ) : (
              <div className="space-y-0.5">
                {files.map((f) => (
                  <button
                    key={f.path}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-hover/60"
                    onClick={() => pickFile(f.path)}
                    title={f.path}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text/80">{f.path}</span>
                    {f.added > 0 && <span className="shrink-0 font-mono text-[11px] text-success">+{f.added}</span>}
                    {f.removed > 0 && <span className="shrink-0 font-mono text-[11px] text-danger">-{f.removed}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 测试结果（列表视图底部保留） */}
          <div className="shrink-0 border-t border-line px-4 py-2">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium leading-[18px] text-sub">
              <FlaskConical className="h-3.5 w-3.5" />
              测试结果
            </div>
            {lastTest ? (
              <CodeBlock
                label={lastTest.status === "running" ? "运行中…" : lastTest.status === "error" ? "失败" : "通过"}
                text={lastTest.summary ?? (lastTest.status === "running" ? "测试执行中…" : "")}
                maxHeight={160}
              />
            ) : (
              <div className="py-1 text-[13px] leading-5 text-caption">暂无测试</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
