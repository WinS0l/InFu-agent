import { useMemo, useRef, useState } from "react";
import { FolderPlus, History, FolderSearch, Loader2 } from "lucide-react";
import { createProjectApi, apiFetch } from "../api";
import type { SessionMeta } from "@infu/shared";
import { useStore } from "../store";
import { Modal, CapsuleButton } from "./ui";

interface CreateProjectModalProps {
  currentRoot: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

/**
 * 创建项目弹窗（v2.6.1，v3 统一 Modal 原语）：注册本机文件夹为项目。
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

  /** v3.0 批 12：浏览文件夹——桌面版 = Electron 原生系统对话框（openDirectory）
   *  直接拿完整绝对路径（不遍历文件、不上传）；Web 版回退 webkitdirectory → 服务端解析候选 */
  const onBrowse = async () => {
    const d = window.infuDesktop;
    if (d) {
      const paths = await d.selectPaths({ directories: true });
      if (paths.length) {
        const dir = paths[0];
        setRoot(dir);
        setFolderName(dir.split(/[\/]/).filter(Boolean).pop() ?? dir);
        setCandidates([]);
      }
      return;
    }
    fileRef.current?.click();
  };

  /** Web 兜底：webkitdirectory → 服务端解析候选路径 */
  const onBrowseWeb = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const dirName = f.webkitRelativePath.split("/")[0] || f.name;
    setFolderName(dirName);
    setResolving(true);
    setErr("");
    try {
      const res = await apiFetch(`/api/projects/resolve?name=${encodeURIComponent(dirName)}`);
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
    <Modal
      onClose={onClose}
      width={480}
      title="创建项目"
      subtitle="注册本机文件夹为项目（会话将按 root 归属）"
      icon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-info-soft">
          <FolderPlus className="h-4 w-4 text-info" />
        </span>
      }
      footer={
        <>
          <CapsuleButton variant="outline" size="md" onClick={onClose}>取消</CapsuleButton>
          <CapsuleButton variant="primary" size="md" onClick={submit} disabled={busy}>
            <FolderPlus className="h-3.5 w-3.5" />
            {busy ? "创建中…" : "创建项目"}
          </CapsuleButton>
        </>
      }
    >
      <div className="space-y-3">
        {/* 浏览文件夹（首选入口） */}
        <div>
          <div className="mb-1 text-xs font-semibold text-sub">选择文件夹</div>
          <div className="flex items-center gap-2">
            <button
              className="flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line bg-hover px-2 text-[13px] font-medium text-text transition-colors hover:border-info/60 hover:text-info"
              onClick={() => void onBrowse()}
            >
              <FolderSearch className="h-4 w-4" />
              选择文件夹…
            </button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              // Web 兜底：目录选择器（webkitdirectory 方案）
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => void onBrowseWeb(e.target.files)}
            />
          </div>
          {folderName && (
            <div className="mt-1 flex items-center gap-1.5 text-xs leading-5 text-sub/70">
              {resolving && <Loader2 className="h-3 w-3 animate-spin text-ongoing" />}
              已选择文件夹「{folderName}」
              {resolving ? "（解析路径中…）" : candidates.length === 0 ? "（常见位置未找到同名目录，请手动填写路径）" : ""}
            </div>
          )}
          {candidates.length > 1 && (
            <div className="mt-1.5 space-y-1">
              <div className="text-xs text-sub/70">找到 {candidates.length} 个同名目录，请选择：</div>
              {candidates.map((c) => (
                <button
                  key={c}
                  className={`flex w-full cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                    root === c ? "border-info/60 bg-info-soft" : "border-line bg-elevated hover:border-info/40"
                  }`}
                  onClick={() => setRoot(c)}
                  title={c}
                >
                  <FolderPlus className="h-3.5 w-3.5 shrink-0 text-sub/60" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text/85">{c}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 路径（浏览解析结果 / 手动兜底） */}
        <div>
          <div className="mb-1 text-xs font-semibold text-sub">文件夹路径</div>
          <input
            className="h-9 w-full rounded-lg border border-line bg-input px-2.5 font-mono text-xs text-text placeholder:text-caption focus:border-info/60 focus:outline-none"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="C:\path\to\your\project"
            spellCheck={false}
          />
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold text-sub">项目名称（可选）</div>
          <input
            className="h-9 w-full rounded-lg border border-line bg-input px-2.5 text-xs text-text placeholder:text-caption focus:border-info/60 focus:outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="缺省用文件夹名"
            spellCheck={false}
          />
        </div>

        {historyRoots.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-sub">
              <History className="h-3.5 w-3.5" />
              从历史会话选择
            </div>
            <div className="max-h-36 space-y-1 overflow-y-auto">
              {historyRoots.map((s) => (
                <button
                  key={s.id}
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-left transition-colors hover:border-info/40"
                  onClick={() => setRoot(s.root)}
                  title={s.root}
                >
                  <FolderPlus className="h-3.5 w-3.5 shrink-0 text-sub/60" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text/85">{s.root}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {err && <div className="rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{err}</div>}
      </div>
    </Modal>
  );
}
