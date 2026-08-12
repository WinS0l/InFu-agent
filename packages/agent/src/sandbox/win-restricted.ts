/**
 * Windows 硬沙箱适配层 — @infu/sandbox-rs（Rust 原生：restricted tokens + job objects）的 Node 封装
 *
 * 职责：
 *  - 平台/模块可用性检测（含一次真实自测，结果缓存）
 *  - 受限执行调用（async）
 *  - native 不可用/调用异常 → 返回 null（调用方透明降级软沙箱并审计）
 *
 * 安全边界：受限执行只覆盖「命令进程」——OS 级强制写系统目录/提权不可行；
 * 敏感文件（~/.ssh 等）的读隔离仍由 L1 应用层保证（与本模块无关）。
 */

import { createRequire } from "node:module";

type ProcessEnv = NodeJS.ProcessEnv;

const require = createRequire(import.meta.url);

type NativeModule = {
  available(): boolean;
  runRestricted(
    command: string,
    opts: {
      cwd: string;
      timeoutMs: number;
      env?: Record<string, string>;
      processMemoryMb?: number;
      jobMemoryMb?: number;
      activeProcessLimit?: number;
    }
  ): Promise<RestrictedRunResult>;
};

export interface RestrictedRunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** full | reduced | basic | job-only | none */
  level: string;
  error?: string;
}

let native: NativeModule | null | undefined; // undefined=尚未尝试加载
let availability: "unknown" | "available" | "unavailable" = "unknown";
let selfTest: Promise<boolean> | null = null;

function loadNative(): NativeModule | null {
  if (native !== undefined) return native;
  try {
    native = require("@infu/sandbox-rs") as NativeModule;
  } catch {
    native = null;
  }
  return native;
}

/** 仅保留字符串值（ProcessEnv 可能有 undefined，napi 不认） */
function pickEnv(env: ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * 受限沙箱是否可用（win32 + 模块加载 + 一次真实自测通过）。结果缓存整个会话。
 * INFU_SANDBOX_RESTRICTED=0 可强制禁用（故障排查/降级测试用）。
 */
export async function winRestrictedAvailable(): Promise<boolean> {
  if (process.env.INFU_SANDBOX_RESTRICTED === "0") {
    availability = "unavailable";
    return false;
  }
  if (availability === "available") return true;
  if (availability === "unavailable") return false;
  if (selfTest) return selfTest;
  selfTest = (async () => {
    const m = loadNative();
    if (!m || process.platform !== "win32" || !m.available()) {
      availability = "unavailable";
      return false;
    }
    try {
      // 自测：受限执行一条无害命令，验证链路真实可用（而非仅模块可加载）
      const r = await m.runRestricted("echo infu-sandbox-ok", {
        cwd: process.cwd(),
        timeoutMs: 15_000,
        env: pickEnv(process.env),
      });
      const usable = !!r && r.ok && r.stdout.includes("infu-sandbox-ok");
      availability = usable ? "available" : "unavailable";
      return usable;
    } catch {
      availability = "unavailable";
      return false;
    }
  })();
  return selfTest;
}

/**
 * 受限执行命令。返回 null 表示 native 不可用/异常（调用方应回退软沙箱）；
 * 返回结果但 ok=false 是正常语义（命令退出码非 0 / 超时 / 创建失败）。
 */
export async function runRestricted(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: ProcessEnv
): Promise<RestrictedRunResult | null> {
  const m = loadNative();
  if (!m) return null;
  try {
    return await m.runRestricted(command, {
      cwd,
      timeoutMs,
      env: pickEnv(env),
    });
  } catch {
    return null;
  }
}
