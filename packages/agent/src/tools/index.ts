/**
 * InFu 基础工具系统 — PRD 一期 10 个基础工具
 * 基础层：文件 / 终端 / Git；工程层工具（测试）前置基础版
 */

import { z } from "zod";
import { exec, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { ToolDef, ToolContext, RiskLevel } from "@infu/shared";
import {
  sanitizeEnv, isProtectedPath, auditCommand, dockerAvailable, buildDockerArgs,
  resolveSandboxMode, resolveEffectiveMode, type SandboxMode,
} from "../sandbox/index.js";
import {
  winRestrictedAvailable, runRestricted, type RestrictedRunResult,
} from "../sandbox/win-restricted.js";
import { detectEgress, egressBlockedMessage } from "../sandbox/net-policy.js";
import { registerMcpServer, type RegisterInput } from "../mcp/register.js";
import { registerPlugin, type RegisterPluginInput } from "../plugin/register.js";
import { listSkills, readSkillContent } from "../plugin/skills.js";
import { loadConfig } from "../providers/registry.js";
import {
  currentApprovalPolicy, isToolDisabled, resolveToolRisk, shouldAutoApprove, isCommandAllowed,
} from "../approval/policy.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** 输出截断上限（防止结果撑爆上下文） */
const MAX_OUTPUT = 12000;
const MAX_FILE_READ = 512 * 1024; // 512KB

/** 工具结果截断 */
function clip(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...（已截断，共 ${s.length} 字符）`;
}

/** 命令输出格式化 */
function fmtOut(o: { stdout: string; stderr: string }, ok: boolean): string {
  const parts: string[] = [];
  if (o.stdout.trim()) parts.push(o.stdout.trim());
  if (o.stderr.trim()) parts.push(`[stderr] ${o.stderr.trim()}`);
  const body = parts.join("\n") || "(无输出)";
  return ok ? clip(body) : `命令执行失败：\n${clip(body)}`;
}

/** 执行 shell 命令（win32 自动选 shell；默认使用消毒后的环境变量） */
async function runShell(
  command: string,
  cwd: string,
  timeoutMs = 60000,
  env: NodeJS.ProcessEnv = sanitizeEnv()
): Promise<{ ok: boolean; out: string; code: number | null }> {
  // 先检查工作目录，给出明确错误而不是神秘失败
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return { ok: false, out: `目录不存在: ${cwd}`, code: null };
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      env,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, out: fmtOut({ stdout, stderr }, true), code: 0 };
  } catch (e: any) {
    const code = e.code ?? e.status ?? null;
    // 关键：错误详情必须透出（目录不存在/找不到命令/退出码），不要吞掉
    const detail = [e.stderr, e.stdout, e.message ? String(e.message) : ""]
      .filter((s) => typeof s === "string" && s.trim())
      .join("\n")
      .trim();
    return {
      ok: false,
      out: detail
        ? `命令执行失败（code=${code}）：\n${clip(detail)}`
        : `命令执行失败（code=${code}）`,
      code,
    };
  }
}

/** Docker 沙箱执行命令（默认断网、只读挂载、资源限制、任务后销毁） */
async function runInDocker(command: string, root: string, timeoutMs = 120000): Promise<{ ok: boolean; out: string; code: number | null }> {
  try {
    const args = buildDockerArgs(root, command);
    const { stdout, stderr } = await execFileAsync("docker", args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: sanitizeEnv(), // 凭据不进容器
    });
    return { ok: true, out: fmtOut({ stdout, stderr }, true), code: 0 };
  } catch (e: any) {
    const code = e.code ?? e.status ?? null;
    const detail = [e.stderr, e.stdout, e.message ? String(e.message) : ""]
      .filter((s) => typeof s === "string" && s.trim())
      .join("\n")
      .trim();
    return {
      ok: false,
      out: detail
        ? `沙箱执行失败（code=${code}）：\n${clip(detail)}`
        : `沙箱执行失败（code=${code}）`,
      code,
    };
  }
}

/** 沙箱档位解析（v2.4：config.sandbox.mode 优先于环境变量；auto 按可用性选择 docker → win 受限 → 软沙箱） */
async function getSandboxMode(): Promise<SandboxMode> {
  const requested = resolveSandboxMode(process.env, loadConfig());
  // 受限可用性统一检查（含 INFU_SANDBOX_RESTRICTED=0 强制禁用；有会话级缓存）
  const winRestrictedOk = process.platform === "win32" && (await winRestrictedAvailable());
  if (requested === "auto") {
    return resolveEffectiveMode(requested, {
      dockerOk: await dockerAvailable(),
      winRestrictedOk,
      platform: process.platform,
    });
  }
  return resolveEffectiveMode(requested, { dockerOk: false, winRestrictedOk, platform: process.platform });
}

/** 受限执行结果 → 标准输出格式（level/net 映射为模式标签；退出码 0 才算成功，与 Node exec 语义一致） */
function fmtRestricted(r: RestrictedRunResult): { out: string; ok: boolean; code: number | null; sandbox: string } {
  const ok = r.ok && !r.timedOut && r.code === 0;
  const body = [r.stdout, r.stderr]
    .filter((s) => s.trim())
    .join(r.stdout.trim() && r.stderr.trim() ? "\n[stderr] " : "\n")
    .trim();
  const out = ok
    ? clip(body || "(无输出)")
    : `命令执行失败（code=${r.code}${r.timedOut ? "，超时被终止" : ""}）：\n${clip(body)}`;
  // 令牌等级映射为模式标签
  const sandbox =
    r.level === "job-only" ? "restricted:job-only"
    : r.level === "none" ? "soft"
    : "restricted";
  return { out, ok, code: r.code, sandbox };
}

/**
 * 本地命令统一分派：Docker(L2) → 受限沙箱(L1.5，win32 硬沙箱) → 软沙箱(L1)
 * run_command 与 run_test 共用（修复 run_test 绕过沙箱的历史缺口）。
 * v2.4 档位语义：显式 soft = 纯软沙箱（不再隐式 L1.5）；显式 restricted 不可用时降级 soft；
 * 显式 docker 不可用时报错（不静默降级）；auto 按可用性自动选择。
 * 网络出站控制为命令级策略（net-policy.ts，M6 软控制收尾）：
 * 外传命令在 run_command/run_test 入口拦截，不进入本分派。
 * 返回 sandbox 标签用于审计与展示。
 */
async function execLocal(
  command: string,
  cwd: string,
  timeoutMs = 60000
): Promise<{ ok: boolean; out: string; code: number | null; sandbox: string }> {
  const mode = await getSandboxMode();
  if (mode === "docker") {
    const r = await runInDocker(command, cwd, timeoutMs);
    return { ...r, sandbox: "docker" };
  }
  if (mode === "off") {
    const r = await runShell(command, cwd, timeoutMs);
    return { ...r, sandbox: "off" };
  }
  if (mode === "restricted") {
    const r = await runRestricted(command, cwd, timeoutMs, sanitizeEnv());
    if (r) return fmtRestricted(r);
    // native 异常 → 降级软沙箱（下面统一处理）
  }
  // soft / 降级：纯软沙箱（L1，不隐式走 L1.5）
  const r = await runShell(command, cwd, timeoutMs);
  return { ...r, sandbox: "soft" };
}

/** 沙箱标签 → 展示文本 */
function sandboxTag(sandbox: string): string {
  switch (sandbox) {
    case "docker": return "（Docker 沙箱）";
    case "restricted": return "（受限沙箱）";
    case "restricted:job-only": return "（受限沙箱·仅Job）";
    case "off": return "（直连）";
    default: return "（软沙箱）";
  }
}

/** 递归遍历（跳过常见噪音目录），返回匹配文件列表 */
function walkFiles(root: string, maxFiles = 2000): string[] {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next",
    "coverage", "venv", ".venv", "__pycache__", ".cache", ".idea", ".vscode",
    ".infu", ".infu-sandbox", "target", ".turbo", ".yarn", ".pnpm-store"]);
  const results: string[] = [];
  const stack = [root];
  while (stack.length && results.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP.has(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * 审批辅助（v2.4 策略化）：按配置档位与工具覆盖决策——
 * 工具级覆盖先应用（禁用拦截/风险覆盖），再按档位（auto 放行 / confirm 全人工 / smart low 放行）。
 * requireExplicit（联网放行/自注册等安全线）任何档位下都需人工确认。
 * 禁用工具的准确文案由 loop 执行段统一拦截；此处为直调兜底（返回 false）。
 */
async function guard(
  ctx: ToolContext,
  tool: string,
  risk: RiskLevel,
  description: string,
  requireExplicit?: boolean
): Promise<boolean> {
  const policy = currentApprovalPolicy();
  if (isToolDisabled(tool, policy.toolOverrides)) return false;
  const effectiveRisk = resolveToolRisk(tool, risk, policy.toolOverrides);
  const auto = shouldAutoApprove(policy, effectiveRisk, requireExplicit);
  if (auto === true) return true;
  return ctx.requestApproval(description, effectiveRisk, requireExplicit);
}

// ─────────────────────────── 工具定义 ───────────────────────────

export const TOOLS: Record<string, ToolDef> = {
  read_file: {
    name: "read_file",
    description:
      "读取文件内容。用于查看源代码、配置、文档。返回纯文本；二进制或超大文件会被截断。",
    risk: "low",
    schema: z.object({
      path: z.string().describe("相对项目根的文件路径"),
      offset: z.number().int().min(0).optional().describe("起始行（从 0 开始，默认 0）"),
      limit: z.number().int().min(1).max(500).optional().describe("最多读取行数（默认 200）"),
    }),
    async execute(args, ctx) {
      const rel = args.path as string;
      const abs = path.resolve(ctx.root, rel);
      if (!abs.startsWith(path.resolve(ctx.root))) return "错误：路径越界（不允许访问项目根之外）";
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `错误：文件不存在 ${rel}`;
      if (fs.statSync(abs).size > MAX_FILE_READ) return `错误：文件过大（>${MAX_FILE_READ} 字节），请用 search_code 定位相关内容`;
      const all = fs.readFileSync(abs, "utf-8").split("\n");
      const offset = (args.offset as number) || 0;
      const limit = (args.limit as number) || 200;
      const lines = all.slice(offset, offset + limit);
      const head = `文件 ${rel}（共 ${all.length} 行，显示 ${offset + 1}-${offset + lines.length} 行）`;
      return clip(
        head + "\n```\n" + lines.map((l, i) => `${offset + i + 1}\t${l}`).join("\n") + "\n```"
      );
    },
  },

  write_file: {
    name: "write_file",
    description:
      "写入文件（覆盖）。创建新文件或整体重写已有文件。注意：此操作会覆盖目标文件，需用户确认。",
    risk: "medium",
    schema: z.object({
      path: z.string().describe("相对项目根的文件路径"),
      content: z.string().describe("完整文件内容"),
    }),
    async execute(args, ctx) {
      const rel = args.path as string;
      const abs = path.resolve(ctx.root, rel);
      if (!abs.startsWith(path.resolve(ctx.root))) return "错误：路径越界（不允许访问项目根之外）";
      // 敏感路径写保护（沙箱 L1）
      const protectedName = isProtectedPath(abs);
      if (protectedName) {
        return `错误：目标路径位于受保护区域（${protectedName}），拒绝写入——Agent 没有修改 SSH 密钥/凭据/配置的合法场景`;
      }
      const desc = `写入文件 ${rel}（${(args.content as string).length} 字符）`;
      if (!(await guard(ctx, "write_file", "medium", desc))) return "用户拒绝：未写入";
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content as string, "utf-8");
      const lines = (args.content as string).split("\n").length;
      return `已写入 ${rel}（${(args.content as string).length} 字符，${lines} 行）`;
    },
  },

  edit_file: {
    name: "edit_file",
    description:
      "精确替换文件中的一段文本（第一次匹配）。用于局部修改，比 write_file 更安全。",
    risk: "medium",
    schema: z.object({
      path: z.string().describe("相对项目根的文件路径"),
      old_text: z.string().describe("被替换的原文（必须与文件内容完全一致）"),
      new_text: z.string().describe("替换后的新文本"),
    }),
    async execute(args, ctx) {
      const rel = args.path as string;
      const abs = path.resolve(ctx.root, rel);
      if (!abs.startsWith(path.resolve(ctx.root))) return "错误：路径越界";
      const protectedName = isProtectedPath(abs);
      if (protectedName) {
        return `错误：目标路径位于受保护区域（${protectedName}），拒绝修改`;
      }
      if (!fs.existsSync(abs)) return `错误：文件不存在 ${rel}`;
      const content = fs.readFileSync(abs, "utf-8");
      const oldText = args.old_text as string;
      if (!content.includes(oldText)) {
        return "错误：未找到匹配的原文（old_text 与文件内容不一致），请先 read_file 确认";
      }
      const desc = `修改文件 ${rel}（替换 ${oldText.length} 字符）`;
      if (!(await guard(ctx, "edit_file", "medium", desc))) return "用户拒绝：未修改";
      const updated = content.replace(oldText, args.new_text as string);
      fs.writeFileSync(abs, updated, "utf-8");
      // 行数 diff 统计（+N -M 行）
      const oldLines = oldText.split("\n").length;
      const newLines = (args.new_text as string).split("\n").length;
      const added = newLines > oldLines ? newLines - oldLines : 0;
      const removed = oldLines > newLines ? oldLines - newLines : 0;
      return `已修改 ${rel}（${added > 0 ? `+${added} ` : ""}${removed > 0 ? `-${removed} ` : ""}行）`;
    },
  },

  search_code: {
    name: "search_code",
    description:
      "在项目内搜索代码/文本（正则，忽略 node_modules/.git/dist 等目录）。返回文件:行号:内容。",
    risk: "low",
    schema: z.object({
      pattern: z.string().describe("正则表达式"),
      include: z.array(z.string()).optional().describe("只搜索匹配的文件扩展名，如 ['.ts', '.tsx']"),
      max_results: z.number().int().min(1).max(100).optional().describe("最大结果数（默认 30）"),
    }),
    async execute(args, ctx) {
      const re = new RegExp(args.pattern as string);
      const include = (args.include as string[] | undefined) || null;
      const max = (args.max_results as number | undefined) || 30;
      const hits: string[] = [];
      for (const file of walkFiles(ctx.root)) {
        if (include && !include.some((ext) => file.endsWith(ext))) continue;
        if (hits.length >= max) break;
        try {
          const lines = fs.readFileSync(file, "utf-8").split("\n");
          for (let i = 0; i < lines.length && hits.length < max; i++) {
            if (re.test(lines[i])) {
              hits.push(`${path.relative(ctx.root, file)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
            }
          }
        } catch {
          /* 二进制/不可读跳过 */
        }
      }
      if (!hits.length) return `未找到匹配 "${args.pattern}"`;
      return `找到 ${hits.length} 处：\n${hits.join("\n")}`;
    },
  },

  list_directory: {
    name: "list_directory",
    description: "列出目录内容（不递归）。显示文件/目录/大小。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的目录（默认项目根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      if (!abs.startsWith(path.resolve(ctx.root))) return "错误：路径越界";
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `错误：目录不存在 ${rel}`;
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const lines = entries.map((e) => {
        const full = path.join(abs, e.name);
        if (e.isDirectory()) return `[dir]  ${e.name}/`;
        if (e.isFile()) {
          const size = fs.statSync(full).size;
          return `[file] ${e.name}  (${size} B)`;
        }
        return `[link] ${e.name}`;
      });
      return `目录 ${rel || "/"}（${entries.length} 项）：\n${lines.join("\n")}`;
    },
  },

  run_command: {
    name: "run_command",
    description:
      "在项目内执行 shell 命令（终端执行）。可运行构建、安装依赖、启动服务、查看环境等。高风险命令（删除/强制操作）需确认。需要网络（如 npm install）时设 network=true，须人工审批放行（默认断网执行）。",
    risk: "medium",
    schema: z.object({
      command: z.string().describe("要执行的命令"),
      timeout: z.number().int().min(1000).max(300000).optional().describe("超时毫秒（默认 60000）"),
      network: z.boolean().optional().describe("是否允许联网（默认 false=断网执行；true 需人工审批，自动批准模式不适用）"),
    }),
    async execute(args, ctx) {
      const command = args.command as string;
      const wantNetwork = args.network === true;
      // 断网策略（M6 软控制）：外传命令必须 network=true 且审批放行，否则拦截（默认断网语义）
      const egress = detectEgress(command);
      if (egress && !wantNetwork) {
        const msg = egressBlockedMessage(egress);
        auditCommand(ctx.root, command, false, msg, "egress-blocked");
        return `${msg}\n（受限沙箱·断网策略）`;
      }

      let netAllowed = false;
      if (wantNetwork) {
        // 联网必须人工审批（🌐 标记 + requireExplicit：-y 自动批准也不放行；白名单不豁免联网）
        netAllowed = await guard(ctx, "run_command", "high", `🌐 联网放行执行命令：${command}`, true);
        if (!netAllowed && egress) {
          // 外传命令未获联网放行 → 断网策略拦截（不执行）
          const msg = egressBlockedMessage(egress);
          auditCommand(ctx.root, command, false, msg, "egress-blocked");
          return `${msg}\n⚠ 联网审批被拒绝（断网策略）`;
        }
      } else {
        // 常规审批（高危命令 high；其余 medium）；命令白名单（v2.4 设置）命中的命令跳过高危审批
        const policy = currentApprovalPolicy();
        // 末尾无 \b：dd if=/…、mkfs.ext4 后随符号（/ .）处无词边界，加 \b 会漏检
        const DANGEROUS = /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/f|format\s+|mkfs|dd\s+if=)/i;
        if (DANGEROUS.test(command) && !isCommandAllowed(command, policy.commandAllowlist)) {
          if (!(await guard(ctx, "run_command", "high", `执行高风险命令：${command}`))) {
            return "用户拒绝：高危命令未执行";
          }
        } else if (!(await guard(ctx, "run_command", "medium", `执行命令：${command}`))) {
          return "用户拒绝：命令未执行";
        }
      }
      const timeoutMs = (args.timeout as number | undefined) || 60000;

      // 沙箱统一分派（docker / 受限沙箱 / 软沙箱）
      const r = await execLocal(command, ctx.root, timeoutMs);
      const netNote = wantNetwork && !netAllowed ? "\n⚠ 该命令未获联网放行（断网执行）" : "";
      const netTag = netAllowed ? "（联网放行）" : "";

      // 命令审计（所有模式，含沙箱档位）
      auditCommand(ctx.root, command, r.ok, r.out, r.sandbox);
      return r.out + netNote + (r.ok ? `\n${sandboxTag(r.sandbox)}${netTag}执行完成` : `\n${sandboxTag(r.sandbox)}${netTag}`);
    },
  },

  // ── v2.3 MCP 自注册（opencode config-hook 模式 → 受控工具 + 人工审批）──
  // 只允许追加 mcpServers 节（models/providers/roles/apiKey 不可达）；high + requireExplicit
  // 审批（-y 也不放行）；仅 Executor/直接模式注入（Planner/Reviewer 只读白名单不含）
  mcp_register: {
    name: "mcp_register",
    description:
      "注册一个 MCP 服务器到 InFu 全局配置（~/.infu/config.json 的 mcpServers 节，需人工审批）。" +
      "注册后下一任务执行阶段自动注入该服务器的工具（默认 medium 审批，可用 riskOverrides 覆盖）。" +
      "用途：给 InFu 自己扩展工具生态——按官方文档实现并自测一个 MCP server 后，用它注册启用。",
    risk: "high",
    schema: z.object({
      name: z.string().describe("服务器显示名称（如 filesystem；id 由其自动生成）"),
      type: z.enum(["stdio", "http"]).optional().describe("传输类型：stdio=本地命令；http=远程端点（默认 stdio）"),
      command: z.string().optional().describe("stdio 模式启动命令（Windows 下 npx 需写 npx.cmd）"),
      args: z.array(z.string()).optional().describe("stdio 模式命令参数"),
      url: z.string().optional().describe("http 模式端点 URL"),
      riskOverrides: z
        .record(z.string(), z.enum(["low", "medium", "high"]))
        .optional()
        .describe("风险覆盖：工具名或前缀* → 级别；未覆盖的工具默认 medium 审批"),
    }),
    async execute(args, ctx) {
      // 写配置 = 持久化副作用 + 影响后续任务工具面：high 级 + requireExplicit（-y 也不放行）
      const desc = `注册 MCP 服务器「${args.name}」（${(args.type as string) ?? "stdio"}）到全局配置：\n${JSON.stringify(args, null, 2)}`;
      if (!(await guard(ctx, "mcp_register", "high", desc, true))) {
        return "用户拒绝：未注册（MCP 服务器注册需人工确认）";
      }
      const r = registerMcpServer(args as unknown as RegisterInput);
      return r.ok ? r.message : `错误：${r.message}`;
    },
  },

  // ── v2.3 批 2 插件自注册（与 mcp_register 同模式：high + requireExplicit + 白名单写 plugins 节）──
  plugin_add: {
    name: "plugin_add",
    description:
      "注册一个 JS/TS 插件到 InFu 全局配置（~/.infu/config.json 的 plugins 节，需人工审批）。" +
      "插件 = 可注册 工具/钩子（preToolUse/postToolUse）/技能目录 的模块（默认导出 {id, name, description, tools?, hooks?, skills?}）。" +
      "注册后下一任务执行阶段自动加载其工具与钩子。用途：给 InFu 自己扩展能力（注意插件代码在 Agent 进程内运行，配置即信任）。",
    risk: "high",
    schema: z.object({
      id: z.string().describe("插件标识（如 my-tools；自动规范化）"),
      path: z.string().describe("插件模块的绝对路径（.ts/.mjs/.js，默认导出 PluginDef）"),
    }),
    async execute(args, ctx) {
      const desc = `注册插件「${args.id}」（${args.path}）到全局配置：\n${JSON.stringify(args, null, 2)}`;
      if (!(await guard(ctx, "plugin_add", "high", desc, true))) {
        return "用户拒绝：未注册（插件注册需人工确认）";
      }
      const r = registerPlugin(args as unknown as RegisterPluginInput);
      return r.ok ? r.message : `错误：${r.message}`;
    },
  },

  // ── v2.3 批 2 skill 激活层（SKILL.md 社区标准：描述常驻 system，此处读全文注入）──
  use_skill: {
    name: "use_skill",
    description:
      "读取一个技能（SKILL.md）的完整内容。任务与「可用技能」列表（system 中列出 name+description）匹配时调用本工具，获取该技能的完整工作说明后按其执行。",
    risk: "low",
    schema: z.object({
      name: z.string().describe("技能名（与可用技能列表中的 name 一致）"),
    }),
    async execute(args, ctx) {
      const name = String(args.name ?? "").trim();
      if (!name) return "错误：name 不能为空";
      const skills = listSkills(loadConfig(), ctx.root);
      const meta = skills.find((s) => s.name === name);
      if (!meta) {
        const available = skills.map((s) => s.name).join("、");
        return `错误：未找到技能 "${name}"（可用技能：${available || "无"}）`;
      }
      return readSkillContent(meta);
    },
  },

  git_status: {
    name: "git_status",
    description: "查看 Git 仓库状态（当前分支 + 变更文件）。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      const r = await runShell("git status --short --branch", abs);
      if (!r.ok) {
        if (/not a git repository/i.test(r.out)) return `该目录不是 Git 仓库：${abs}`;
        return r.out; // 其他错误（目录不存在/找不到 git）直接透出真实原因
      }
      return r.out;
    },
  },

  git_diff: {
    name: "git_diff",
    description: "查看 Git 工作区改动（diff）。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
      staged: z.boolean().optional().describe("查看暂存区 diff（默认 false 看工作区）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      const r = await runShell(args.staged ? "git diff --staged --stat && git diff --staged" : "git diff --stat && git diff", abs);
      if (!r.ok) {
        if (/not a git repository/i.test(r.out)) return `该目录不是 Git 仓库：${abs}`;
        return r.out;
      }
      return r.out || "(无改动)";
    },
  },

  run_test: {
    name: "run_test",
    description: "运行项目测试。自动检测测试框架（npm test / pytest / go test 等），或执行指定命令。",
    risk: "medium",
    schema: z.object({
      command: z.string().optional().describe("自定义测试命令（默认自动检测）"),
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      const explicit = args.command as string | undefined;
      let cmd = explicit;
      if (!cmd) {
        if (fs.existsSync(path.join(abs, "package.json"))) {
          // npm test 自动执行 package.json scripts.test，无需额外参数
          cmd = "npm test";
        } else if (fs.existsSync(path.join(abs, "pyproject.toml")) || fs.existsSync(path.join(abs, "requirements.txt"))) cmd = "python -m pytest -q 2>&1 || python -m unittest -v 2>&1";
        else if (fs.existsSync(path.join(abs, "go.mod"))) cmd = "go test ./...";
        else if (fs.existsSync(path.join(abs, "Cargo.toml"))) cmd = "cargo test";
        else return "未检测到测试框架，请用 command 参数指定";
      }
      if (!(await guard(ctx, "run_test", "medium", `运行测试：${cmd}`))) return "用户拒绝：未运行测试";
      // 断网策略：测试默认断网，外传命令拦截（run_test 无 network 参数，需去掉外传工具或改用 run_command）
      const egress = detectEgress(cmd);
      if (egress) {
        const msg = egressBlockedMessage(egress);
        auditCommand(abs, cmd, false, msg, "egress-blocked");
        return `${msg}\n（受限沙箱·断网策略）测试未执行`;
      }
      // 测试命令与 run_command 同走沙箱分派（docker / 受限沙箱 / 软沙箱）
      const r = await execLocal(cmd, abs, 300000);
      auditCommand(abs, cmd, r.ok, r.out, r.sandbox);
      return r.out + (r.ok ? `\n${sandboxTag(r.sandbox)}执行完成` : `\n${sandboxTag(r.sandbox)}`);
    },
  },

  project_scan: {
    name: "project_scan",
    description: "扫描项目：识别技术栈（语言/框架/包管理器）并列出顶层结构。用于任务开始前的项目理解。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `错误：目录不存在 ${rel}`;

      // 技术栈识别
      const flags: Record<string, string> = {
        "package.json": "Node.js（JS/TS）",
        "pnpm-lock.yaml": "Node.js（pnpm）",
        "yarn.lock": "Node.js（yarn）",
        "requirements.txt": "Python（pip）",
        "pyproject.toml": "Python（Poetry/uv）",
        "go.mod": "Go",
        "Cargo.toml": "Rust（Cargo）",
        "pom.xml": "Java（Maven）",
        "build.gradle": "Java/Groovy（Gradle）",
        "composer.json": "PHP（Composer）",
        "Gemfile": "Ruby",
        "*.csproj": "C#/.NET",
        "Dockerfile": "Docker",
        "docker-compose.yml": "Docker Compose",
        "Makefile": "Make",
      };
      const detected: string[] = [];
      const files = walkFiles(abs, 3000);
      for (const f of files.slice(0, 500)) {
        const base = path.basename(f);
        if (flags[base] && !detected.includes(flags[base])) detected.push(flags[base]);
        else if (base.endsWith(".csproj") && !detected.includes(flags["*.csproj"])) detected.push(flags["*.csproj"]);
      }

      // 框架识别（package.json 依赖）
      let framework = "";
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(abs, "package.json"), "utf-8"));
        const deps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
        if (deps.react) framework = "React";
        else if (deps.vue) framework = "Vue";
        else if (deps.angular || deps["@angular/core"]) framework = "Angular";
        else if (deps.svelte) framework = "Svelte";
        if (deps.next) framework += " + Next.js";
        if (deps["@nestjs/core"]) framework += " + NestJS";
        if (deps.express) framework += " + Express";
        if (deps["@infu/agent"] || deps.ai) framework += " + AI SDK";
      } catch { /* 非 Node 项目 */ }

      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const tree = entries
        .slice(0, 40)
        .map((e) => (e.isDirectory() ? `  ${e.name}/` : `  ${e.name}`))
        .join("\n");

      const head = [`项目扫描: ${rel || "/"}`, `技术栈: ${detected.join("、") || "未识别"}${framework ? `（${framework}）` : ""}`, `文件数: ${files.length}`].join("\n");
      return head + "\n\n顶层结构:\n" + tree;
    },
  },
};

export function getToolNames(): string[] {
  return Object.keys(TOOLS);
}

/** 只读工具子集（Planner 规划 / Reviewer 审查专用——写工具不进循环 = 架构级只读保证；
 *  v2.3 批 2：use_skill 只读（读 SKILL.md 全文）→ 进白名单） */
export function getReadOnlyTools(): Record<string, ToolDef> {
  return {
    read_file: TOOLS.read_file,
    search_code: TOOLS.search_code,
    list_directory: TOOLS.list_directory,
    project_scan: TOOLS.project_scan,
    git_status: TOOLS.git_status,
    git_diff: TOOLS.git_diff,
    use_skill: TOOLS.use_skill,
  };
}

/** Reviewer 工具集 = 只读 + run_test（审查时可验证测试结果，但无任何写能力） */
export function getReviewerTools(): Record<string, ToolDef> {
  return {
    ...getReadOnlyTools(),
    run_test: TOOLS.run_test,
  };
}
