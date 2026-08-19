/**
 * InFu 沙箱模块 — L1 软沙箱（默认，零依赖）+ L1.5 Windows 受限（Rust N-API）+ L2 Docker 沙箱
 *
 * 依据 docs/SANDBOX.md 调研结论实现：
 *  - L1：环境变量消毒 / 敏感路径写保护 / 命令审计 / 工作区约束
 *  - L1.5：Windows 受限令牌 + Job Object（packages/sandbox-rs，win32 可用时优先）
 *  - L2：Docker 容器（默认断网、只读挂载、资源限制、任务后销毁、凭据不进容器）
 *
 * 模式（v2.4：配置优先于环境变量）：auto（默认，按可用性自动选择）| off | soft(L1) | restricted(L1.5) | docker(L2)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendFileSync, mkdirSync, statSync, existsSync, renameSync, rmSync } from "node:fs";
import type { InfuConfig } from "@infu/shared";
import { resolveDataDir } from "../data-dir.js";

const execFileAsync = promisify(execFile);

export type SandboxMode = "auto" | "off" | "soft" | "restricted" | "docker";

export const SANDBOX_MODES: SandboxMode[] = ["auto", "off", "soft", "restricted", "docker"];

/** 环境变量消毒：剔除敏感凭据（防沙箱/子进程读取宿主密钥）。
 *  v3.4 审计修复：补 URL/URI/DSN/CONNECTION 键名——`DATABASE_URL`/`MONGO_URI`/
 *  `REDIS_URL` 等连接串值内嵌凭据，模型 echo 可读（原正则只拦 KEY/TOKEN 类）
 *  v3.6：补 `_PWD` 后缀（`MYSQL_PWD`/`PGPASSWORD` 历史命名）与 PROXY 键名
 *  （`HTTPS_PROXY=http://user:pass@host` 值内嵌凭据） */
export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // v3.9 审计修复：补 PASSPHRASE/_PW/_PASS/CONNSTR 键名——`SSH_PASSPHRASE`/`MYSQL_PW`/
  //  `API_PASS`/`AZURE_CONNSTR` 值内嵌凭据（原正则漏检，模型 echo 可读）
  const SENSITIVE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|URL|URI|DSN|CONNECTION|CONNSTR|PROXY|_PWD$|_PW$|_PASS$)/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SENSITIVE.test(k)) continue; // INFU_*_API_KEY、OPENAI_API_KEY、DATABASE_URL、HTTPS_PROXY 等全部剔除
    out[k] = v;
  }
  return out;
}

