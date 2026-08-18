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
 *     后随符号（/ .）处无词边界，加 \b 会漏检）。
 *
 * 命中后统一走 high + requireExplicit（-y / auto 档 / 定时任务一律拒绝）。
 */

export const DANGEROUS =
  /(^|[^a-z])(rm|rmdir|rd|del)\s+[^\n]*?((-\S*[rfvq]\S*)|(--recursive|--force|--silent|--quiet)|\/[sqfr]+(\s+\/[sqfr]+)*)|\b(Remove-Item|ri)\b|\b(format\s+|mkfs|dd\s+if=)/i;