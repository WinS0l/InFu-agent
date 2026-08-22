/**
 * v2.6 收尾新增 Git 工具（主流 coding agent 标配；补齐 status/diff 之外的提交链）
 * - git_log   只读：最近提交历史
 * - git_add   暂存文件（medium）
 * - git_commit 本地提交（high；绝不 push——推送由用户手动/外部流程完成）
 * - git_branch 查看/创建/切换分支
 * 安全边界：全部不执行 push/远程写操作；commit 前不自动 add（除非 all=true 显式声明）。
 */
import { z } from "zod";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef, ToolContext } from "@infu/shared";
import { sanitizeEnv } from "../sandbox/index.js";
import { clip, isPathInside } from "./util.js";

const execFileAsync = promisify(execFile);

/**
 * v3.1 审计修复：统一走 execFile 数组直传（不经过 shell）——原 runShell("git " + args)
 * 在 win32 走 cmd.exe，`\"` 转义对 cmd 无效，git_commit message / git_branch name 等
 * 参数可被 `" & <命令>` 注入执行任意命令（git_commit 为 low 免审批，高危）。
 * execFile 无 shell 无解释器，参数原样传递，注入面归零。
 */
async function gitRun(ctx: ToolContext, rel: unknown, args: unknown[]): Promise<{ ok: boolean; out: string; repo: boolean }> {
  if (typeof rel !== "string") {
    return { ok: false, out: "错误：path 参数必须是字符串。请重新调用本工具。", repo: false };
  }
  const valid: string[] = [];
  for (const a of args) {
    if (typeof a !== "string") {
      return { ok: false, out: `错误：git 参数包含非字符串值（${typeof a}）。请重新调用本工具并给出正确参数。`, repo: false };
    }
    valid.push(a);
  }
  const abs = path.resolve(ctx.root, rel || ".");
  // v3.4 审计修复（M12）：path 越界拦截——git_add/commit/branch 是写操作，
  // `git status` 前不加防护时 `../../external-repo` 会在项目根外的仓库执行
  // add/commit（外部仓库索引/HEAD 被改动）。与文件工具同款双检（词法 + realpath）。
  if (!isPathInside(ctx.root, abs)) {
    return { ok: false, out: `错误：path 越界——${abs} 不在项目根 ${ctx.root} 内。git 操作只能在项目内目录执行。`, repo: false };
  }
  try {
    const probe = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: abs, timeout: 15000, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: sanitizeEnv() });
    if (!/true/i.test(probe.stdout.trim())) {
      return { ok: false, out: `该目录不是 Git 仓库：${abs}`, repo: false };
    }
  } catch {
    return { ok: false, out: `该目录不是 Git 仓库：${abs}`, repo: false };
  }
  try {
    const r = await execFileAsync("git", valid, { cwd: abs, timeout: 60000, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: sanitizeEnv() });
    const body = [r.stdout, r.stderr].filter((s) => s.trim()).join("\n") || "(无输出)";
    return { ok: true, out: clip(body), repo: true };
  } catch (e: any) {
    const detail = [e.stderr, e.stdout, e.message ? String(e.message) : ""]
      .filter((s) => typeof s === "string" && s.trim())
      .join("\n")
      .trim();
    return { ok: false, out: `git 执行失败（code=${e.code ?? "?"}）：${clip(detail)}`, repo: true };
  }
}

/** 绝对路径 → 相对 root 显示 */
function relOf(ctx: ToolContext, abs: string): string {
  const root = path.resolve(ctx.root);
  return abs.startsWith(root) ? path.relative(root, abs) || "." : abs;
}

