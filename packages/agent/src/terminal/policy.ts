/**
 * Web 交互式终端 — 命令策略（v2.4 批 2）
 *
 * 高危命令审批 + 全量审计（与 run_command 同安全红线）：
 *  - 终端是用户亲手输入：普通命令直接执行（无需审批，避免打断交互）
 *  - rm -rf / 格式化 / dd 等危险命令 → 未 confirmed 拒绝写入，前端弹确认框，人工批准后重发
 *  - 每条命令 auditCommand 落盘 commands.log（sandbox=terminal 标签）
 */

import { auditCommand } from "../sandbox/index.js";

/** 高危命令正则（与 run_command 的 DANGEROUS 一致：删除/强制/格式化类；
 *  注意：末尾无 \b——dd if=/…、mkfs.ext4 等后随符号（/ .）处无词边界，若加 \b 会漏检） */
export const DANGEROUS_TERMINAL = /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/f|format\s+|mkfs|dd\s+if=)/i;

/** 检测终端命令是否高危（返回命中片段；未命中返回 null） */
export function detectDangerousTerminalCommand(command: string): string | null {
  if (!command.trim()) return null;
  const m = DANGEROUS_TERMINAL.exec(command);
  return m ? m[0].trim() : null;
}

/** 审计终端命令（sandbox=terminal 标签；logPath 可注入测试临时目录） */
export function auditTerminalCommand(cwd: string, command: string, logPath?: string): void {
  if (!command.trim()) return;
  auditCommand(cwd, command, true, "terminal-user-input", "terminal", logPath);
}
