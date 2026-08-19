/** Session-scoped, expiring recovery copies for file mutations. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDataDir } from "../data-dir.js";
import { isProtectedPath } from "../sandbox/index.js";

export const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Keep recovery useful without allowing a single mutation to exhaust the data volume. */
export const MAX_RECOVERY_ENTRY_BYTES = 512 * 1024 * 1024;

interface RecoveryEntry {
  id: string;
  sessionId: string;
  root: string;
  relativePath: string;
  createdAt: number;
  expiresAt: number;
}

function safeSessionId(sessionId: string | undefined): string {
  return (sessionId || "local").replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 100) || "local";
}

function sessionDir(sessionId: string | undefined): string {
  return path.join(resolveDataDir(), "recovery", safeSessionId(sessionId));
}

function entryPaths(sessionId: string | undefined, id: string) {
  const dir = path.join(sessionDir(sessionId), id);
  return { dir, meta: path.join(dir, "meta.json"), data: path.join(dir, "data") };
}

/** Remove expired recovery entries. Failures are intentionally non-fatal. */
export function cleanupRecovery(sessionId?: string, now = Date.now()): void {
  const dirs = sessionId === undefined
    ? (() => { try { return fs.readdirSync(path.join(resolveDataDir(), "recovery")); } catch { return []; } })()
    : [safeSessionId(sessionId)];
  for (const sid of dirs) {
    const base = path.join(resolveDataDir(), "recovery", sid);
    try {
      for (const id of fs.readdirSync(base)) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(base, id, "meta.json"), "utf-8")) as RecoveryEntry;
          if (!meta.expiresAt || meta.expiresAt <= now) fs.rmSync(path.join(base, id), { recursive: true, force: true });
        } catch {
          fs.rmSync(path.join(base, id), { recursive: true, force: true });
        }
      }
    } catch { /* missing/unreadable directory */ }
  }
}

function recoverySize(abs: string, limit: number): number | null {
  try {
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return stat.size <= limit ? stat.size : null;
    let total = 0;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = recoverySize(path.join(abs, ent.name), limit - total);
      if (child === null) return null;
      total += child;
    }
    return total;
  } catch {
    return null;
  }
}

/** Save an existing non-sensitive project path before it is overwritten or deleted. */
export function backupForRecovery(root: string, abs: string, relativePath: string, sessionId?: string): string | null {
  if (!fs.existsSync(abs) || isProtectedPath(abs)) return null;
  cleanupRecovery(sessionId);
  if (recoverySize(abs, MAX_RECOVERY_ENTRY_BYTES) === null) return null;
  const id = randomUUID();
  const target = entryPaths(sessionId, id);
  const now = Date.now();
  try {
    fs.mkdirSync(target.dir, { recursive: true });
    fs.cpSync(abs, target.data, { recursive: fs.statSync(abs).isDirectory(), force: true });
    const meta: RecoveryEntry = { id, sessionId: safeSessionId(sessionId), root: path.resolve(root), relativePath, createdAt: now, expiresAt: now + RECOVERY_TTL_MS };
    fs.writeFileSync(target.meta, JSON.stringify(meta), "utf-8");
    return id;
  } catch {
    fs.rmSync(target.dir, { recursive: true, force: true });
    return null;
  }
}

/** Restore one recovery entry to its original project-relative destination. */
export function restoreRecovery(root: string, id: string, sessionId?: string, canRestore?: (relativePath: string) => boolean): { ok: boolean; message: string; relativePath?: string } {
  cleanupRecovery(sessionId);
  if (!/^[a-f0-9-]{36}$/i.test(id)) return { ok: false, message: "恢复记录 id 无效" };
  const source = entryPaths(sessionId, id);
  try {
    const meta = JSON.parse(fs.readFileSync(source.meta, "utf-8")) as RecoveryEntry;
    const sameRoot = process.platform === "win32"
      ? path.resolve(root).toLowerCase() === meta.root.toLowerCase()
      : path.resolve(root) === meta.root;
    if (!sameRoot) return { ok: false, message: "恢复记录不属于当前项目根目录" };
    if (canRestore && !canRestore(meta.relativePath)) return { ok: false, message: "恢复目标超出当前路径作用域" };
    const dest = path.resolve(root, meta.relativePath);
    const rootResolved = path.resolve(root);
    const inside = process.platform === "win32"
      ? dest.toLowerCase() === rootResolved.toLowerCase() || dest.toLowerCase().startsWith(rootResolved.toLowerCase() + path.sep)
      : dest === rootResolved || dest.startsWith(rootResolved + path.sep);
    if (!inside || isProtectedPath(dest) || !fs.existsSync(source.data)) return { ok: false, message: "恢复记录不可用或目标不安全" };
    const replacedId = fs.existsSync(dest) ? backupForRecovery(root, dest, meta.relativePath, sessionId) : null;
    if (fs.existsSync(dest) && !replacedId) return { ok: false, message: "无法创建当前文件的恢复副本" };
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: fs.statSync(dest).isDirectory(), force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(source.data, dest, { recursive: fs.statSync(source.data).isDirectory(), force: true });
    return { ok: true, message: `已恢复：${meta.relativePath}${replacedId ? `（恢复前状态记录 ${replacedId}）` : ""}`, relativePath: meta.relativePath };
  } catch {
    return { ok: false, message: "恢复记录不存在、已过期或损坏" };
  }
}

/** Session deletion removes its recovery copies immediately. */
export function clearRecovery(sessionId: string): void {
  fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
}
