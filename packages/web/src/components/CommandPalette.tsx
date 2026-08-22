import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Command, FileSearch, Moon, PanelRightOpen, Plus, Search, Settings, Sun } from "lucide-react";
import { useStore } from "../store";

type Action = { id: string; label: string; hint: string; icon: typeof Command; run: () => void };

export default function CommandPalette({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const actions = useMemo<Action[]>(() => [
    { id: "new", label: "新建会话", hint: "Ctrl+N", icon: Plus, run: () => useStore.getState().newSession() },
    { id: "search", label: "搜索会话", hint: "在左侧栏筛选", icon: Search, run: () => useStore.getState().focusSearch() },
    { id: "review", label: "打开审查", hint: "查看当前改动与验证", icon: FileSearch, run: () => { useStore.getState().setDetailsOpen(true); useStore.getState().openRightTab({ id: "review", kind: "review", label: "审查" }); } },
    { id: "context", label: "打开上下文中心", hint: "任务、审批与诊断", icon: PanelRightOpen, run: () => useStore.getState().setDetailsOpen(true) },
    { id: "light", label: "切换为浅色主题", hint: "即时预览", icon: Sun, run: () => useStore.getState().setTheme("light") },
    { id: "dark", label: "切换为暗色主题", hint: "即时预览", icon: Moon, run: () => useStore.getState().setTheme("dark") },
    { id: "settings", label: "打开设置", hint: "模型、权限与外观", icon: Settings, run: onOpenSettings },
  ], [onOpenSettings]);
  const visible = actions.filter((action) => `${action.label} ${action.hint}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive((index) => Math.min(index, Math.max(0, visible.length - 1))); }, [visible.length]);
  const execute = (action?: Action) => { if (!action) return; action.run(); onClose(); };
  return <div className="command-mask" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
      <div className="flex items-center gap-3 border-b border-line px-4"><Command className="h-4 w-4 text-sub" /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onClose(); if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, visible.length - 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); } if (event.key === "Enter") { event.preventDefault(); execute(visible[active]); } }} placeholder="搜索命令、会话或工作区…" className="h-13 min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-caption" /></div>
      <div className="max-h-[min(430px,60vh)] overflow-y-auto p-2">{visible.map((action, index) => { const Icon = action.icon; return <button key={action.id} onMouseMove={() => setActive(index)} onClick={() => execute(action)} className={`command-row ${index === active ? "command-row-active" : ""}`}><span className="command-icon"><Icon className="h-4 w-4" /></span><span className="min-w-0 flex-1 text-left"><span className="block text-sm font-medium">{action.label}</span><span className="block truncate text-xs text-caption">{action.hint}</span></span>{index === active && <CheckCircle2 className="h-4 w-4 text-info" />}</button>; })}{visible.length === 0 && <div className="px-3 py-8 text-center text-sm text-sub">没有匹配的命令</div>}</div>
      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-caption"><span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span></div>
    </section>
  </div>;
}