/** Sensitive command output must never enter an Agent context, event log, or output file. */
const SENSITIVE_OUTPUT = /(sk-[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]+|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY|Bearer [A-Za-z0-9._~+\/-]{16,}|api[_-]?key["']?\s*[:=]\s*["'][^"']{8,}["'])/gi;
export function containsSensitiveOutput(text: string): boolean {
  SENSITIVE_OUTPUT.lastIndex = 0;
  return SENSITIVE_OUTPUT.test(text);
}
export function redactSensitiveOutput(text: string): string {
  SENSITIVE_OUTPUT.lastIndex = 0;
  return text.replace(SENSITIVE_OUTPUT, (match) => `${match.slice(0, 4)}…[已脱敏 ${match.length} 字符]`);
}

/** 敏感路径写保护清单（写这些路径没有合法场景，直接拦截） */
const PROTECTED_PATTERNS: Array<{ name: string; match: (abs: string) => boolean }> = [
  { name: "SSH 密钥目录", match: (a) => /(^|[\\/])\.ssh([\\/]|$)/.test(a) },
  // v2.3 批 2：项目内 .infu/ 有合法场景（项目级 .infu/skills/ 技能目录）——
  // 保护精确到用户级数据目录（全局配置/凭据/日志），项目内 .infu 放开写；
  // v3.5：跟随迁移后的实际数据目录（含默认 ~/.infu 与 redirect 指向的新目录）
  {
    name: "InFu 配置目录",
    match: (a) => {
      const home = process.platform === "win32"
        ? resolveDataDir().toLowerCase()
        : resolveDataDir();
      return a === home || a.startsWith(home + path.sep);
    },
  },
  { name: "AWS 凭据目录", match: (a) => /(^|[\\/])\.aws([\\/]|$)/.test(a) },
  { name: "Kubernetes 凭据目录", match: (a) => /(^|[\\/])\.kube([\\/]|$)/.test(a) },
  { name: "Azure 凭据目录", match: (a) => /(^|[\\/])\.azure([\\/]|$)/.test(a) },
  { name: "GnuPG 密钥目录", match: (a) => /(^|[\\/])\.gnupg([\\/]|$)/.test(a) },
  { name: "Docker 配置", match: (a) => /(^|[\\/])\.docker([\\/]|$)/.test(a) },
  // v4.0 审计修复（M15）：home 凭据文件——.npmrc 含 registry _authToken、.git-credentials
  // 存明文 token、.netrc 存 curl/ftp 凭据；此前全部未保护（且可被 read_file/read_files
  // 在 root=home 会话读取、run_command `type` 白名单免审批读取）。仅保护 home 根下的
  // 这三类文件（项目级 .npmrc 是合法写场景，不受影响）
  {
    name: "home 凭据文件",
    match: (a) => {
      const home = (process.platform === "win32" ? os.homedir().toLowerCase() : os.homedir()).replace(/[\\/]+$/, "");
      if (a !== home && !a.startsWith(home + path.sep)) return false;
      return /(^|[\\/])(\.npmrc|\.git-credentials|\.netrc|\.pypirc|\.gitconfig)$/.test(a);
    },
  },
  {
    name: "home 工具凭据目录",
    match: (a) => {
      const home = (process.platform === "win32" ? os.homedir().toLowerCase() : os.homedir()).replace(/[\\/]+$/, "");
      if (a !== home && !a.startsWith(home + path.sep)) return false;
      return /(^|[\\/])\.(config|m2|gradle)([\\/]|$)/.test(a);
    },
  },
  { name: "浏览器凭据", match: (a) => /(^|[\\/])(AppData|Application Data)([\\/])/.test(a) && /(Login Data|Cookies|Local State)/i.test(a) },
  // v3.9 审计修复（M3）：数据目录重定向指针——Agent 可写它改变 resolveDataDir 结果，
  // 使新数据目录脱离写保护（再写新目录 config.json 即绕过凭据保护）；精确入保护
  {
    name: "数据目录重定向指针",
    match: (a) => {
      const p = path.join(os.homedir(), ".infu-redirect.json");
      const norm = process.platform === "win32" ? p.toLowerCase() : p;
      return a === norm;
    },
  },
];

/**
 * 检查路径是否命中写保护清单，返回保护名或 null。
 * v3.4 审计修复（M9）：win32 下先统一小写再匹配——Windows 文件系统大小写不敏感，
 * `C:\Users\x\.SSH\authorized_keys` / `C:\USERS\X\.INFU\config.json` 大小写变体
 * 此前可穿透写保护（盘符/路径大小写变体全部归一化）。
 */
export function isProtectedPath(abs: string): string | null {
  const norm = process.platform === "win32" ? abs.toLowerCase() : abs;
  for (const p of PROTECTED_PATTERNS) {
    if (p.match(norm)) return p.name;
  }
  return null;
}



/** 命令审计日志 */
export function commandLogPath(): string {
  return path.join(resolveDataDir(), "logs", "commands.log");
}

/**
 * v3.5 数据生命周期：日志轮转——追加前检查大小，超限滚动保留 N 份
 * （file → file.1 → file.2 … file.KEEP，最旧删除）；失败静默（日志本身不重要）
 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const KEEP_LOG_FILES = 3;
export function maybeRotateLog(filePath: string): void {
  try {
    const st = statSync(filePath);
    if (st.size < MAX_LOG_BYTES) return;
    for (let i = KEEP_LOG_FILES; i >= 1; i--) {
      const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const to = `${filePath}.${i}`;
      if (existsSync(to)) rmSync(to, { force: true });
      if (existsSync(from)) renameSync(from, to);
    }
  } catch {
    /* 轮转失败忽略 */
  }
}

