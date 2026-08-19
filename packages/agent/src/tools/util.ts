/**
 * 工具系统共享助手（v2.6 收尾：从 index.ts 抽出，供 index/web/git/task 工具模块复用）
 * - 命令执行（软沙箱/受限沙箱/Docker 统一分派）
 * - 输出裁剪 / 审批辅助 / 目录遍历
 */
import { exec, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { ToolContext, RiskLevel } from "@infu/shared";
import {
  sanitizeEnv, auditCommand, dockerAvailable, buildDockerArgs,
  redactSensitiveOutput, resolveSandboxMode, resolveEffectiveMode, type SandboxMode,
} from "../sandbox/index.js";
import {
  winRestrictedAvailable, runRestricted, type RestrictedRunResult,
} from "../sandbox/win-restricted.js";
import { loadConfig } from "../providers/registry.js";
import { findProjectByRoot } from "../projects.js";
import {
  currentApprovalPolicy, isToolDisabled, resolveToolRisk, shouldAutoApprove, isCommandAllowed,
} from "../approval/policy.js";
import { approvalMemoryKey, approvalRemembered, approvalRemember, isSessionBypassed } from "../approval/cache.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** 输出截断上限（防止结果撑爆上下文） */
export const MAX_OUTPUT = 12000;
export const MAX_FILE_READ = 512 * 1024; // 512KB

/**
 * v2.13：路径边界判断（修复 startsWith 前缀漏洞）——
 * `path.resolve(root, "../work2/evil.txt")` 得 `E:\work2\evil.txt`，`startsWith("E:\work")`
 * 为 true 会越界读写**同前缀兄弟目录**。正确边界 = 根自身 或 根 + 路径分隔符开头；
 * win32 统一小写比较（防大小写变体逃逸）。
 * v3.0 审计修复（S6）：词法比较可被符号链接逃逸——项目内 symlink/junction 指向项目外
 * （如 `proj/data-link` → `C:\secrets`）时 `data-link/x` 词法上仍在 root 内，实际写到外部。
 * 双检策略：词法必须在内（防 root 不存在时 realpath 回溯到共同祖先误放行），
 * 且 realpath 解析后（目标自身或向上回溯到最近存在的祖先）仍须在根内。
 */
export function isPathInside(root: string, abs: string): boolean {
  const insideLex = (b: string, t: string): boolean =>
    process.platform === "win32"
      ? t.toLowerCase() === b.toLowerCase() || t.toLowerCase().startsWith(b.toLowerCase() + path.sep)
      : t === b || t.startsWith(b + path.sep);
  const lexBase = path.resolve(root);
  const lexTarget = path.resolve(abs);
  if (!insideLex(lexBase, lexTarget)) return false;

  /** v6.0 S6：realpath 无法验证（祖先链全部不可解析）的哨兵——见 isPathInside fail-closed */
const UNRESOLVED_PATH = "\u0000infu-unresolved\u0000";

const realResolve = (p: string): string => {
    let cur = p;
    for (let depth = 0; depth < 64; depth++) {
      try {
        return fs.realpathSync.native(cur);
      } catch {
        const parent = path.dirname(cur);
        // v6.0 S6 修复（fail-closed）：回溯到卷根仍无法解析（路径链完全不存在，
        // 如根盘符不存在）时，原实现返回词法路径 → 词法在内即放行，符号链接
        // 逃逸在「根不可解析」场景下失去 realpath 第二道校验。改为返回哨兵，
        // 调用方命中哨兵一律拒绝——无法验证的真实位置宁可误杀不越界。
        if (parent === cur) return UNRESOLVED_PATH;
        cur = parent;
      }
    }
    return UNRESOLVED_PATH; // 64 层回溯耗尽仍不可解析 → fail-closed
  };
  const realBase = realResolve(lexBase);
  const realTarget = realResolve(lexTarget);
  if (realBase === UNRESOLVED_PATH || realTarget === UNRESOLVED_PATH) return false;
  return insideLex(realBase, realTarget);
}

/** 工具结果截断 */
export function clip(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...（已截断，共 ${s.length} 字符）`;
}

/**
 * v3 默认会话根目录只读保护：root = config.general.defaultRoot 且未注册为项目时，
 * 禁止写操作（自由会话容器目录；已注册项目 = 用户显式授权，豁免）。
 * v3.4 审计修复（H4）：从 tools/index.ts 提取到 util.js——fs-tools（file_ops）与
 * index（write/edit）共用同一实现，防 file_ops 绕过只读容器检查。
 */
export function isReadOnlySessionRoot(root: string): boolean {
  const cfg = loadConfig();
  const sessionRoot = cfg?.general?.defaultRoot;
  if (!sessionRoot) return false;
  return path.resolve(root) === path.resolve(sessionRoot) && !findProjectByRoot(root);
}
export function sessionRootReadOnlyBlock(ctx: ToolContext): string | null {
  if (!isReadOnlySessionRoot(ctx.root)) return null;
  return "默认会话根目录为只读容器——自由会话不能修改此目录，请先在侧栏选择/创建项目后执行写操作";
}

/** 命令输出格式化 */
export function fmtOut(o: { stdout: string; stderr: string }, ok: boolean): string {
  const parts: string[] = [];
  if (o.stdout.trim()) parts.push(o.stdout.trim());
  if (o.stderr.trim()) parts.push(`[stderr] ${o.stderr.trim()}`);
  const body = redactSensitiveOutput(parts.join("\n") || "(无输出)");
  return ok ? clip(body) : `命令执行失败：\n${clip(body)}`;
}

/** 执行 shell 命令（win32 自动选 shell；默认使用消毒后的环境变量；signal 中止时 kill 子进程） */
export async function runShell(
  command: string,
  cwd: string,
  timeoutMs = 60000,
  env: NodeJS.ProcessEnv = sanitizeEnv(),
  signal?: AbortSignal
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
      // v2.5：中止信号传递——父/子智能体被终止时立即 kill 命令（不等 60s 超时）
      signal,
    });
    return { ok: true, out: fmtOut({ stdout, stderr }, true), code: 0 };
  } catch (e: any) {
    const code = e.code ?? e.status ?? null;
    // 中止：不当作错误透出（上层 abort 流程处理）
    if (signal?.aborted || e.name === "AbortError") {
      return { ok: false, out: "任务已停止（用户中止）", code: null };
    }
    // 关键：错误详情必须透出（目录不存在/找不到命令/退出码），不要吞掉
    const detail = redactSensitiveOutput([e.stderr, e.stdout, e.message ? String(e.message) : ""]
      .filter((s) => typeof s === "string" && s.trim())
      .join("\n")
      .trim());
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
export async function runInDocker(command: string, root: string, timeoutMs = 120000): Promise<{ ok: boolean; out: string; code: number | null }> {
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
    const detail = redactSensitiveOutput([e.stderr, e.stdout, e.message ? String(e.message) : ""]
      .filter((s) => typeof s === "string" && s.trim())
      .join("\n")
      .trim());
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
export async function getSandboxMode(): Promise<SandboxMode> {
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
export function fmtRestricted(r: RestrictedRunResult): { out: string; ok: boolean; code: number | null; sandbox: string } {
  const ok = r.ok && !r.timedOut && r.code === 0;
  const body = redactSensitiveOutput([r.stdout, r.stderr]
    .filter((s) => s.trim())
    .join(r.stdout.trim() && r.stderr.trim() ? "\n[stderr] " : "\n")
    .trim());
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
export async function execLocal(
  command: string,
  cwd: string,
  timeoutMs = 60000,
  signal?: AbortSignal,
  modeOverride?: string
): Promise<{ ok: boolean; out: string; code: number | null; sandbox: string }> {
  // v2.14 批 18：子智能体 agent 文件 sandbox 字段覆盖（缺省跟随全局设置）
  const mode = modeOverride ? resolveEffectiveMode(modeOverride as SandboxMode, {
    dockerOk: modeOverride === "docker" ? await dockerAvailable() : false,
    winRestrictedOk: process.platform === "win32" && (await winRestrictedAvailable()),
    platform: process.platform,
  }) : await getSandboxMode();
  if (mode === "docker") {
    const r = await runInDocker(command, cwd, timeoutMs);
    return { ...r, sandbox: "docker" };
  }
  if (mode === "off") {
    const r = await runShell(command, cwd, timeoutMs, sanitizeEnv(), signal);
    return { ...r, sandbox: "off" };
  }
  if (mode === "restricted") {
    // 审计修复（H-2）：透传 AbortSignal——停止任务时 native abortRun 杀整树
    const r = await runRestricted(command, cwd, timeoutMs, sanitizeEnv(), signal);
    if (r) return fmtRestricted(r);
    // native 异常 → 降级软沙箱（下面统一处理）
  }
  // soft / 降级：纯软沙箱（L1，不隐式走 L1.5）
  const r = await runShell(command, cwd, timeoutMs, sanitizeEnv(), signal);
  return { ...r, sandbox: "soft" };
}

/** 沙箱标签 → 展示文本 */
export function sandboxTag(sandbox: string): string {
  switch (sandbox) {
    case "docker": return "（Docker 沙箱）";
    case "restricted": return "（受限沙箱）";
    case "restricted:job-only": return "（受限沙箱·仅Job）";
    case "off": return "（直连）";
    default: return "（软沙箱）";
  }
}

/**
 * 遍历/搜索/索引跳过清单（噪音目录 + 凭据目录）。
 * 凭据目录（.ssh/.aws/.gnupg/.kube/.azure/.config/.gitconfig 等）：root=home 会话下
 * search_code/semantic_search 曾可检索 ~/.ssh/id_rsa 等私钥正文进模型上下文
 * （审计 H-1）——与 read_file 的 isProtectedPath 写保护语义对齐（项目内同名目录
 * 亦无搜索价值，保守跳过）。执行层另有 isProtectedPath 兜底（防 .SSH 大小写变体）。
 */
export const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next",
  "coverage", "venv", ".venv", "__pycache__", ".cache", ".idea", ".vscode",
  ".infu", ".infu-sandbox", "target", ".turbo", ".yarn", ".pnpm-store",
  ".ssh", ".aws", ".gnupg", ".kube", ".azure", ".config", ".docker",
  ".git-credentials", ".gitconfig", ".npmrc", ".netrc", ".m2", ".gradle", ".pypirc"]);

/** 递归遍历（跳过常见噪音目录），返回匹配文件列表 */
export function walkFiles(root: string, maxFiles = 2000): string[] {
  const SKIP = SEARCH_SKIP_DIRS;
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
      // v6.0 S6 加固：显式跳过符号链接/目录联接（junction）——指向项目外的链接若被
      // 当作目录/文件遍历，搜索结果会把外部内容带入上下文（readdir 的 dirent 在
      // 各 Node 版本对 junction 的报告不一致，显式判断为跨版本确定性防线）
      if (ent.isSymbolicLink()) continue;
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
export async function guard(
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
  // v3.2 会话级全权放行：用户在审批弹窗点「本会话全部放行」后，本会话内所有审批
  // （含 requireExplicit 红线）直接放行——显式禁用（上方 isToolDisabled）不受影响；
  // 命令审计/事件流照常。作用域仅当前会话（无人值守没有按钮可点，红线拒绝语义不变）。
  const sid = ctx.sessionId ?? "cli";
  if (isSessionBypassed(sid)) return true;
  // v3.1 审批流优化：会话级已批准记忆——非红线（requireExplicit）操作，本会话内
  // 同参批准过一次后直接放行（弹窗只出现一次；命令审计不受影响）
  const memKey = approvalMemoryKey(tool, effectiveRisk, description);
  if (approvalRemembered(sid, memKey)) return true;
  const approved = await ctx.requestApproval(description, effectiveRisk, requireExplicit);
  if (approved && !requireExplicit) approvalRemember(sid, memKey);
  return approved;
}

/** 命令审计（run_command/run_test 已各自调用；工具模块需要时复用） */
export { auditCommand };

/** 保留导出：execFileSync（测试/工具内部需要同步执行时用） */
export { execFileSync, execFileAsync, execAsync };
