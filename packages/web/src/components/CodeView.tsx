import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, Loader2, Search } from "lucide-react";
import hljs from "highlight.js";
import { useStore } from "../store";
import { fetchFsTree, fetchFsFile, type FsTreeFile } from "../api";

/**
 * v2.9 代码界面（项目代码浏览器，替代原 Diff 覆盖层——与右侧栏审查 tab 分工：
 * 审查 = 看改动 diff；代码界面 = 浏览整个项目代码 + 查看文件完整内容）。
 * 左侧文件树（顶层目录折叠组 + 改动标记：+N 绿 / -M 红 / 未跟踪「新」），
 * 点击文件在右侧查看内容（highlight.js 语法高亮，VSCode 式 token 色随双主题）。
 */

/** 扩展名 → highlight.js 语言（common 集合内常用语言；未知回退纯文本） */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", css: "css", scss: "scss", less: "css", html: "xml", xml: "xml",
  py: "python", sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  sql: "sql", vue: "xml", svelte: "xml", svg: "xml", bat: "dos", ps1: "powershell",
  txt: "plaintext", log: "plaintext", gitignore: "plaintext", md5: "plaintext",
};

/** 按路径取高亮语言（hljs 已注册才用，否则纯文本） */
function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = LANG_BY_EXT[ext] ?? "";
  return lang && hljs.getLanguage(lang) ? lang : "plaintext";
}

