import { useMemo, useState } from "react";
import { Activity, Bot, Braces, ChevronRight, FileDown, Gauge, ListTree, RotateCcw, Wrench } from "lucide-react";
import { useStore } from "../store";
import { CodeBlock } from "./ui";
import type { AgentEvent, StoredEvent } from "@infu/shared";

type TraceKind = "model" | "tool" | "recovery" | "workflow" | "other";
const EMPTY_EVENTS: StoredEvent[] = [];

function classify(event: AgentEvent): TraceKind {
  if (event.type === "model-call") return "model";
  if (event.type === "tool-start" || event.type === "tool-result") return "tool";
  if (event.type === "context-compressed" || event.type === "model-fallback" || event.type === "retry") return "recovery";
  if (event.type === "subagent-start" || event.type === "subagent-done" || event.type === "task-notification") return "workflow";
  return "other";
}

function label(event: AgentEvent): string {
  switch (event.type) {
    case "model-call": return `${event.model} · ${event.summary ? "上下文摘要" : "模型调用"}`;
    case "tool-start": return `${event.tool} · 开始`;
    case "tool-result": return `${event.tool} · ${event.ok ? "完成" : "失败"}`;
    case "context-compressed": return `上下文压缩 · ${event.before.toLocaleString()} → ${event.after.toLocaleString()}`;
    case "model-fallback": return `模型降级 · ${event.from} → ${event.to}`;
    case "retry": return `模型重试 · ${event.attempt}/${event.maxAttempts}`;
    case "subagent-start": return `子 Agent · ${event.name} 已启动`;
    case "subagent-done": return `子 Agent · ${event.ok ? "完成" : "失败"}`;
    case "task-notification": return `${event.taskType} · ${event.status}`;
    case "error": return `错误 · ${event.message.slice(0, 80)}`;
    default: return event.type;
  }
}

function Icon({ kind }: { kind: TraceKind }) {
  const C = kind === "model" ? Gauge : kind === "tool" ? Wrench : kind === "recovery" ? RotateCcw : kind === "workflow" ? Bot : Activity;
  return <C className="h-3.5 w-3.5" />;
}

function eventSummary(event: AgentEvent): string | null {
  if (event.type === "tool-result") return event.summary;
  if (event.type === "context-compressed") return event.summary || "已通过确定性裁剪或摘要缩减上下文。";
  if (event.type === "model-fallback") return event.reason;
  if (event.type === "retry") return event.message;
  if (event.type === "error") return event.message;
  return null;
}

export default function SessionTracePane() {
  const activeSessionId = useStore((s) => s.activeSessionId);
  // Selector must return a stable empty value. A fresh [] here makes Zustand believe the
  // selection changed on every render, which can recurse into React's update-depth guard.
  const events = useStore((s) => (activeSessionId ? s.traceBySession[activeSessionId] ?? EMPTY_EVENTS : EMPTY_EVENTS));
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useMemo(() => events.filter((x) => ["model-call", "tool-start", "tool-result", "context-compressed", "model-fallback", "retry", "subagent-start", "subagent-done", "task-notification", "error"].includes(x.event.type)), [events]);
  const selectedEvent = selected == null ? null : rows.find((x) => x.seq === selected) ?? null;
  const usage = useMemo(() => rows.reduce((a, x) => {
    if (x.event.type === "model-call") {
      a.prompt += x.event.promptTokens;
      a.output += x.event.completionTokens;
      a.hit += x.event.cacheHit ?? 0;
    }
    return a;
  }, { prompt: 0, output: 0, hit: 0 }), [rows]);

  if (!activeSessionId) return <EmptyState text="打开一个会话后，这里会显示其模型与工具事件。" />;
  if (!rows.length) return <EmptyState text="此会话尚无可追踪的模型或工具事件。" />;
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-text"><ListTree className="h-4 w-4 text-info" />会话追踪</div>
        <div className="mt-1 text-xs leading-5 text-sub">原始事件账本。聊天 Timeline 保持简洁，这里用于诊断成本、缓存与工具执行。</div>
        <div className="mt-2 grid grid-cols-3 gap-1.5 text-[11px]">
          <Metric label="输入" value={usage.prompt} />
          <Metric label="缓存读" value={usage.hit} />
          <Metric label="输出" value={usage.output} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rows.slice().reverse().map((row) => {
          const kind = classify(row.event);
          const isSelected = selected === row.seq;
          return <button key={row.seq} onClick={() => setSelected(isSelected ? null : row.seq)} className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${isSelected ? "bg-info-soft text-text" : "hover:bg-hover"}`}>
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${kind === "recovery" ? "bg-warn-soft text-warn" : kind === "tool" ? "bg-elevated text-sub" : "bg-info-soft text-info"}`}><Icon kind={kind} /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium">{label(row.event)}</span><span className="block text-[11px] text-caption">{new Date(row.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · #{row.seq}</span></span>
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-caption transition-transform ${isSelected ? "rotate-90" : ""}`} />
          </button>;
        })}
      </div>
      {selectedEvent && <TraceDetails entry={selectedEvent} />}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-md bg-elevated px-2 py-1 text-sub"><span className="block text-caption">{label}</span><span className="font-mono text-text">{value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value}</span></div>; }
function EmptyState({ text }: { text: string }) { return <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sub"><FileDown className="h-7 w-7 text-caption" /><p className="text-[13px] leading-5">{text}</p></div>; }
function TraceDetails({ entry }: { entry: StoredEvent }) {
  const event = entry.event;
  const summary = eventSummary(event);
  return <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-line bg-elevated p-3">
    <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text"><Braces className="h-3.5 w-3.5 text-info" />事件详情</div>
    {event.type === "model-call" && <div className="mb-2 rounded-lg bg-panel px-2.5 py-2 text-xs text-sub">输入 {event.promptTokens.toLocaleString()} · 输出 {event.completionTokens.toLocaleString()} · 缓存读 {(event.cacheHit ?? 0).toLocaleString()} · 未命中 {(event.cacheMiss ?? 0).toLocaleString()}</div>}
    {summary && <CodeBlock label={event.type === "error" ? "错误" : "摘要"} text={summary} maxHeight={144} />}
    <CodeBlock label="原始事件" text={JSON.stringify(event, null, 2)} maxHeight={180} />
  </div>;
}
