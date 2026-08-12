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
  resolveSandboxMode, type SandboxMode,
} from "../sandbox/index.js";

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

/** 沙箱模式解析（auto：有 Docker 用容器，否则软沙箱） */
async function getSandboxMode(): Promise<SandboxMode> {
  const mode = resolveSandboxMode();
  if (mode === "auto") {
    const hasDocker = await dockerAvailable();
    return hasDocker ? "docker" : "soft";
  }
  return mode;
}

/** 递归遍历（跳过常见噪音目录），返回匹配文件列表 */
function walkFiles(root: string, maxFiles = 2000): string[] {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next",
    "coverage", "venv", ".venv", "__pycache__", ".cache", ".idea", ".vscode",
    ".infu", "target", ".turbo", ".yarn", ".pnpm-store"]);
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

/** 审批辅助：风险高于阈值时请求确认 */
async function guard(ctx: ToolContext, risk: RiskLevel, description: string): Promise<boolean> {
  if (risk === "low") return true;
  return ctx.requestApproval(description, risk);
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
      if (!(await guard(ctx, "medium", desc))) return "用户拒绝：未写入";
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
      if (!(await guard(ctx, "medium", desc))) return "用户拒绝：未修改";
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
      "在项目内执行 shell 命令（终端执行）。可运行构建、安装依赖、启动服务、查看环境等。高风险命令（删除/强制操作）需确认。",
    risk: "medium",
    schema: z.object({
      command: z.string().describe("要执行的命令"),
      timeout: z.number().int().min(1000).max(300000).optional().describe("超时毫秒（默认 60000）"),
    }),
    async execute(args, ctx) {
      const command = args.command as string;
      const DANGEROUS = /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/f|format\s+|mkfs|dd\s+if=)\b/i;
      if (DANGEROUS.test(command)) {
        if (!(await guard(ctx, "high", `执行高风险命令：${command}`))) {
          return "用户拒绝：高危命令未执行";
        }
      } else if (!(await guard(ctx, "medium", `执行命令：${command}`))) {
        return "用户拒绝：命令未执行";
      }
      const timeoutMs = (args.timeout as number | undefined) || 60000;

      // 沙箱模式执行（auto：有 Docker 用容器，否则软沙箱）
      const mode = await getSandboxMode();
      const r =
        mode === "docker"
          ? await runInDocker(command, ctx.root, timeoutMs)
          : await runShell(command, ctx.root, timeoutMs);

      // 命令审计（所有模式）
      auditCommand(ctx.root, command, r.ok, r.out);
      const modeTag = mode === "docker" ? "（Docker 沙箱）" : mode === "soft" ? "（软沙箱）" : "（直连）";
      return r.out + (r.ok ? `\n${modeTag}执行完成` : `\n${modeTag}`);
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
      if (!(await guard(ctx, "medium", `运行测试：${cmd}`))) return "用户拒绝：未运行测试";
      const r = await runShell(cmd, abs, 300000);
      return r.out;
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

/** 只读工具子集（Planner 规划 / Reviewer 审查专用——写工具不进循环 = 架构级只读保证） */
export function getReadOnlyTools(): Record<string, ToolDef> {
  return {
    read_file: TOOLS.read_file,
    search_code: TOOLS.search_code,
    list_directory: TOOLS.list_directory,
    project_scan: TOOLS.project_scan,
    git_status: TOOLS.git_status,
    git_diff: TOOLS.git_diff,
  };
}

/** Reviewer 工具集 = 只读 + run_test（审查时可验证测试结果，但无任何写能力） */
export function getReviewerTools(): Record<string, ToolDef> {
  return {
    ...getReadOnlyTools(),
    run_test: TOOLS.run_test,
  };
}
