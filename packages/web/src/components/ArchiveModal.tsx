import { useEffect, useState } from "react";
import { X, ArchiveRestore, Trash2, Archive } from "lucide-react";
import type { SessionMeta } from "@infu/shared";

interface ArchiveModalProps {
  onClose: () => void;
  onRestored: (id: string) => Promise<void>;
  onDeleted: (id: string) => Promise<void>;
}

/** 归档回收站（Archive，主流命名）：归档会话列表 — 恢复 / 删除 */
export default function ArchiveModal({ onClose, onRestored, onDeleted }: ArchiveModalProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`/api/sessions?archived=1&limit=200`)
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions ?? []))
      .catch(() => setErr("加载归档会话失败"));
  }, []);

  const act = async (id: string, fn: (id: string) => Promise<void>) => {
    setBusyId(id);
    setErr("");
    try {
      await fn(id);
      setSessions((list) => list.filter((s) => s.id !== id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const fmt = (ts: number) => new Date(ts).toLocaleString();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[80vh] w-[520px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted text-sub">
            <Archive className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text">Archive（归档）</div>
            <div className="text-[10px] text-sub/50">已归档的会话：可恢复或永久删除</div>
          </div>
          <button className="cursor-pointer rounded p-1 text-sub/60 transition-colors hover:text-text" onClick={onClose} title="关闭（Esc）">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {sessions.length === 0 && (
            <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[11px] text-sub/50">
              归档为空。
              <br />
              会话行上的「归档」按钮会把会话移到这里。
            </div>
          )}
          <div className="space-y-1">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`flex items-center gap-2 rounded-md border border-line bg-muted/40 px-2.5 py-1.5 ${busyId === s.id ? "opacity-60" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-medium text-text/90">{s.title}</div>
                  <div className="truncate text-[9px] text-sub/50" title={s.root}>
                    {fmt(s.updatedAt)} · {s.root}
                  </div>
                </div>
                <button
                  className="flex cursor-pointer items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-sub/70 transition-colors hover:border-accent/40 hover:text-accent"
                  onClick={() => act(s.id, onRestored)}
                  disabled={busyId !== null}
                  title="恢复（移出归档）"
                >
                  <ArchiveRestore className="h-3 w-3" />
                  恢复
                </button>
                <button
                  className="flex cursor-pointer items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-sub/70 transition-colors hover:border-danger/40 hover:text-danger"
                  onClick={() => act(s.id, onDeleted)}
                  disabled={busyId !== null}
                  title="永久删除（事件流一并删除）"
                >
                  <Trash2 className="h-3 w-3" />
                  删除
                </button>
              </div>
            ))}
          </div>
          {err && <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">{err}</div>}
        </div>
      </div>
    </div>
  );
}