export function auditCommand(cwd: string, command: string, ok: boolean, detail: string, sandbox = "", logPath = commandLogPath()) {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    maybeRotateLog(logPath);
    const tag = sandbox ? ` | sandbox=${sandbox}` : "";
    const line = `[${new Date().toISOString()}] ${ok ? "OK " : "ERR"} | cwd=${cwd} | ${command.slice(0, 200)} | ${detail.slice(0, 120)}${tag}`;
    appendFileSync(logPath, line + "\n", "utf-8");
  } catch {
    /* 审计失败不影响主流程 */
  }
}

// ── Docker 沙箱 ──

let dockerCache: boolean | null = null;
/** 检测 Docker 是否可用（结果缓存 60s） */
export async function dockerAvailable(): Promise<boolean> {
  if (dockerCache !== null) return dockerCache;
  try {
    await execFileAsync("docker", ["info"], { timeout: 5000, windowsHide: true });
    dockerCache = true;
  } catch {
    dockerCache = false;
  }
  // v3.6 审计修复：缓存失效定时器 unref——原 setTimeout 阻止事件循环退出，
  // CLI 单次任务结束后被拖 60s 才退出
  const t = setTimeout(() => (dockerCache = null), 60_000);
  t.unref?.();
  return dockerCache;
}

/** 按项目技术栈选择容器镜像 */
export function detectImage(root: string): string {
  if (fs.existsSync(path.join(root, "package.json"))) return "node:22-slim";
  if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "requirements.txt"))) return "python:3.12-slim";
  if (fs.existsSync(path.join(root, "go.mod"))) return "golang:1.24";
  if (fs.existsSync(path.join(root, "Cargo.toml"))) return "rust:1.85";
  return "node:22-slim"; // 默认
}

/** 构建 docker run 参数（默认断网、只读挂载、资源限制、非 root、任务后销毁） */
export function buildDockerArgs(
  root: string,
  command: string,
  opts: { image?: string; timeoutMs?: number } = {}
): string[] {
  const image = opts.image ?? detectImage(root);
  // Windows 路径转 docker 挂载格式：C:\Users\me\proj → C:/Users/me/proj
  const hostPath = root.replace(/\\/g, "/");
  const mount = `${hostPath}:/workspace:ro`;
  return [
    "run", "--rm", "-i",
    "--network", "none",                 // 默认断网：防数据外泄
    "--memory", "2g", "--cpus", "2",     // 资源上限
    "--pids-limit", "256",               // 防 fork bomb
    "--user", "1000:1000",               // 非 root
    "-v", mount,                          // 项目只读挂载（宿主不可被写）
    "-w", "/workspace",
    image,
    "sh", "-c", command,
  ];
}

/**
 * 解析沙箱模式（v2.4）：环境变量 INFU_SANDBOX 显式设置时优先（运行时临时覆盖，
 * 兼容既有脚本/测试），否则 config.sandbox.mode，否则 auto。
 */
export function resolveSandboxMode(
  env: NodeJS.ProcessEnv = process.env,
  config?: Pick<InfuConfig, "sandbox"> | null
): SandboxMode {
  const envVal = (env.INFU_SANDBOX || "").toLowerCase() as SandboxMode;
  if (SANDBOX_MODES.includes(envVal)) return envVal;
  const cfgVal = config?.sandbox?.mode;
  if (cfgVal && SANDBOX_MODES.includes(cfgVal)) return cfgVal;
  return "auto";
}

/**
 * 档位 → 实际执行档（纯函数，便于测试）：
 * - auto：docker 可用 → docker；否则 win32 且受限可用 → restricted；否则 soft
 * - restricted：win32 且受限可用 → restricted；否则降级 soft（显式选择但本机不支持）
 * - docker / soft / off：原样（显式 docker 不可用时由执行层报错，不静默降级）
 */
export function resolveEffectiveMode(
  mode: SandboxMode,
  opts: { dockerOk: boolean; winRestrictedOk: boolean; platform: NodeJS.Platform }
): SandboxMode {
  if (mode === "auto") {
    if (opts.dockerOk) return "docker";
    if (opts.platform === "win32" && opts.winRestrictedOk) return "restricted";
    return "soft";
  }
  if (mode === "restricted") {
    return opts.platform === "win32" && opts.winRestrictedOk ? "restricted" : "soft";
  }
  return mode;
}
