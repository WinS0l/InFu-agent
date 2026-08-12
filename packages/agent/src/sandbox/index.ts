/**
 * InFu 沙箱模块 — L1 软沙箱（默认，零依赖）+ L2 Docker 沙箱
 *
 * 依据 docs/SANDBOX.md 调研结论实现：
 *  - L1：环境变量消毒 / 敏感路径写保护 / 命令审计 / 工作区约束
 *  - L2：Docker 容器（默认断网、只读挂载、资源限制、任务后销毁、凭据不进容器）
 *
 * 模式：INFU_SANDBOX=auto（默认，有 Docker 用 L2）| soft | docker | off
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

const execFileAsync = promisify(execFile);

export type SandboxMode = "auto" | "soft" | "docker" | "off";

/** 环境变量消毒：剔除敏感凭据（防沙箱/子进程读取宿主密钥） */
export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const SENSITIVE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SENSITIVE.test(k)) continue; // INFU_*_API_KEY、OPENAI_API_KEY 等全部剔除
    out[k] = v;
  }
  return out;
}

/** 敏感路径写保护清单（写这些路径没有合法场景，直接拦截） */
const PROTECTED_PATTERNS: Array<{ name: string; match: (abs: string) => boolean }> = [
  { name: "SSH 密钥目录", match: (a) => /(^|[\\/])\.ssh([\\/]|$)/.test(a) },
  { name: "InFu 配置目录", match: (a) => /(^|[\\/])\.infu([\\/]|$)/.test(a) },
  { name: "AWS 凭据目录", match: (a) => /(^|[\\/])\.aws([\\/]|$)/.test(a) },
  { name: "GnuPG 密钥目录", match: (a) => /(^|[\\/])\.gnupg([\\/]|$)/.test(a) },
  { name: "Docker 配置", match: (a) => /(^|[\\/])\.docker([\\/]|$)/.test(a) },
  { name: "浏览器凭据", match: (a) => /(^|[\\/])(AppData|Application Data)([\\/])/.test(a) && /(Login Data|Cookies|Local State)/i.test(a) },
];

/** 检查路径是否命中写保护清单，返回保护名或 null */
export function isProtectedPath(abs: string): string | null {
  for (const p of PROTECTED_PATTERNS) {
    if (p.match(abs)) return p.name;
  }
  return null;
}

/** 命令审计日志 */
export const COMMAND_LOG = path.join(os.homedir(), ".infu", "logs", "commands.log");
export function auditCommand(cwd: string, command: string, ok: boolean, detail: string) {
  try {
    mkdirSync(path.dirname(COMMAND_LOG), { recursive: true });
    const line = `[${new Date().toISOString()}] ${ok ? "OK " : "ERR"} | cwd=${cwd} | ${command.slice(0, 200)} | ${detail.slice(0, 120)}`;
    appendFileSync(COMMAND_LOG, line + "\n", "utf-8");
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
  setTimeout(() => (dockerCache = null), 60_000);
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
  // Windows 路径转 docker 挂载格式：E:\InFu(test) → E:/InFu(test)
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

/** 解析沙箱模式 */
export function resolveSandboxMode(env: NodeJS.ProcessEnv = process.env): SandboxMode {
  const v = (env.INFU_SANDBOX || "auto").toLowerCase() as SandboxMode;
  return ["auto", "soft", "docker", "off"].includes(v) ? v : "auto";
}