/** 内容 → 高亮 HTML（hljs；纯文本语言直接转义） */
function highlight(code: string, path: string): string {
  try {
    return hljs.highlight(code, { language: langOf(path) }).value;
  } catch {
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 改动标记（+N 绿 / -M 红 / 未跟踪 新） */
function ChangeBadge({ f }: { f: FsTreeFile }) {
  if (f.untracked) return <span className="shrink-0 font-mono text-[10px] text-info">新</span>;
  return (
    <span className="shrink-0 font-mono text-[10px]">
      {f.added > 0 && <span className="text-success">+{f.added}</span>}
      {f.removed > 0 && <span className="ml-0.5 text-danger">-{f.removed}</span>}
    </span>
  );
}

export default function CodeView() {
  // v3.3 补 19：审查/代码界面目录 = 工作树优先（worktree 模式下 Agent 改动在
    // .infu/worktrees/<name> 独立工作树里，主项目根 git diff 为空 → 界面全空；
    // 未开工作树 = 项目根）
    const root = useStore((s) => s.worktree?.path ?? s.root);
  const codeViewFile = useStore((s) => s.codeViewFile);
  const [files, setFiles] = useState<FsTreeFile[] | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<{ content: string; binary?: boolean; size?: number; truncated?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  // v3.6：文件加载竞态守卫序号（快速连点文件时旧响应作废）
  const fileSeqRef = useRef(0);

  useEffect(() => {
    setFiles(null);
    setSel(null);
    setContent(null);
    if (!root) return;
    // v3.6：加载失败提示（原未处理 rejection——文件树失败静默）
    fetchFsTree(root).then((f) => {
      setFiles(f);
      // 默认展开含改动文件的顶层目录（其余折叠）
      const changed = new Set<string>();
      for (const x of f) {
        if (x.untracked || x.added > 0 || x.removed > 0) {
          const idx = x.path.indexOf("/");
          if (idx > 0) changed.add(x.path.slice(0, idx));
        }
      }
      setCollapsed(Object.fromEntries([...changed].map((k) => [k, false])));
    }).catch((e) => {
      setFiles([]);
      setContent({ content: `文件树加载失败：${(e as Error).message}` });
    });
  }, [root]);

  // v2.14：工具行文件链接外部定位——展开路径目录 + 选中文件 + 加载内容（消费后清空）
  useEffect(() => {
    if (!codeViewFile || !files) return;
    const parts = codeViewFile.split("/");
    const dirs: string[] = [];
    for (let i = 0; i < parts.length - 1; i++) {
      dirs.push(parts.slice(0, i + 1).join("/"));
    }
    setCollapsed((c) => {
      const next = { ...c };
      for (const d of dirs) next[d] = false; // 展开路径上所有目录
      return next;
    });
    if (files.some((f) => f.path === codeViewFile)) {
      void pickFile(codeViewFile);
    }
    useStore.getState().setCodeViewFile(null); // 消费
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeViewFile, files]);

  // 顶层分组：目录组 + 根文件
  const { groups, roots } = useMemo(() => {
    const g = new Map<string, FsTreeFile[]>();
    const r: FsTreeFile[] = [];
    for (const f of files ?? []) {
      const idx = f.path.indexOf("/");
      if (idx < 0) r.push(f);
      else {
        const key = f.path.slice(0, idx);
        g.set(key, [...(g.get(key) ?? []), f]);
      }
    }
    return { groups: [...g.entries()].sort((a, b) => a[0].localeCompare(b[0])), roots: r };
  }, [files]);

  const pickFile = async (path: string) => {
    setSel(path);
    setLoading(true);
    // v3.6 审计修复：竞态守卫 + 失败提示——快速连点文件时旧响应不得覆盖新选中
    // （对齐 ReviewPane 的 diffSeq 守卫）；加载失败不再卡死「加载中…」
    const req = ++fileSeqRef.current;
    try {
      const d = await fetchFsFile(root, path);
      if (req !== fileSeqRef.current) return; // 过期响应丢弃
      setContent(d);
    } catch (e) {
      if (req === fileSeqRef.current) setContent({ content: `加载失败：${(e as Error).message}` });
    } finally {
      if (req === fileSeqRef.current) setLoading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-base">
      {/* 头部：标题 + 路径 */}
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
        <Search className="h-4 w-4 text-info" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-text">项目代码</span>
        <span className="shrink-0 text-xs text-caption">{files?.length ?? 0} 个文件</span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左侧文件树 */}
        <div className="no-scrollbar w-[210px] shrink-0 overflow-y-auto border-r border-line px-2 py-2">
          {!root ? (
            /* v3.0 UI 审查：未关联工作目录的空态（此前 root 为空永久「加载中」） */
            <div className="py-2 text-[13px] leading-5 text-caption">
              该会话未关联工作目录，无法查看代码。
              <br />
              请选择项目或配置默认工作目录。
            </div>
          ) : files === null ? (
            <div className="flex items-center gap-2 py-2 text-[13px] text-caption">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-ongoing" />
              加载中…
            </div>
          ) : files.length === 0 ? (
            <div className="py-2 text-[13px] text-caption">（空项目或无法读取）</div>
          ) : (
            <>
              {/* 根文件 */}
              {roots.map((f) => (
                <button
                  key={f.path}
                  className={`flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors ${
                    sel === f.path ? "bg-hover text-text" : "text-text/80 hover:bg-hover/60"
                  }`}
                  onClick={() => pickFile(f.path)}
                  title={f.path}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-sub" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{f.path}</span>
                  <ChangeBadge f={f} />
                </button>
              ))}
              {/* 顶层目录组（可折叠） */}
              {groups.map(([dir, list]) => {
                const open = !collapsed[dir];
                const dirChanged = list.some((x) => x.untracked || x.added > 0 || x.removed > 0);
                return (
                  <div key={dir}>
                    <button
                      className="flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-hover/60"
                      onClick={() => setCollapsed((p) => ({ ...p, [dir]: open }))}
                    >
                      <ChevronRight
                        className={`h-3 w-3 shrink-0 text-sub transition-transform ${open ? "rotate-90" : ""}`}
                      />
                      {open ? (
                        <FolderOpen className={`h-3.5 w-3.5 shrink-0 ${dirChanged ? "text-warn" : "text-sub"}`} />
                      ) : (
                        <Folder className={`h-3.5 w-3.5 shrink-0 ${dirChanged ? "text-warn" : "text-sub"}`} />
                      )}
                      <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${dirChanged ? "font-medium text-text" : "text-text/70"}`}>
                        {dir}/
                      </span>
                      {dirChanged && <span className="shrink-0 text-[10px] text-warn">改</span>}
                    </button>
                    {open && (
                      <div className="ml-3 space-y-px border-l border-line pl-1">
                        {list.map((f) => (
                          <button
                            key={f.path}
                            className={`flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-left transition-colors ${
                              sel === f.path ? "bg-hover text-text" : "text-text/75 hover:bg-hover/60"
                            }`}
                            onClick={() => pickFile(f.path)}
                            title={f.path}
                          >
                            <FileText className="h-3 w-3 shrink-0 text-sub" />
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{f.path.slice(dir.length + 1)}</span>
                            <ChangeBadge f={f} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* 右侧内容预览 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {sel === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Search className="h-8 w-8 text-sub" />
              <div className="text-[13px] text-sub">从左侧选择一个文件查看内容</div>
              <div className="text-xs text-caption">改动文件已标记：+N 绿 / -M 红 / 新文件「新」</div>
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-caption">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-ongoing" />
              加载中…
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text/90">{sel}</span>
                {content?.binary ? (
                  <span className="shrink-0 text-xs text-warn">二进制文件</span>
                ) : (
                  <span className="shrink-0 text-xs text-caption">
                    {content?.size != null ? fmtSize(content.size) : ""}
                    {content?.truncated ? "（已截断）" : ""}
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {content?.binary ? (
                  <div className="px-4 py-3 text-[13px] text-caption">二进制文件无法预览</div>
                ) : (
                  <pre className="codeview-hl min-w-full px-4 py-3 font-mono text-[12px] leading-[18px] text-text/85">
                    <code dangerouslySetInnerHTML={{ __html: highlight(content?.content ?? "", sel) }} />
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
