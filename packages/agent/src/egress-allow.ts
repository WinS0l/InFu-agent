/**
 * v5.0（C1）：会话级临时联网开关
 *
 * 背景：默认断网策略下 npm install 等高频操作每次都被 egress 拦截（full 档也拦——
 * 断网是硬闸，不是审批档位问题）。给用户一个轻量出口：本会话临时允许联网 N 分钟，
 * 到期自动失效（不改变全局档位/不永久放行）。
 *
 * 语义：与 sessionBypass（审批全权放行）同模式——会话级、到期自动清除；
 * 放行 ≠ 静默：命令审计照常落库（egress-allowed-temp 标记）。
 */
const allows = new Map<string, number>(); // sessionId → 到期时间戳

/** 开启临时联网（minutes 1-120；重复调用刷新到期时间） */
export function setEgressAllow(sessionId: string, minutes: number): void {
  const m = Math.max(1, Math.min(120, Math.floor(minutes) || 10));
  allows.set(sessionId, Date.now() + m * 60000);
}

/** 关闭临时联网 */
export function clearEgressAllow(sessionId: string): void {
  allows.delete(sessionId);
}

/** 是否处于临时联网窗口内（过期自动清理） */
export function isEgressAllowed(sessionId: string): boolean {
  const exp = allows.get(sessionId);
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    allows.delete(sessionId);
    return false;
  }
  return true;
}

/** 剩余秒数（0 = 未开启/已过期） */
export function egressAllowRemaining(sessionId: string): number {
  const exp = allows.get(sessionId);
  if (exp === undefined) return 0;
  const left = Math.max(0, Math.round((exp - Date.now()) / 1000));
  if (left === 0) allows.delete(sessionId);
  return left;
}

/** 会话结束清理（server/cli finally 挂接，与 clearSessionBypass 同模式） */
export function clearEgressAllowForSession(sessionId: string): void {
  allows.delete(sessionId);
}

/** 测试/调试：清空全部 */
export function resetEgressAllow(): void {
  allows.clear();
}
