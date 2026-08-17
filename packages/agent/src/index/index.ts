/**
 * v2.7 索引库（轻量文件索引）——项目文件清单持久化，加速 search_code / 提供索引状态管理。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveDataDir } from "../data-dir.js";

export interface IndexEntry { file: string; size: number; mtime: number; }
export interface ProjectIndex { root: string; builtAt: number; files: IndexEntry[]; }
export interface IndexStatus {
  built: boolean;
  fileCount: number;
  builtAt: number | null;
  sizeBytes: number;
  path: string | null;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next",
  "coverage", "venv", ".venv", "__pycache__", ".cache", ".idea", ".vscode",
  ".infu", ".infu-sandbox", "target", ".turbo", ".yarn", ".pnpm-store"]);

function indexPath(root: string): string {
  const hash = crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12);
  const dir = path.join(resolveDataDir(), "index");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, hash + ".json");
}

/** 递归收集项目文件（跳过噪音目录；上限 20000） */
function collectFiles(root: string): IndexEntry[] {
  const results: IndexEntry[] = [];
  const stack = [root];
  while (stack.length && results.length < 20000) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          results.push({ file: path.relative(root, full).split(path.sep).join("/"), size: st.size, mtime: st.mtimeMs });
        } catch { /* 跳过不可读 */ }
      }
    }
  }
  results.sort((a, b) => a.file.localeCompare(b.file));
  return results;
}

/** 构建/重建索引（同步扫描 + 落盘） */
export function buildIndex(root: string): ProjectIndex {
  const files = collectFiles(root);
  const idx: ProjectIndex = { root: path.resolve(root), builtAt: Date.now(), files };
  fs.writeFileSync(indexPath(root), JSON.stringify(idx), "utf-8");
  return idx;
}

/** 加载索引（不存在/损坏返回 null） */
export function loadIndex(root: string): ProjectIndex | null {
  try {
    const raw = fs.readFileSync(indexPath(root), "utf-8");
    const idx = JSON.parse(raw) as ProjectIndex;
    if (!idx?.files || !Array.isArray(idx.files)) return null;
    return idx;
  } catch { return null; }
}

/** 索引状态（供设置界面展示） */
export function indexStatus(root: string): IndexStatus {
  const p = indexPath(root);
  try {
    const idx = loadIndex(root);
    if (!idx) return { built: false, fileCount: 0, builtAt: null, sizeBytes: 0, path: p };
    const sizeBytes = fs.statSync(p).size;
    return { built: true, fileCount: idx.files.length, builtAt: idx.builtAt, sizeBytes, path: p };
  } catch {
    return { built: false, fileCount: 0, builtAt: null, sizeBytes: 0, path: p };
  }
}

/** v3.5 数据生命周期：删除某 root 的索引文件（项目移除时清理孤儿索引；不存在静默） */
export function deleteIndex(root: string): void {
  try {
    fs.rmSync(indexPath(root), { force: true });
  } catch { /* 忽略 */ }
}
