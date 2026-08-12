import { useState } from "react";
import { Plus, Trash2, RotateCcw } from "lucide-react";
import type { SessionMeta } from "@infu/shared";
import { useStore } from "../store";
import { fetchSessions, fetchSessionEvents, deleteSession } from "../api";

/** 状态徽标（会话列表） */
const STATUS_BADGE: Record<SessionMeta["status"], { label: string; cls: string }> = {
  done: { label: "✓ 完成", cls: "text-accent" },
  running: { label: "运行中", cls: "text-accent animate-pulse" },
  error: { label: "✗ 出错", cls: "text-danger" },
  stopped: { label: "⏸ 已停", cls: "text-warn" },
};

/** 时间格式化：MM-DD HH:mm */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 左侧栏：会话列表（v2.1 多会话）+ 任务概览 + 文件改动 */
export default function Sidebar() {
  const {
    messages, fileChanges, diffContent,
    sessions, activeSessionId, setActiveSessionId, newSession, loadSession, running,
    clearPendingRollback,
  } = useStore();
  const [busyId, setBusyId] = useState<string | null>(null);
  const toolCount = messages.reduce((n, m) => n + m.tools.length, 0);
  const steps = messages.reduce((n, m) => n + (m.role === "assistant" && m.text ? 1 : 0), 0);

  /** 切换会话：加载历史（重放事件流）；运行中禁止切换避免状态错乱 */
  const openSession = async (id: string) => {
    if (running || id === activeSessionId || busyId) return;
    setBusyId(id);
    try {
      const { events } = await fetchSessionEvents(id);
      clearPendingRollback(); // 切换会话时放弃回滚待定态
      loadSession(events);
      setActiveSessionId(id);
    } catch {
      /* 加载失败静默（列表已展示现状） */
    } finally {
      setBusyId(null);
    }
  };

  /** 删除会话（当前会话删除后回到空态） */
  const removeSession = async (id: string) => {
    if (running) return;
    setBusyId(id);
    try {
      await deleteSession(id);
      await fetchSessions();
      if (activeSessionId === id) newSession();
    } catch {
      /* 删除失败静默 */
    } finally {
      setBusyId(null);
    }
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      {/* 会话列表（v2.1 多会话） */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-semibold text-sub">会话</div>
          <button
            className="flex cursor-pointer items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-text transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            onClick={newSession}
            disabled={running}
            title="新建会话（清空当前对话区）"
          >
            <Plus className="h-3 w-3" />
            新建
          </button>
        </div>

        {sessions.length === 0 && (
          <div className="mb-3 rounded-md border border-dashed border-line px-2 py-3 text-center text-[11px] leading-relaxed text-sub/60">
            暂无历史会话。
            <br />
            完成的任务会自动保存到这里。
          </div>
        )}

        <div className="space-y-1.5">
          {sessions.map((s) => {
            const active = s.id === activeSessionId;
            const badge = STATUS_BADGE[s.status];
            return (
              <div
                key={s.id}
                className={`group relative cursor-pointer rounded-md border px-2 py-1.5 transition-colors duration-150 ${
                  active
                    ? "border-accent/50 bg-accent/10"
                    : "border-line bg-muted/40 hover:border-accent/40 hover:bg-muted"
                } ${busyId === s.id ? "opacity-60" : ""}`}
                onClick={() => openSession(s.id)}
                title={`${s.root}\n${s.promptCount} 轮 · ${s.toolCount} 工具 · ${fmtTime(s.createdAt)} 创建`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`min-w-0 flex-1 truncate text-[11px] font-medium ${active ? "text-accent" : "text-text"}`}>
                    {s.title}
                  </span>
                  <span className={`shrink-0 text-[10px] ${badge.cls}`}>{badge.label}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-sub/70">
                  {fmtTime(s.updatedAt)} · {s.promptCount} 轮 {s.toolCount} 工具
                </div>
                {/* hover 删除 */}
                {!active && (
                  <button
                    className="absolute right-1.5 top-1.5 hidden cursor-pointer rounded p-0.5 text-sub transition-colors hover:text-danger group-hover:block"
                    onClick={(e) => { e.stopPropagation(); removeSession(s.id); }}
                    title="删除会话"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 任务概览（压缩保留） */}
      <div className="border-t border-line p-3">
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

        {/* 文件改动列表 */}
        <div className="mt-3">
          <div className="mb-1.5 text-xs font-semibold text-sub">文件改动</div>
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
      </div>
    </aside>
  );
}
