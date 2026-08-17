/**
 * v3.1 审批流优化：会话级「已批准记忆」
 *
 * 痛点：smart（智能）档 medium 全部人工确认、confirm（全确认）档 low 也要确认——
 * Agent 多步任务里同一操作反复出现（如多次 npm install、反复写同一文件）时弹窗轰炸，
 * 直接拉低使用体验。opencode 用 allowedTools 持久白名单，InFu 已有命令白名单/工具覆盖，
 * 这里补**运行时记忆**：会话内用户批准过一次的操作，本会话后续同参出现直接放行。
 *
 * 安全边界：
 * - requireExplicit（联网放行/自注册/高危命令等安全红线）**永不记忆**——每次人工确认
 * - 记忆作用域 = 会话（sessionId 隔离），跨会话不记忆；CLI 直跑用 "cli" 桶
 * - 放行只影响弹窗，不影响命令审计（commands.log 照常全量记录）
 * - 有界：每会话最多 256 条，超出丢最旧（FIFO）
 */
export type ApprovalMemoryKey = string;

const MAX_ENTRIES_PER_SESSION = 256;
/** sessionId → 已批准 key 队列（数组尾部 = 最新；超出 FIFO 淘汰） */
const memory = new Map<string, string[]>();

/** 生成记忆键：命令类（run_command/run_test）按命令串，其余按 工具+风险+描述 */
export function approvalMemoryKey(tool: string, risk: string, description: string): ApprovalMemoryKey {
  if (tool === "run_command" || tool === "run_test") {
    return `${tool}|cmd|${description.trim()}`;
  }
  return `${tool}|${risk}|${description.trim()}`;
}

export function approvalRemembered(sessionId: string, key: ApprovalMemoryKey): boolean {
  const arr = memory.get(sessionId);
  return !!arr && arr.includes(key);
}

export function approvalRemember(sessionId: string, key: ApprovalMemoryKey): void {
  let arr = memory.get(sessionId);
  if (!arr) {
    arr = [];
    memory.set(sessionId, arr);
  }
  if (arr.includes(key)) return;
  arr.push(key);
  if (arr.length > MAX_ENTRIES_PER_SESSION) {
    arr.splice(0, arr.length - MAX_ENTRIES_PER_SESSION);
  }
}

/** 会话结束/删除时释放 */
export function clearApprovalMemory(sessionId: string): void {
  memory.delete(sessionId);
}

/** 测试/调试：清空全部 */
export function resetApprovalMemory(): void {
  memory.clear();
}