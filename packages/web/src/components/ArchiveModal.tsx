import { useEffect, useState } from "react";
import { ArchiveRestore, Trash2, Archive } from "lucide-react";
import type { SessionMeta } from "@infu/shared";
import { Modal, CapsuleButton } from "./ui";
import { apiFetch } from "../api";

interface ArchiveModalProps {
  onClose: () => void;
  onRestored: (id: string) => Promise<void>;
  onDeleted: (id: string) => Promise<void>;
}

/** 归档回收站（Archive，主流命名，v3 统一 Modal 原语）：归档会话列表 — 恢复 / 删除 */
export default function ArchiveModal({ onClose, onRestored, onDeleted }: ArchiveModalProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    apiFetch(`/api/sessions?archived=1&limit=200`)
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
    <Modal
      onClose={onClose}
      width={640}
      height="min(720px, 90vh)"
      title="Archive（归档）"
      subtitle="已归档的会话：可恢复或永久删除"
      icon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-hover text-sub">
          <Archive className="h-4 w-4" />
        </span>
      }
    >
      {sessions.length === 0 && (
        <div className="px-3 py-4 text-center text-[13px] leading-6 text-sub/60">
          归档为空。
          <br />
          会话行上的「归档」按钮会把会话移到这里。
        </div>
      )}
      <div className="space-y-1">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`flex items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-2 transition-opacity ${busyId === s.id ? "opacity-60" : ""}`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium leading-5 text-text/90">{s.title}</div>
              <div className="truncate text-xs leading-[18px] text-caption" title={s.root}>
                {fmt(s.updatedAt)} · {s.root}
              </div>
            </div>
            <CapsuleButton size="sm" variant="outline" onClick={() => act(s.id, onRestored)} disabled={busyId !== null} title="恢复（移出归档）">
              <ArchiveRestore className="h-3.5 w-3.5" />
              恢复
            </CapsuleButton>
            <CapsuleButton size="sm" variant="danger" onClick={() => act(s.id, onDeleted)} disabled={busyId !== null} title="永久删除（事件流一并删除）">
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </CapsuleButton>
          </div>
        ))}
      </div>
      {err && <div className="mt-2 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{err}</div>}
    </Modal>
  );
}
