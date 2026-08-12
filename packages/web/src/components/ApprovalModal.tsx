import { ShieldAlert, ShieldCheck, Shield } from "lucide-react";
import { useStore } from "../store";

const RISK_META: Record<string, { label: string; Icon: typeof Shield; cls: string }> = {
  low: { label: "低风险", Icon: Shield, cls: "text-sub" },
  medium: { label: "中风险", Icon: ShieldAlert, cls: "text-warn" },
  high: { label: "高风险", Icon: ShieldAlert, cls: "text-danger" },
};

/** 审批弹窗：Agent 请求执行中/高风险操作时出现（支持队列逐个处理） */
export default function ApprovalModal() {
  const approvals = useStore((s) => s.approvals);
  const resolveApproval = useStore((s) => s.resolveApproval);

  const approval = approvals[0]; // 队列头部，处理完自动显示下一个
  if (!approval) return null;

  const meta = RISK_META[approval.risk] ?? RISK_META.medium;
  const { Icon, label, cls } = meta;
  const queued = approvals.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[420px] max-w-[90vw] rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Icon className={`h-4 w-4 ${cls}`} />
          <span className="text-sm font-semibold">操作审批</span>
          <span className={`rounded-full border border-line px-2 py-0.5 text-[10px] ${cls}`}>{label}</span>
          {queued > 0 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-sub">
              待处理 {queued + 1} 项
            </span>
          )}
        </div>
        <div className="px-4 py-4">
          <div className="text-sm leading-relaxed text-text/90">{approval.description}</div>
          <div className="mt-2 text-[11px] leading-relaxed text-sub">
            InFu 将执行此操作。请确认操作对象与目标路径无误后再允许。
            {queued > 0 && " 批准后将继续处理下一项。"}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            className="cursor-pointer rounded-md border border-line px-4 py-1.5 text-sm text-text transition-colors duration-150 hover:border-danger/60 hover:text-danger"
            onClick={() => resolveApproval(false)}
          >
            拒绝
          </button>
          <button
            className="cursor-pointer rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-ink transition-colors duration-150 hover:bg-accent/85"
            onClick={() => resolveApproval(true)}
          >
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
