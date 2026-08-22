import { useMemo, useState } from "react";
import { Bell, Check, CircleAlert, CircleCheck, Clock3, X } from "lucide-react";
import { useStore } from "../store";

type Notice = { id: string; sessionId: string; title: string; body: string; tone: "info" | "success" | "danger" | "warn"; ts: number };

/** 从持久化事件账本聚合全局事项；完整上下文仍留在会话追踪中。 */
export default function NotificationCenter() {
  const traceBySession = useStore((s) => s.traceBySession);
  const sessions = useStore((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<string[]>([]);
  const notices = useMemo<Notice[]>(() => {
    const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? "会话";
    const out: Notice[] = [];
    for (const [sessionId, events] of Object.entries(traceBySession)) {
      for (const item of events.slice(-80)) {
        const e = item.event;
        if (e.type === "task-notification") out.push({ id: `${sessionId}:${item.seq}`, sessionId, title: e.status === "completed" ? "后台任务完成" : "后台任务结束", body: `${titleOf(sessionId)} · ${e.name}`, tone: e.status === "completed" ? "success" : "danger", ts: item.ts });
        else if (e.type === "approval-required") out.push({ id: `${sessionId}:${item.seq}`, sessionId, title: "等待审批", body: `${titleOf(sessionId)} · ${e.description}`, tone: "warn", ts: item.ts });
        else if (e.type === "ask-user") out.push({ id: `${sessionId}:${item.seq}`, sessionId, title: "等待你的输入", body: `${titleOf(sessionId)} · ${e.question}`, tone: "info", ts: item.ts });
        else if (e.type === "error") out.push({ id: `${sessionId}:${item.seq}`, sessionId, title: "任务失败", body: `${titleOf(sessionId)} · ${e.message}`, tone: "danger", ts: item.ts });
      }
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, 24);
  }, [sessions, traceBySession]);
  const unread = notices.filter((n) => !read.includes(n.id)).length;
  const openSession = (id: string) => {
    const st = useStore.getState();
    st.setActiveSessionId(id);
    setOpen(false);
  };
  return (
    <div className="notification-center fixed bottom-4 right-4 z-50">
      {open && (
        <div className="notification-popover mb-2 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-line bg-elevated shadow-lv3">
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-3"><Bell className="h-4 w-4 text-info" /><span className="flex-1 text-[13px] font-semibold text-text">通知中心</span><button className="icon-button" onClick={() => setOpen(false)} title="关闭"><X className="h-3.5 w-3.5" /></button></div>
          <div className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
            {notices.length === 0 && <div className="px-3 py-8 text-center text-xs text-sub">暂无新的事项</div>}
            {notices.map((n) => (
              <button key={n.id} className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-hover ${read.includes(n.id) ? "opacity-60" : ""}`} onClick={() => { setRead((v) => v.includes(n.id) ? v : [...v, n.id]); openSession(n.sessionId); }}>
                {n.tone === "success" ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : n.tone === "danger" ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : n.tone === "warn" ? <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-warn" /> : <Bell className="mt-0.5 h-4 w-4 shrink-0 text-info" />}
                <span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium text-text">{n.title}</span><span className="mt-0.5 block truncate text-[11px] text-sub">{n.body}</span></span>
                {!read.includes(n.id) && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-info" />}
              </button>
            ))}
          </div>
          {unread > 0 && <button className="flex w-full items-center justify-center gap-1 border-t border-line px-3 py-2 text-[11px] text-info hover:bg-info-soft" onClick={() => setRead(notices.map((n) => n.id))}><Check className="h-3.5 w-3.5" />全部标记已读</button>}
        </div>
      )}
      <button className="notification-trigger" onClick={() => setOpen((v) => !v)} title="通知中心"><Bell className="h-4 w-4" />{unread > 0 && <span className="notification-count">{unread > 9 ? "9+" : unread}</span>}</button>
    </div>
  );
}
