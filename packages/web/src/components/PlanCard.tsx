import { useState } from "react";
import { ClipboardCheck, Check, X, PencilLine } from "lucide-react";
import { useStore } from "../store";
import { postPlanDecision } from "../api";

/**
 * 计划卡片（M4）：Planner 输出执行计划 → 用户可编辑 → 批准/拒绝后进入 Executor。
 * 对齐 Cursor/Copilot 的"计划 artifact"交互：计划可修改，批准后才允许改代码。
 * 父组件按 plan.id 作为 key 重挂载，保证编辑态与计划一一对应。
 */
export default function PlanCard() {
  const plan = useStore((s) => s.plan);
  const clearPlan = useStore((s) => s.clearPlan);
  const [text, setText] = useState(plan?.content ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!plan) return null;

  const decide = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await postPlanDecision(plan.id, approved, approved ? text : undefined);
      clearPlan();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-accent/25 bg-accent/5 px-4 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        <ClipboardCheck className="h-4 w-4 shrink-0 text-accent" />
        <span className="text-sm font-semibold text-accent">执行计划</span>
        <span className="flex items-center gap-1 text-[10px] text-sub">
          <PencilLine className="h-3 w-3" />
          Planner 生成，可直接编辑，批准后按此计划修改代码
        </span>
      </div>
      <textarea
        className="h-28 w-full resize-y rounded-lg border border-line bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed text-text focus:border-accent/60 focus:outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      {error && <div className="mt-1.5 text-xs text-danger">{error}</div>}
      <div className="mt-2 flex items-center gap-2">
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent/90 px-3 py-1.5 text-xs font-medium text-ink transition-colors duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => decide(true)}
          disabled={busy}
          title="批准执行：InFu 将按此计划开始修改代码"
        >
          <Check className="h-3.5 w-3.5" />
          批准执行
        </button>
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-sub transition-colors duration-150 hover:border-danger/60 hover:text-danger disabled:opacity-40"
          onClick={() => decide(false)}
          disabled={busy}
          title="拒绝计划：任务取消"
        >
          <X className="h-3.5 w-3.5" />
          拒绝
        </button>
        {busy && <span className="text-[10px] text-sub">等待确认…</span>}
      </div>
    </div>
  );
}
