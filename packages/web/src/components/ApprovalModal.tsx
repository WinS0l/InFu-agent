import { ShieldAlert, ShieldCheck, Shield, Zap } from "lucide-react";
import { useStore } from "../store";
import { Modal, CapsuleButton } from "./ui";
import { setApprovalBypass } from "../api";

const RISK_META: Record<string, { label: string; Icon: typeof Shield; cls: string }> = {
  low: { label: "低风险", Icon: Shield, cls: "text-sub" },
  medium: { label: "中风险", Icon: ShieldAlert, cls: "text-warn" },
  high: { label: "高风险", Icon: ShieldAlert, cls: "text-danger" },
};

/**
 * 审批弹窗（v3：统一 Modal 原语）：Agent 请求执行中/高风险操作时出现（支持队列逐个处理）。
 * 关键操作：遮罩/Esc 均不可关闭，只能显式允许/拒绝。
 * v3.2：新增「本会话全部放行」——本会话内所有后续审批（含联网/自注册/高危命令红线）直接
 * 放行，直到会话结束（对齐 opencode --auto 真全权语义；显式禁用工具仍拒绝；命令审计照常）。
 */
export default function ApprovalModal() {
  const approvals = useStore((s) => s.approvals);
  const resolveApproval = useStore((s) => s.resolveApproval);
  const resolveAllApprovals = useStore((s) => s.resolveAllApprovals);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setBypassFor = useStore((s) => s.setBypassFor);
  const addError = useStore((s) => s.addError);
  // v3.5 审计修复：弹窗只展示/处理**当前会话**的审批（多会话并行时后台会话的
  // 审批不再混入队列被误处理；其服务端挂起项会在该任务结束时自动清理）
  const mine = approvals.filter((a) => !activeSessionId || a.sessionId === activeSessionId);
  const approval = mine[0]; // 队列头部，处理完自动显示下一个
  // v3.5 修复：bypass 按审批所属会话（多会话并行/后台会话审批时不再错会话）
  const approvalSid = approval?.sessionId ?? activeSessionId ?? "";
  const bypassActive = useStore((s) => (approvalSid ? s.bypassBySession[approvalSid] === true : false));
  if (!approval) return null;

  const meta = RISK_META[approval.risk] ?? RISK_META.medium;
  const { Icon, label, cls } = meta;
  const queued = mine.length - 1;

  /** 开启/关闭本会话全权放行（开启时当前积压审批一并全部批准） */
  const toggleBypass = async () => {
    if (!approvalSid) {
      addError("无法确定审批所属会话，跳过全权放行");
      return;
    }
    const next = !bypassActive;
    try {
      await setApprovalBypass(approvalSid, next);
      setBypassFor(approvalSid, next);
    } catch (e) {
      addError(`全权放行开关失败：${(e as Error).message ?? String(e)}`);
      return;
    }
    if (next && mine.length > 0) resolveAllApprovals(true);
  };

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
          <CapsuleButton variant="ghost" size="md" onClick={() => void toggleBypass()} title={bypassActive ? "关闭后恢复逐项审批" : "本会话内所有后续审批（含红线）直接放行，直到会话结束"} className={bypassActive ? "border-accent/50 text-accent" : ""}>
            {bypassActive ? "已放行·点击关闭" : "本会话全部放行"}
          </CapsuleButton>
          {queued > 0 && (
            <CapsuleButton variant="ghost" size="md" onClick={() => resolveAllApprovals(false)}>
              全部拒绝（{mine.length}）
            </CapsuleButton>
          )}
          <CapsuleButton variant="danger" size="md" onClick={() => resolveApproval(false)}>
            拒绝
          </CapsuleButton>
          {queued > 0 && (
            <CapsuleButton variant="primary" size="md" onClick={() => resolveAllApprovals(true)}>
              全部允许（{mine.length}）
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
            {" 当前共 " + mine.length + " 项待处理（Agent 并行发起的多个请求）——可用「全部允许/全部拒绝」一次处理。"}
          </>
        )}
      </div>
      {!bypassActive && (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-line/60 bg-elevated px-2.5 py-1.5 text-[11px] leading-4 text-sub">
          <Zap className="h-3 w-3 shrink-0 text-accent" />
          「本会话全部放行」= 本会话内所有后续审批（含联网/自注册/高危命令）直接放行，直到会话结束；命令审计照常记录。
        </div>
      )}
    </Modal>
  );
}
