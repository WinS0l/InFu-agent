import { useMemo, useRef, useState } from "react";
import { X, FolderPlus, History, FolderSearch, Loader2 } from "lucide-react";
import { createProjectApi } from "../api";
import type { SessionMeta } from "@infu/shared";
import { useStore } from "../store";

interface CreateProjectModalProps {
  currentRoot: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

/**
 * 创建项目弹窗（v2.6.1）：注册本机文件夹为项目。
 * 浏览器安全限制拿不到所选文件夹的绝对路径（showDirectoryPicker/input 只给目录名），
 * 因此提供三级路径获取：① 「浏览文件夹」目录选择器（webkitdirectory）→ 服务端按目录名
 * 扫描常见位置解析候选；② 从历史会话 root 选择；③ 手动输入路径兜底。
 */
export default function CreateProjectModal({ currentRoot, onClose, onCreated }: CreateProjectModalProps) {
  const [root, setRoot] = useState(currentRoot);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [resolving, setResolving] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const sessions = useStore((s) => s.sessions);

  /** 历史会话 root 去重（未注册项目的候选） */
  const historyRoots = useMemo(() => {
    const seen = new Set<string>();
    const out: SessionMeta[] = [];
    for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const key = s.root.replace(/[\\/]+$/, "").toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(s);
      }
    }
    return out.slice(0, 12);
  }, [sessions]);

  /** 浏览文件夹：webkitdirectory 选择器（浏览器最多给目录名）→ 服务端解析候选路径 */
  const onBrowse = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const dirName = f.webkitRelativePath.split("/")[0] || f.name;
    setFolderName(dirName);
    setResolving(true);
    setErr("");
    try {
      const res = await fetch(`/api/projects/resolve?name=${encodeURIComponent(dirName)}`);
      const data = await res.json();
      setCandidates(data.candidates ?? []);
      if ((data.candidates ?? []).length === 1) setRoot(data.candidates[0]);
    } catch {
      setErr("解析文件夹路径失败");
    } finally {
      setResolving(false);
    }
  };

  const submit = async () => {
    if (!root.trim()) return setErr("请填写文件夹路径");
    setBusy(true);
    setErr("");
    try {
      await createProjectApi(root.trim(), name.trim() || undefined);
      await onCreated();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex w-[480px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
            <FolderPlus className="h-3.5 w-3.5" />
          </span>
          <div className="text-sm font-semibold text-text">创建项目</div>
          <button className="ml-auto cursor-pointer rounded p-1 text-sub/60 transition-colors hover:text-text" onClick={onClose} title="关闭（Esc）">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3.5">
          {/* 浏览文件夹（首选入口） */}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-sub/60">选择文件夹</div>
            <div className="flex items-center gap-2">
              <button
                className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-2 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
                onClick={() => fileRef.current?.click()}
              >
                <FolderSearch className="h-3.5 w-3.5" />
                浏览文件夹…
              </button>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                // 目录选择器：选中的是文件夹（webkitdirectory 方案）
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(e) => onBrowse(e.target.files)}
              />
            </div>
            {folderName && (
              <div className="mt-1 text-[9px] leading-relaxed text-sub/50">
                已选择文件夹「{folderName}」{resolving ? "（解析路径中…）" : candidates.length === 0 ? "（常见位置未找到同名目录，请手动填写路径）" : ""}
              </div>
            )}
            {candidates.length > 1 && (
              <div className="mt-1.5 space-y-1">
                <div className="text-[9px] text-sub/50">找到 {candidates.length} 个同名目录，请选择：</div>
                {candidates.map((c) => (
                  <button
                    key={c}
                    className={`flex w-full cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-colors ${
                      root === c ? "border-accent/60 bg-accent/10" : "border-line bg-muted/40 hover:border-accent/40"
                    }`}
                    onClick={() => setRoot(c)}
                    title={c}
                  >
                    <FolderPlus className="h-3 w-3 shrink-0 text-sub/50" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text/80">{c}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 路径（浏览解析结果 / 手动兜底） */}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-sub/60">文件夹路径</div>
            <input
              className="h-9 w-full rounded-md border border-line bg-muted px-2.5 font-mono text-[11px] text-text placeholder:text-sub/50 focus:border-accent/60 focus:outline-none"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="C:\path\to\your\project"
              spellCheck={false}
            />
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-sub/60">项目名称（可选）</div>
            <input
              className="h-9 w-full rounded-md border border-line bg-muted px-2.5 text-[11px] text-text placeholder:text-sub/50 focus:border-accent/60 focus:outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="缺省用文件夹名"
              spellCheck={false}
            />
          </div>

          {historyRoots.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-sub/60">
                <History className="h-3 w-3" />
                从历史会话选择
              </div>
              <div className="max-h-36 space-y-1 overflow-y-auto">
                {historyRoots.map((s) => (
                  <button
                    key={s.id}
                    className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-line bg-muted/40 px-2 py-1 text-left transition-colors hover:border-accent/40"
                    onClick={() => setRoot(s.root)}
                    title={s.root}
                  >
                    <FolderPlus className="h-3 w-3 shrink-0 text-sub/50" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text/80">{s.root}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {err && <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">{err}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
          <button
            className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-[11px] text-sub transition-colors hover:border-accent/40 hover:text-text"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-accent/50 bg-accent/10 px-3 py-1.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={submit}
            disabled={busy}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {busy ? "创建中…" : "创建项目"}
          </button>
        </div>
      </div>
    </div>
  );
}