export const gitTools: Record<string, ToolDef> = {
  git_log: {
    name: "git_log",
    description:
      "查看 Git 提交历史（最近 N 条：哈希/分支标签/提交说明）。用于了解项目演进、定位最近改动。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
      count: z.number().int().min(1).max(50).optional().describe("查看条数（默认 15）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const count = (args.count as number | undefined) || 15;
      const r = await gitRun(ctx, rel, ["log", "--oneline", "--decorate", "-n", String(count)]);
      if (!r.repo) return r.out;
      return r.ok ? (r.out.trim() || "(无提交历史)") : r.out;
    },
  },

  git_add: {
    name: "git_add",
    description:
      "暂存文件改动（git add）。提交前先把改动加入暂存区；也可用 all=true 暂存全部改动。",
    // v2.10：暂存降 low（可回退，主流自动）
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("暂存目录（相对项目根，默认根）"),
      all: z.boolean().optional().describe("暂存全部改动（git add -A；默认 false 只暂存指定路径）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const all = args.all === true;
      // v2.13：git_add 补 guard（v2.10 已降 low——smart 档自动放行；confirm 档仍询问，与声明一致）
      const desc = `暂存改动${all ? "（全部）" : `：${relOf(ctx, path.resolve(ctx.root, rel))}`}`;
      if (!(await import("./util.js")).guard(ctx, "git_add", "low", desc)) return "用户拒绝：未暂存";
      const r = await gitRun(ctx, rel, all ? ["add", "-A"] : ["add", "-A", "--", rel]);
      if (!r.repo) return r.out;
      if (!r.ok) return r.out;
      // 成功时始终输出暂存消息（git 的 CRLF 等警告附加在后面，不吞成功信息）
      const notice = all ? `已暂存全部改动（${relOf(ctx, path.resolve(ctx.root, rel))}）` : `已暂存 ${relOf(ctx, path.resolve(ctx.root, rel))} 下的改动`;
      const warn = r.out.trim();
      return warn ? `${notice}\n${warn}` : notice;
    },
  },

  git_commit: {
    name: "git_commit",
    description:
      "创建本地提交（git commit）。只能提交**已暂存**的改动（先 git_add）；all=true 时自动暂存全部改动后提交。" +
      "绝不执行 push（推送请由用户手动完成）。",
    // v2.10：本地提交降 low（绝不 push；smart 档自动执行；confirm 档仍询问）
    risk: "low",
    schema: z.object({
      message: z.string().min(1).describe("提交说明（简洁描述本次改动）"),
      all: z.boolean().optional().describe("自动暂存全部改动后提交（git commit -am；默认 false 只提交已暂存内容）"),
      path: z.string().optional().describe("提交目录（相对项目根，默认根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      // 执行端参数防御（模型可能传错类型——友好报错让模型自纠）
      if (typeof args.message !== "string" || !args.message.trim()) {
        return "错误：message 参数必须是字符串。请重新调用并给出提交说明。";
      }
      const message = args.message as string;
      const desc = `创建本地提交：${message.slice(0, 120)}${args.all ? "（自动暂存全部改动）" : "（仅已暂存内容）"}`;
      if (!(await import("./util.js")).guard(ctx, "git_commit", "low", desc)) {
        return "用户拒绝：未提交";
      }
      const r = await gitRun(ctx, rel, args.all ? ["commit", "-am", message] : ["commit", "-m", message]);
      if (!r.repo) return r.out;
      if (!r.ok) {
        if (/nothing to commit|no changes added|no changes/i.test(r.out)) {
          return "没有可提交的改动（先 git_add 暂存，或设 all=true 自动暂存）";
        }
        return r.out;
      }
      const show = await gitRun(ctx, rel, ["log", "-1", "--oneline"]);
      return (show.ok ? show.out.trim() + "\n" : "") + "已创建本地提交（未推送；如需推送请手动执行 git push）";
    },
  },

  git_branch: {
    name: "git_branch",
    description:
      "查看/创建/切换 Git 分支。list=查看所有分支（含当前）；create=新建分支（不切换）；switch=切换分支（new=true 时创建并切换）。",
    risk: "low",
    schema: z.object({
      action: z.enum(["list", "create", "switch"]).optional().describe("操作（默认 list）"),
      name: z.string().min(1).optional().describe("分支名（create/switch 时需要）"),
      new: z.boolean().optional().describe("switch 时是否新建分支（git checkout -b）"),
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const action = (args.action as string | undefined) ?? "list";
      const name = args.name as string | undefined;
      if (action === "list") {
        const r = await gitRun(ctx, rel, ["branch", "-a"]);
        if (!r.repo) return r.out;
        const cur = await gitRun(ctx, rel, ["branch", "--show-current"]);
        return (cur.ok && cur.out.trim() ? `当前分支：${cur.out.trim()}\n` : "") + (r.ok ? r.out.trim() : r.out);
      }
      // 执行端参数防御（模型可能传错类型——友好报错让模型自纠）
      if (typeof name !== "string") return "错误：name 参数必须是字符串。请重新调用并给出分支名。";
      if (!name) return "错误：create/switch 需要提供 name";
      // 分支名安全校验（防注入：只允许 git ref 合法字符）
      if (!/^[A-Za-z0-9._\/-]+$/.test(name)) {
        return `错误：非法分支名 "${name}"（只允许字母数字 . _ / -）`;
      }
      if (action === "create") {
        if (!(await import("./util.js")).guard(ctx, "git_branch", "low", `创建分支：${name}`)) return "用户拒绝：未创建";
        const r = await gitRun(ctx, rel, ["branch", name]);
        if (!r.repo) return r.out;
        return r.ok ? `已创建分支 ${name}（未切换；git_branch switch 可切换）` : r.out;
      }
      // switch
      if (!(await import("./util.js")).guard(ctx, "git_branch", "low", `切换分支：${name}${args.new ? "（新建并切换）" : ""}`)) return "用户拒绝：未切换";
      const r = await gitRun(ctx, rel, args.new ? ["checkout", "-b", name] : ["checkout", name]);
      if (!r.repo) return r.out;
      return r.ok ? (r.out.trim() || `已切换到分支 ${name}`) : r.out;
    },
  },
};
