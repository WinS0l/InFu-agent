import { ShieldAlert, ShieldCheck, Shield } from "lucide-react";
import { useStore } from "../store";
import { Modal, CapsuleButton } from "./ui";

const RISK_META: Record<string, { label: string; Icon: typeof Shield; cls: string }> = {
  low: { label: "低风险", Icon: Shield, cls: "text-sub" },
  medium: { label: "中风险", Icon: ShieldAlert, cls: "text-warn" },
  high: { label: "高风险", Icon: ShieldAlert, cls: "text-danger" },
};

/**
 * 审批弹窗（v3：统一 Modal 原语）：Agent 请求执行中/高风险操作时出现（支持队列逐个处理）。
 * 关键操作：遮罩/Esc 均不可关闭，只能显式允许/拒绝。
 */
export default function ApprovalModal() {
  const approvals = useStore((s) => s.approvals);
  const resolveApproval = useStore((s) => s.resolveApproval);
  const resolveAllApprovals = useStore((s) => s.resolveAllApprovals);

  const approval = approvals[0]; // 队列头部，处理完自动显示下一个
  if (!approval) return null;

  const meta = RISK_META[approval.risk] ?? RISK_META.medium;
  const { Icon, label, cls } = meta;
  const queued = approvals.length - 1;

  return (
    <Modal
      onClose={() => {}}
      maskClosable={false}
      escClose={false}
      showClose={false}
      width={440}
      title="操作审批"
      icon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-elevated">
          <Icon className={`h-4 w-4 ${cls}`} />
        </span>
      }
      footer={
        <>
          {queued > 0 && (
            <CapsuleButton variant="ghost" size="md" onClick={() => resolveAllApprovals(false)}>
              全部拒绝（{approvals.length}）
            </CapsuleButton>
          )}
          <CapsuleButton variant="danger" size="md" onClick={() => resolveApproval(false)}>
            拒绝
          </CapsuleButton>
          {queued > 0 && (
            <CapsuleButton variant="primary" size="md" onClick={() => resolveAllApprovals(true)}>
              全部允许（{approvals.length}）
            </CapsuleButton>
          )}
          <CapsuleButton variant="primary" size="md" onClick={() => resolveApproval(true)}>
            允许
          </CapsuleButton>
        </>
      }
    >
      <div className="flex items-center gap-1.5">
        <span className={`rounded-full border border-line px-2 py-0.5 text-[11px] ${cls}`}>{label}</span>
        {queued > 0 && (
          <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-sub">待处理 {queued + 1} 项</span>
        )}
      </div>
      <div className="mt-3 whitespace-pre-wrap text-sm leading-6 text-text/90">{approval.description}</div>
      <div className="mt-2 text-xs leading-5 text-sub">
        InFu 将执行此操作。请确认操作对象与目标路径无误后再允许。
        {queued > 0 && (
          <>
            {" 当前共 " + approvals.length + " 项待处理（Agent 并行发起的多个请求）——可用「全部允许/全部拒绝」一次处理。"}
          </>
        )}
      </div>
    </Modal>
  );
}
