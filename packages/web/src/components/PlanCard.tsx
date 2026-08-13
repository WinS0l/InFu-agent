import { useState } from "react";
import { ClipboardCheck, Send, X, PencilLine, MessageSquarePlus } from "lucide-react";
import { useStore } from "../store";
import { postPlanDecision } from "../api";

/**
 * 计划卡片（M4 + v2.3）：Planner 输出执行计划 → 用户可编辑计划文本 + 自由回复 →
 * 「提交」（回复交给 AI 判断 execute/revise/abort）/「取消」（中止任务）。
 * 用户回复可以是"批准执行" / "不要动 xxx 文件" / "先不做" / "改成只改 README" 等。
 * 父组件按 plan.id 作为 key 重挂载，保证编辑态与计划一一对应。
 */
export default function PlanCard() {
  const plan = useStore((s) => s.plan);
  const clearPlan = useStore((s) => s.clearPlan);
  const [text, setText] = useState(plan?.content ?? "");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!plan) return null;

  /** 提交：编辑后的计划 + 用户自由回复（AI 判断意图） */
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await postPlanDecision(plan.id, {
        plan: text.trim() ? text : undefined,
        feedback: feedback.trim() ? feedback : "批准执行",
      });
      clearPlan();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  /** 取消：中止任务（不执行、不审查） */
  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await postPlanDecision(plan.id, { cancelled: true });
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
          Planner 生成，可直接编辑；提交后 AI 按你的回复决定执行 / 修订 / 停止
        </span>
      </div>
      <textarea
        className="h-28 w-full resize-y rounded-lg border border-line bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed text-text focus:border-accent/60 focus:outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      {/* v2.3 用户自由回复（AI 判断意图：执行/修订/停止） */}
      <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-line bg-muted/60 px-2 py-1.5">
        <MessageSquarePlus className="h-3 w-3 shrink-0 text-sub" />
        <input
          className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-sub/50 focus:outline-none"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="你的回复：批准执行 / 不要修改 xxx 文件 / 先不做 / 改成只改 README…"
        />
      </div>
      {error && <div className="mt-1.5 text-xs text-danger">{error}</div>}
      <div className="mt-2 flex items-center gap-2">
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent/90 px-3 py-1.5 text-xs font-medium text-ink transition-colors duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          onClick={submit}
          disabled={busy}
          title="提交：AI 将分析你的回复（执行/修订/停止）"
        >
          <Send className="h-3.5 w-3.5" />
          提交
        </button>
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-sub transition-colors duration-150 hover:border-danger/60 hover:text-danger disabled:opacity-40"
          onClick={cancel}
          disabled={busy}
          title="取消：中止任务（不执行、不审查）"
        >
          <X className="h-3.5 w-3.5" />
          取消
        </button>
        {busy && <span className="text-[10px] text-sub">等待确认…</span>}
      </div>
    </div>
  );
}
