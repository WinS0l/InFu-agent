/**
 * 高危命令检测（v3.1 起 run_command / run_test / terminal 共用同一门槛；
 * v3.4 审计修复 M2：原单一拼接正则漏检大量破坏性变体——`rm -fr`/`rm -f -r`/
 * `rm -rfv`/`rm --recursive --force`（顺序/组合变体）、`del /s /q`/`rd /s /q`
 * （参数顺序变体）、PowerShell `Remove-Item -Recurse -Force`。
 *
 * 多分支设计：
 *  ① `(^|[^a-z])(rm|rmdir|rd|del)\s+[^\n]*?((-\S*[rfvq]\S*)|(--recursive|--force|--silent|--quiet)|\/[sqfr]+(\s+\/[sqfr]+)*)`
 *    ——删除类命令出现递归/强制/静默标志即高危：连续标志组（rm -rf / rm -fr / rm -rfv /
 *    del /sq）与分开标志（rm -r -f / del /s /q / rm -f -r，v3.9 审计修复 M-低危——
 *    原实现只匹配连续标志组，`rm -r -f x` 全档免审批执行）均命中；
 *  ② `\bRemove-Item\b` ——PowerShell 删除命令（-Recurse/-Force 任意组合）；
 *  ③ `format | mkfs | dd if=` ——格式化/写盘类（末尾无 \b：dd if=/…、mkfs.ext4
 *     后随符号（/ .）处无词边界，加 \b 会漏检）；
 *  ④ `git clean -f*`/`--force`、`erase /s` ——git clean 带 -f/-x/-d 清未跟踪文件、
 *     cmd erase 别名（del 同族）与 rm 同门槛。
 *
 * 命中后统一走 high + requireExplicit（-y / auto 档 / 定时任务一律拒绝）。
 */

export const DANGEROUS =
  /(^|[^a-z])(rm|rmdir|rd|del|erase)(?:\s+|(?=\/))[^\n]*?((-\S*[rfvq]\S*)|(--recursive|--force|--silent|--quiet)|\/[sqfr]+(?:\s*\/[sqfr]+)*)|\b(Remove-Item|ri)\b|\b(format\s+|mkfs|dd\s+if=)|\bgit clean\b[^\n]*?(-f|--force)/i;

/**
 * 审计修复：语言运行时绕过——DANGEROUS 只匹配 shell 级语法，
 * `node -e "require('fs').rmSync('x',{recursive:true})"` /
 * `python -c "import shutil; shutil.rmtree('x')"` 不命中（此前仅 medium，
 * auto 档自动放行 = 免红线删空项目/目录）。
 * 识别解释器内嵌执行（-e/-c/-Command/-r 等）后扫描破坏性调用载荷；
 * `-EncodedCommand`（Base64）无法静态验证载荷 → 一律高危。
 */
const INTERPRETER_RUN = /\b(node|nodejs|python|python3|py|perl|ruby|php|powershell|pwsh|sh|bash|cmd|deno|bun)\s+(-e|-c|\/c|-Command|-command|-r|-R|-EncodedCommand|-enc)\s*/i;
const DESTRUCTIVE_CALLS =
  /rmSync\s*\(|rmdirSync\s*\(|promises?\.rm\s*\(|removeSync\s*\(|unlinkSync\s*\(|shutil\.rmtree\s*\(|os\.remove\s*\(|Remove-Item|Remove-Folder|rm\s+-rf|del\s+\/s|rd\s+\/s|drop\s+(table|database)/i;

/** 解释器载荷是否含破坏性调用（-e/-c 等内嵌代码形态） */
export function hasDestructiveRuntimePayload(command: string): boolean {
  const m = INTERPRETER_RUN.exec(command);
  if (!m) return false;
  const flag = m[2].toLowerCase();
  // Base64 编码载荷无法静态验证——无法证明安全即按高危处理（外传面 net-policy 同样拦）
  if (flag === "-enc" || flag === "-encodedcommand") return true;
  return DESTRUCTIVE_CALLS.test(command);
}

/** 高危命令判定（shell 语法 + 语言运行时载荷两个通道；run_command/run_test/terminal 共用） */
export function isDangerousCommand(command: string): boolean {
  if (DANGEROUS.test(command)) return true;
  return hasDestructiveRuntimePayload(command);
}
