/**
 * v3.1 工具补齐（对齐 opencode 常用工具集）：
 * - project_tree：目录树（只读，进 Planner/Reviewer/explore 白名单——探索阶段先看整体结构）
 * - file_ops：文件管理（mv/cp/rm/mkdir，medium 审批——opencode file_ops 同款能力，
 *   InFu 此前只有 write/edit/read，缺文件级管理）
 */
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { ToolDef, ToolContext } from "@infu/shared";
import { isProtectedPath } from "../sandbox/index.js";
import { isPathInside, clip, guard, sessionRootReadOnlyBlock } from "./util.js";
import { checkPathScope } from "../memory/index.js";

/** 递归目录树（v3.1；跳过噪音目录，depth 限制，文件带大小） */
function renderTree(absRoot: string, depth: number): string {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next",
    "coverage", "venv", ".venv", "__pycache__", ".cache", ".idea", ".vscode",
    ".infu", ".infu-sandbox", "target", ".turbo", ".yarn", ".pnpm-store"]);
  const lines: string[] = [];
  const walk = (dir: string, prefix: string, level: number) => {
    if (level > depth) {
      lines.push(`${prefix}…（已达深度上限 ${depth}）`);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      // v6.0 S6 加固：目录树不显示符号链接/目录联接（防止指向项目外的链接误导/泄出结构）
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        lines.push(`${prefix}${ent.name}/`);
        walk(full, prefix + "  ", level + 1);
      } else if (ent.isFile()) {
        let size = "";
        try { size = ` (${fs.statSync(full).size} B)`; } catch { /* 忽略 */ }
        lines.push(`${prefix}${ent.name}${size}`);
      }
    }
  };
  walk(absRoot, "", 1);
  return lines.join("\n");
}

export const fsTools: Record<string, ToolDef> = {
  project_tree: {
    name: "project_tree",
    description: "输出项目目录树（只读）。探索项目结构的第一步：看到整体布局再决定读哪个文件。默认从项目根开始，深度 3（跳过 node_modules/.git/dist 等噪音目录）。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的起始目录（默认项目根）"),
      depth: z.number().int().min(1).max(6).optional().describe("递归深度（默认 3）"),
      max_files: z.number().int().min(1).max(500).optional().describe("最多列出的条目数（默认 200）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      if (!isPathInside(ctx.root, abs)) return "错误：路径越界";
      const scopeErr = checkPathScope(rel, ctx.scopeRules);
      if (scopeErr) return `错误：路径超出作用域——${scopeErr}`;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `错误：目录不存在 ${rel}`;
      const depth = (args.depth as number | undefined) || 3;
      const max = (args.max_files as number | undefined) || 200;
      const tree = renderTree(abs, depth).split("\n").slice(0, max);
      return `目录树 ${rel || "/"}（深度 ${depth}，最多 ${max} 项）：\n${tree.join("\n")}`;
    },
  },

  file_ops: {
    name: "file_ops",
    description:
      "文件系统操作：移动/复制/重命名/删除/创建目录。op = mv|cp|rm|mkdir；rm 只接受项目内的文件或目录（目录递归删除，谨慎）；mv/cp 目标必须在项目内。越界/受保护路径（~/.ssh 等）一律拒绝。",
    risk: "medium",
    schema: z.object({
      op: z.enum(["mv", "cp", "rm", "mkdir"]).describe("操作：mv 移动/重命名、cp 复制、rm 删除、mkdir 创建目录"),
      path: z.string().describe("源路径（相对项目根）"),
      dest: z.string().optional().describe("目标路径（mv/cp 必填；相对项目根）"),
      recursive: z.boolean().optional().describe("rm/cp 目录时是否递归（默认 false；目录必须 true 否则报错）"),
    }),
    async execute(args, ctx) {
      const op = args.op as string;
      const rel = args.path as string;
      const destRel = args.dest as string | undefined;
      const abs = path.resolve(ctx.root, rel);
      if (!isPathInside(ctx.root, abs)) return "错误：源路径越界";
      const scopeErr = checkPathScope(rel, ctx.scopeRules);
      if (scopeErr) return `错误：路径超出作用域——${scopeErr}`;
      const protectedName = isProtectedPath(abs);
      if (protectedName) return `错误：${protectedName} 受保护，拒绝写操作`;
      // v4.0 审计修复（M4）：递归删除与 run_command `rm -rf` 红线对齐——
      // 原实现 rm 目录递归仅 medium（auto 档自动放行 = 免红线删光项目），
      // 现升级为 high + requireExplicit（无人值守/auto 档一律拒绝），与
      // run_command DANGEROUS 分支同门槛；普通文件删除/移动/复制保持 medium。
      const isRecursiveRm = op === "rm" && fs.existsSync(abs) && fs.statSync(abs).isDirectory() && args.recursive === true;
      if (!(await guard(ctx, "file_ops", isRecursiveRm ? "high" : "medium", `文件操作 ${op}: ${rel}${destRel ? ` → ${destRel}` : ""}`, isRecursiveRm ? true : undefined))) {
        return "用户拒绝：文件操作未执行";
      }
      const roBlock = sessionRootReadOnlyBlock(ctx);
      if (roBlock) return `错误：${roBlock}`;

      if (op === "mkdir") {
        if (fs.existsSync(abs)) return `已存在：${rel}`;
        try {
          fs.mkdirSync(abs, { recursive: true });
          return `已创建目录：${rel}`;
        } catch (e) {
          return `创建失败：${(e as Error).message}`;
        }
      }

      if (!fs.existsSync(abs)) return `错误：源不存在 ${rel}`;
      const stat = fs.statSync(abs);

      if (op === "rm") {
        if (stat.isDirectory() && args.recursive !== true) {
          return `错误：${rel} 是目录——删除目录需 recursive=true（会递归删除全部内容）`;
        }
        try {
          fs.rmSync(abs, { recursive: stat.isDirectory(), force: true });
          return `已删除：${rel}`;
        } catch (e) {
          return `删除失败：${(e as Error).message}`;
        }
      }

      if (op === "mv" || op === "cp") {
        if (!destRel) return "错误：mv/cp 需要 dest 目标路径";
        const destAbs = path.resolve(ctx.root, destRel);
        if (!isPathInside(ctx.root, destAbs)) return "错误：目标路径越界";
        const destScopeErr = checkPathScope(destRel, ctx.scopeRules);
        if (destScopeErr) return `错误：目标超出作用域——${destScopeErr}`;
        const destProtected = isProtectedPath(destAbs);
        if (destProtected) return `错误：目标 ${destProtected} 受保护，拒绝写操作`;
        if (stat.isDirectory() && args.recursive !== true && op === "cp") {
          return `错误：复制目录需 recursive=true`;
        }
        try {
          if (op === "mv") {
            fs.mkdirSync(path.dirname(destAbs), { recursive: true });
            fs.renameSync(abs, destAbs);
          } else {
            fs.mkdirSync(path.dirname(destAbs), { recursive: true });
            fs.cpSync(abs, destAbs, { recursive: stat.isDirectory() });
          }
          return `已${op === "mv" ? "移动/重命名" : "复制"}：${rel} → ${destRel}`;
        } catch (e) {
          return `${op} 失败：${(e as Error).message}`;
        }
      }
      return `错误：未知操作 ${op}`;
    },
  },
};