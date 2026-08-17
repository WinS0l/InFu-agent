import { useState } from "react";
import { Check, ListTodo, Loader2 } from "lucide-react";
import { useStore } from "../store";

/**
 * v2.10 任务清单面板（对齐 主流 TodoDock）：输入卡上方折叠条——
 * 清单图标 + 进度计数（完成·进行中·待办）+ 点击展开列表；
 * 状态字形：completed 实心对勾 / in_progress 旋转环 / pending 虚线环。
 * 纯展示——状态由模型 todo_write 更新（todo-write 事件驱动）。
 */
export default function TodoPanel() {
  const todos = useStore((s) => s.todos);
  const [open, setOpen] = useState(false);
  // v3.5 常规设置 showTodos（关闭 = 完全隐藏待办面板）
  const showTodos = useStore((s) => s.uiShowTodos);
  if (!todos.length || !showTodos) return null;

  const done = todos.filter((t) => t.status === "completed").length;
  const inProg = todos.filter((t) => t.status === "in_progress").length;
  const pending = todos.length - done - inProg;

  return (
    // v2.14 批 16：缩小 + 居中（max-w 780 → 500）——避开输入卡右上终端按钮的垂直区域；
    // 左右留白后按钮区空出，不重合；文字仍 13px 可读
    <div className="mx-auto mb-2 w-full max-w-[500px] rounded-xl border border-line bg-elevated shadow-lv1">
      {/* 折叠标题栏（点击展开/收起） */}
      <button
        className="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left transition-colors hover:bg-hover/60"
        onClick={() => setOpen(!open)}
        title="任务清单（由 Agent 的 todo_write 维护）"
      >
        <ListTodo className="h-3.5 w-3.5 shrink-0 text-info" />
        <span className="shrink-0 text-[13px] font-medium text-text">任务清单</span>
        <span className="min-w-0 flex-1 truncate text-xs text-caption">
          {done} 完成 · {inProg} 进行中 · {pending} 待办
        </span>
        {/* 当前进行中指示 */}
        {inProg > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-ongoing">
            <Loader2 className="h-3 w-3 animate-spin" />
            执行中
          </span>
        )}
      </button>
      {/* 展开列表（纯展示） */}
      {open && (
        <ul className="space-y-0.5 border-t border-line px-3 py-2">
          {todos.map((t, i) => (
            <li key={i} className="flex items-center gap-2 py-0.5 text-[13px] leading-5" data-status={t.status}>
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {t.status === "completed" ? (
                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success/20">
                    <Check className="h-2.5 w-2.5 text-success" strokeWidth={3} />
                  </span>
                ) : t.status === "in_progress" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-ongoing" />
                ) : (
                  <span className="h-3.5 w-3.5 rounded-full border-[1.5px] border-dashed border-sub/60" />
                )}
              </span>
              <span
                className={`min-w-0 flex-1 ${
                  t.status === "completed" ? "text-caption line-through" : t.status === "in_progress" ? "text-text" : "text-text/80"
                }`}
              >
                {t.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
