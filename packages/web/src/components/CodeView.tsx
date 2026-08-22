import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, Loader2, Search, ExternalLink, Code2 } from "lucide-react";
// `highlight.js` 的完整构建会把所有语言定义一起打进懒加载的代码浏览器，
// 单个页面就接近 1 MB。common 构建覆盖这里映射的大多数常见语言；未注册语言
// 会由 langOf 安全回退为纯文本。
import hljs from "highlight.js/lib/common";
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
  // v3.3 补 19/20/21：审查/代码界面目录 = 工作树模式**开启时**才用 worktree.path
    // （Agent 改动在 .infu/worktrees/<name>，主项目根 git diff 为空 → 界面全空）；
    // 注意 worktree 状态是 persist 的（刷新不消失）——残留的旧路径（已合并/丢弃被删、
    // 旧格式 .infu-worktrees/、或任务创建失败回退）必须忽略，否则界面查无效目录变空。
    // 补 21：worktree 路径请求失败（root 无效）→ 回退项目根重试（用户实测根因）
    const rawRoot = useStore((s) => s.sessions.find((item) => item.id === s.activeSessionId)?.root || s.root);
    const useWorktree = useStore((s) => s.useWorktree);
    const worktree = useStore((s) => s.worktree);
    // 不让另一会话遗留的工作树覆盖当前会话的项目代码视图。
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    const root = useWorktree && worktree && norm(worktree.path).startsWith(`${norm(rawRoot)}\\.infu\\worktrees\\`)
      ? worktree.path
      : rawRoot;
  const codeViewFile = useStore((s) => s.codeViewFile);
  const [files, setFiles] = useState<FsTreeFile[] | null>(null);
  // v3.3 补 22：文件树实际加载成功的 root——worktree 残留路径失败回退项目根后，
  // 点击文件/工具行定位必须用回退后的 root（否则内容请求仍打无效路径 → 空）
  const [effRoot, setEffRoot] = useState(rawRoot);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<{ content: string; binary?: boolean; size?: number; truncated?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // v3.6：文件加载竞态守卫序号（快速连点文件时旧响应作废）
  const fileSeqRef = useRef(0);

  useEffect(() => {
    setFiles(null);
    setSel(null);
    setContent(null);
    if (!root) return;
    // v3.6：加载失败提示（原未处理 rejection——文件树失败静默）
    // v3.3 补 21：worktree 残留路径无效（root 400）→ 回退项目根重试
    const load = (r: string) =>
      fetchFsTree(r).then((f) => {
        setEffRoot(r); // 树从哪个 root 加载成功，内容就从这个 root 读
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
      });
    load(root).catch(() => {
      const fail = (e: unknown) => {
        setFiles([]);
        setContent({ content: `文件树加载失败：${(e as Error).message}` });
      };
      if (root !== rawRoot) {
        load(rawRoot).catch(fail);
      } else {
        fail(new Error("root 无效"));
      }
    });
  }, [root, rawRoot]);

  // v3.3 补 22：root（工作树/项目）变化时重置生效 root——避免旧值残留串到新会话
  useEffect(() => {
    setEffRoot(root);
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
      const d = await fetchFsFile(effRoot, path);
      if (req !== fileSeqRef.current) return; // 过期响应丢弃
      setContent(d);
    } catch (e) {
      if (req === fileSeqRef.current) setContent({ content: `加载失败：${(e as Error).message}` });
    } finally {
      if (req === fileSeqRef.current) setLoading(false);
    }
  };
  const openFile = async (editor: boolean) => {
    if (!root || !window.infuDesktop) return;
    const message = await window.infuDesktop.openProjectFile({ root: effRoot, path: sel ?? "", editor });
    setOpenError(message);
    setOpenMenu(false);
  };
  useEffect(() => {
    if (!openMenu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openMenu]);

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
               {openError && <div className="border-b border-warn/30 bg-warn-soft px-4 py-1.5 text-[11px] text-warn">{openError}</div>}
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
      {root && window.infuDesktop && <div ref={menuRef} className="fixed right-[140px] top-0 z-50 flex h-10 items-center bg-sidebar pr-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <button className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] text-sub transition-colors hover:bg-hover hover:text-text" onClick={() => void openFile(false)} title={sel ? "在资源管理器中显示此文件" : "在资源管理器中打开当前项目"}><ExternalLink className="h-3.5 w-3.5" />资源管理器</button>
        <button className="flex h-8 w-6 cursor-pointer items-center justify-center rounded-lg text-sub transition-colors hover:bg-hover hover:text-text" onClick={() => setOpenMenu((value) => !value)} title="选择打开方式"><ChevronRight className={`h-3.5 w-3.5 rotate-90 transition-transform ${openMenu ? "rotate-[270deg]" : ""}`} /></button>
        {openMenu && <div className="absolute right-2 top-10 z-50 min-w-[152px] rounded-xl border border-line bg-elevated p-1 shadow-lv3">
          <button className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-text hover:bg-hover" onClick={() => void openFile(false)}><ExternalLink className="h-3.5 w-3.5 text-sub" />资源管理器</button>
          <button className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-text hover:bg-hover" onClick={() => void openFile(true)}><Code2 className="h-3.5 w-3.5 text-info" />VS Code</button>
        </div>}
      </div>}
    </div>
  );
}
