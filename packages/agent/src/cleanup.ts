/**
 * v3.5 数据生命周期：磁盘产物清理工具
 *
 * cleanupOldBackups：清理配置/注册表损坏时留下的损坏备份——
 * 这些备份是解析失败的抢救副本（内容多半已坏，保留价值低），超过保留期后删除，
 * 防 ~/.infu 下永久累积（备份文件命名形如 主文件.corrupt-时间戳 或 主文件.broken-时间戳）。
 */

import fs from "node:fs";
import path from "node:path";

/** 默认保留 7 天 */
export const BACKUP_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** 清理与主文件同目录的损坏备份（文件名 = 主文件 + 点 + 后缀；超期删除；失败静默） */
export function cleanupOldBackups(primaryFile: string, maxAgeMs = BACKUP_MAX_AGE_MS): void {
  try {
    const dir = path.dirname(primaryFile);
    const base = path.basename(primaryFile);
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(base + ".")) continue;
      const p = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
      } catch {
        /* 单个失败跳过 */
      }
    }
  } catch {
    /* 清理失败忽略 */
  }
}