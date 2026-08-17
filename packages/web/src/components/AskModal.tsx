import { useState } from "react";
import { Check, MessageCircleQuestion, PenLine } from "lucide-react";
import { useStore, type AskOption } from "../store";
import { Modal, CapsuleButton } from "./ui";

/**
 * v2.6 收尾：Agent 执行中提问弹窗（ask_user 工具；v3 统一 Modal 原语；Esc/遮罩 = 跳过继续任务）。
 * v2.10 升级（对齐 AskUserQuestion 规范）：单选/多选、推荐徽章（Recommended）、
 * 选项说明小字、问题补充说明 description、自定义回答保留。
 */

/** 选项归一化（string | 对象 → AskOption） */
function normOptions(options?: Array<string | AskOption>): AskOption[] {
  return (options ?? []).map((o) => (typeof o === "string" ? { label: o } : o));
}

export default function AskModal() {
  const question = useStore((s) => s.askQuestion);
  const resolveAskQuestion = useStore((s) => s.resolveAskQuestion);
  const [answer, setAnswer] = useState("");
  const [custom, setCustom] = useState(false);
  // 多选已选集合
  const [selected, setSelected] = useState<string[]>([]);

  // 弹窗关闭后重置内部状态（重新打开时干净）
  if (!question) {
    if (answer || custom || selected.length) {
      setAnswer("");
      setCustom(false);
      setSelected([]);
    }
    return null;
  }

  const opts = normOptions(question.options);
  const multi = question.multiSelect === true;

  const submit = (value: string | null) => {
    resolveAskQuestion(value);
    setAnswer("");
    setCustom(false);
    setSelected([]);
  };
  // 多选提交：已选项以「、」连接
  const submitMulti = () => {
    if (selected.length) submit(selected.join("、"));
  };
  // 多选切换
  const toggle = (label: string) => {
    setSelected((prev) => (prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]));
  };

  return (
    <Modal
      onClose={() => submit(null)}
      width={480}
      title="Agent 提问"
      subtitle={multi ? "可多选（点击选项切换，提交后继续任务）" : "等待你的输入"}
      icon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-info-soft">
          <MessageCircleQuestion className="h-4 w-4 text-info" />
        </span>
      }
      footer={
        <>
          <CapsuleButton variant="ghost" size="md" className="text-warn hover:bg-warn-soft hover:text-warn" onClick={() => submit(null)}>
            跳过（继续任务）
          </CapsuleButton>
          {multi ? (
            <CapsuleButton variant="primary" size="md" disabled={!selected.length} onClick={submitMulti}>
              提交选择（{selected.length}）
            </CapsuleButton>
          ) : (
            (custom || !opts.length) && (
              <CapsuleButton variant="primary" size="md" disabled={!answer.trim()} onClick={() => submit(answer.trim())}>
                回答
              </CapsuleButton>
            )
          )}
        </>
      }
    >
      <div className="whitespace-pre-wrap text-sm leading-6 text-text/90">{question.question}</div>
      {question.description && (
        <div className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-caption">{question.description}</div>
      )}
      {opts.length ? (
        <div className="mt-3 flex flex-col gap-1.5">
          {opts.map((opt, i) => {
            const checked = selected.includes(opt.label);
            return (
              <button
                key={i}
                className={`cursor-pointer rounded-xl border px-3 py-2 text-left text-sm transition-colors duration-150 ${
                  multi
                    ? checked
                      ? "border-info/60 bg-info-soft/50"
                      : "border-line hover:border-info/60 hover:bg-hover"
                    : "border-line hover:border-info/60 hover:bg-hover"
                }`}
                onClick={() => (multi ? toggle(opt.label) : submit(opt.label))}
              >
                <span className="flex items-center gap-2">
                  {multi && (
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        checked ? "border-info bg-info" : "border-line bg-input"
                      }`}
                    >
                      {checked && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-text">{opt.label}</span>
                      {opt.recommended && (
                        <span className="shrink-0 rounded-md bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info">
                          推荐
                        </span>
                      )}
                    </span>
                    {opt.desc && <span className="block text-xs leading-5 text-caption">{opt.desc}</span>}
                  </span>
                </span>
              </button>
            );
          })}
          {!multi && !custom ? (
            <button
              className="cursor-pointer rounded-xl border border-dashed border-line px-3 py-2 text-left text-sm text-sub transition-colors duration-150 hover:border-info/60"
              onClick={() => setCustom(true)}
            >
              <PenLine className="mr-1 inline h-3.5 w-3.5" />
              自定义回答…
            </button>
          ) : (
            !multi &&
            custom && (
              <input
                autoFocus
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && answer.trim()) submit(answer.trim());
                }}
                placeholder="输入回答后回车…"
                className="w-full rounded-xl border border-line bg-input px-3 py-2 text-sm text-text placeholder:text-caption focus:border-info/60 focus:outline-none"
              />
            )
          )}
        </div>
      ) : (
        <input
          autoFocus
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && answer.trim()) submit(answer.trim());
          }}
          placeholder="输入回答后回车…"
          className="mt-3 w-full rounded-xl border border-line bg-input px-3 py-2 text-sm text-text placeholder:text-caption focus:border-info/60 focus:outline-none"
        />
      )}
    </Modal>
  );
}
