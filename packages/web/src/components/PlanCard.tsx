import { useState } from "react";
import { Send, X, PencilLine, MessageSquarePlus } from "lucide-react";
import { useStore } from "../store";
import { postPlanDecision } from "../api";

/**
 * 计划卡片（M4 + v2.3，v3 重样式：主流 审批接管卡——与输入胶囊等宽 r20，
 * 头部信息蓝条 + 可编辑计划 + 自由回复 + 右对齐胶囊按钮）。
 * Planner 输出执行计划 → 用户可编辑计划文本 + 自由回复 →「提交」（回复交给 AI
 * 判断 execute/revise/abort）/「取消」（中止任务）。
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
    <div className="mx-auto mb-2 max-w-[780px] rounded-[20px] border border-line bg-elevated px-4 py-3 shadow-lv2">
      {/* 头部条（主流 接管卡风格：信息蓝底 + 说明） */}
      <div className="mb-2 flex items-center gap-2 rounded-lg bg-info-soft px-2.5 py-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full bg-info" />
        <span className="text-[13px] font-medium leading-[18px] text-info">执行计划</span>
        <span className="ml-auto flex items-center gap-1 truncate text-xs text-sub">
          <PencilLine className="h-3 w-3 shrink-0" />
          Planner 生成，可直接编辑；提交后 AI 按你的回复决定执行 / 修订 / 停止
        </span>
      </div>
      <textarea
        className="h-28 w-full resize-y rounded-xl border border-line bg-code px-3 py-2 font-mono text-[13px] leading-[22px] text-text focus:border-info/60 focus:outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      {/* v2.3 用户自由回复（AI 判断意图：执行/修订/停止） */}
      <div className="mt-1.5 flex items-center gap-1.5 rounded-xl border border-line bg-input px-2.5 py-1.5">
        <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-sub" />
        <input
          className="min-w-0 flex-1 bg-transparent text-[13px] text-text placeholder:text-caption focus:outline-none"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="你的回复：批准执行 / 不要修改 xxx 文件 / 先不做 / 改成只改 README…"
        />
      </div>
      {error && <div className="mt-1.5 text-xs text-danger">{error}</div>}
      <div className="mt-2 flex items-center justify-end gap-2">
        {busy && <span className="text-xs text-sub">等待确认…</span>}
        <button
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-[14px] border border-line px-2.5 text-[13px] text-sub transition-colors hover:border-danger/60 hover:text-danger disabled:opacity-40"
          onClick={cancel}
          disabled={busy}
          title="取消：中止任务（不执行、不审查）"
        >
          <X className="h-3.5 w-3.5" />
          取消
        </button>
        <button
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-[14px] bg-primary px-2.5 text-[13px] font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          onClick={submit}
          disabled={busy}
          title="提交：AI 将分析你的回复（执行/修订/停止）"
        >
          <Send className="h-3.5 w-3.5" />
          提交
        </button>
      </div>
    </div>
  );
}
