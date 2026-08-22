import { useRef, useState } from "react";
import { GripVertical, Pencil, Send, X, ArrowUp, ArrowDown, Minus } from "lucide-react";
import { useStore, type QueueItem } from "../store";
import { sendChat } from "../api";

/**
 * v3.1 排队发送 dock（对齐 主流 QueueDock 增强版）：
 * 会话运行中输入的消息进入队列，任务结束后自动消费；每条支持
 * 编辑（inline 输入）/ 移除 / 立即发送（Stop & Send：停止当前任务立刻发这条）；
 * 拖拽手柄可调整发送顺序。
 */
export default function QueueDock() {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const queuesBySession = useStore((s) => s.queuesBySession);
  const runningIds = useStore((s) => s.runningIds);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const queue = activeSessionId ? (queuesBySession[activeSessionId] ?? []) : [];
  if (!queue.length) return null;
  const mineRunning = activeSessionId ? runningIds.includes(activeSessionId) : false;

  const commitEdit = (id: string) => {
    const t = editText.trim();
    if (t && activeSessionId) useStore.getState().updateQueueItem(activeSessionId, id, t);
    setEditingId(null);
  };

  /** 立即发送（你拍板的语义 = Cursor Stop & Send）：先移出队列再停当前任务再发 */
  const sendNow = (id: string, text: string) => {
    if (!activeSessionId) return;
    useStore.getState().removeQueueItem(activeSessionId, id);
    setEditingId(null);
    const sid = activeSessionId;
    if (mineRunning) {
      useStore.getState().abortRun();
      // v3.5 审计修复（Stop&Send 竞态）：必须等旧任务真正收尾（runningIds 移除）再发——
      // 服务端有同会话双发保护（status=running 拒绝新请求），旧流 finally 尚未执行时
      // 立刻发送会 400 失败；轮询等待（最长 8s，异常情况超时照发由错误提示兜底）
      const t0 = Date.now();
      const wait = setInterval(() => {
        if (!useStore.getState().runningIds.includes(sid) || Date.now() - t0 > 8000) {
          clearInterval(wait);
          sendChat(text, { sessionId: sid }).catch(() => {});
        }
      }, 120);
    } else {
      sendChat(text, { sessionId: sid }).catch(() => {});
    }
  };

  /** 拖拽排序（原生 HTML5 DnD：拖到目标行上交换） */
  const onDrop = (toIdx: number) => {
    if (dragIdx == null || !activeSessionId || dragIdx === toIdx) return;
    useStore.getState().reorderQueue(activeSessionId, dragIdx, toIdx);
    setDragIdx(null);
  };
  const cyclePriority = (id: string, current: QueueItem["priority"]) => {
    if (!activeSessionId) return;
    const next = current === "low" ? "normal" : current === "normal" ? "high" : "low";
    useStore.setState((s) => ({ queuesBySession: { ...s.queuesBySession, [activeSessionId]: (s.queuesBySession[activeSessionId] ?? []).map((x) => x.id === id ? { ...x, priority: next } : x) } }));
  };

  return (
    <div className="mx-auto mb-2 max-w-[780px] rounded-2xl border border-line bg-elevated p-1.5 shadow-lv1">
      <div className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
        {queue.map((item, i) => (
          <div
            key={item.id}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(i)}
            className={`group flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-[13px] transition-colors ${
              dragIdx === i ? "opacity-50" : ""
            } hover:bg-hover/60`}
            title="待发送（任务结束后自动发送；可拖拽调整顺序）"
          >
            <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-caption" />
            <button className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-hover ${item.priority === "high" ? "text-danger" : item.priority === "low" ? "text-caption" : "text-info"}`} onClick={() => cyclePriority(item.id, item.priority)} title={`优先级：${item.priority === "high" ? "高" : item.priority === "low" ? "低" : "普通"}（点击切换）`}>
              {item.priority === "high" ? <ArrowUp className="h-3 w-3" /> : item.priority === "low" ? <ArrowDown className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
            </button>
            {editingId === item.id ? (
              <input
                ref={inputRef}
                autoFocus
                className="h-6 min-w-0 flex-1 rounded-md border border-info/40 bg-input px-2 text-[13px] text-text focus:outline-none"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit(item.id);
                  if (e.key === "Escape") { setEditingId(null); setEditText(""); }
                }}
                spellCheck={false}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-text/85">{item.text}</span>
            )}
            {/* 操作：编辑 / 移除 / 立即发送（仅运行中可用；空闲时它马上会被自动消费） */}
            {editingId === item.id ? (
              <button
                className="shrink-0 cursor-pointer rounded-lg px-1.5 py-0.5 text-xs text-text transition-colors hover:bg-hover"
                onClick={() => commitEdit(item.id)}
              >
                保存
              </button>
            ) : (
              <button
                className="shrink-0 cursor-pointer rounded-lg p-1 text-sub transition-colors hover:bg-hover hover:text-text"
                onClick={() => { setEditingId(item.id); setEditText(item.text); }}
                title="编辑"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            <button
              className="shrink-0 cursor-pointer rounded-lg p-1 text-sub transition-colors hover:bg-hover hover:text-danger"
              onClick={() => activeSessionId && useStore.getState().removeQueueItem(activeSessionId, item.id)}
              title="移除"
            >
              <X className="h-3 w-3" />
            </button>
            <button
              className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors ${
                mineRunning ? "bg-primary text-primary-fg hover:bg-primary-hover" : "text-caption"
              }`}
              onClick={() => sendNow(item.id, item.text)}
              disabled={!mineRunning}
              title={mineRunning ? "立即发送：停止当前任务并立刻发送这条" : "任务结束后会自动发送"}
            >
              <Send className="h-3 w-3" />
              立即发送
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
