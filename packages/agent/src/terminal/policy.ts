/**
 * Web 交互式终端 — 命令策略（v2.4 批 2）
 *
 * 高危命令审批 + 全量审计（与 run_command 同安全红线）：
 *  - 终端是用户亲手输入：普通命令直接执行（无需审批，避免打断交互）
 *  - rm -rf / 格式化 / dd 等危险命令 → 未 confirmed 拒绝写入，前端弹确认框，人工批准后重发
 *  - 每条命令 auditCommand 落盘 commands.log（sandbox=terminal 标签）
 */

import { auditCommand } from "../sandbox/index.js";
import { DANGEROUS } from "../sandbox/dangerous.js";

/** 高危命令正则（与 run_command 的 DANGEROUS 同一实现——v3.4 审计修复 M2：
 *  多分支覆盖 rm -fr/Remove-Item -Recurse/del /s /q 等变体） */
export const DANGEROUS_TERMINAL = DANGEROUS;

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
