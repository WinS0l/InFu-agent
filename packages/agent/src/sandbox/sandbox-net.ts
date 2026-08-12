/**
 * 网络出站控制门面（M6）—— @infu/sandbox-rs 的 net* 系列封装
 *
 * 职责：
 *  - 状态读取/启用开关（~/.infu/config.json 的 sandboxNet 段；INFU_SANDBOX_NET=0 强制禁用）
 *  - 提权安装编排（setup/remove 走 CLI 的 UAC 重启动线，这里只调原生接口）
 *  - 工作区授权缓存：每个任务根首次执行前授权沙箱账号（Modify + 祖先 Traverse），
 *    授权一次本会话内复用（CLI 与 server 共用本模块）
 *
 * 安全边界：明文密码只存在于 Rust 层（状态文件是 DPAPI 密文），本模块只见账号名。
 */

import { createRequire } from "node:module";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../providers/registry.js";
import type { RestrictedRunResult } from "./win-restricted.js";

const require = createRequire(import.meta.url);

/** 提权辅助计划任务名（setup 时注册，最高权限、无 UAC 弹窗） */
export const HELPER_TASK = "InFuSandboxNetHelper";
/** 请求/结果交换目录 */
const HELPER_ROOT = () => join(process.env.ProgramData ?? "C:\ProgramData", "InFu", "sandbox-helper");
const HELPER_DIR = () => join(HELPER_ROOT(), (process.env.USERNAME ?? "user").replace(/[^A-Za-z0-9_-]/g, "_"));

export type SandboxNetKind = "offline" | "online";

export interface NetStatusResult {
  configured: boolean;
  elevated: boolean;
  offlineOk: boolean;
  onlineOk: boolean;
  rulesOk: boolean;
  error?: string;
}

export interface NetSetupResult {
  offlineUser: string;
  onlineUser: string;
  offlineSid: string;
  toolDirs: string[];
  createdAt: string;
}

export type NativeNetModule = {
  netIsElevated(): boolean;
  netSetup(): NetSetupResult;
  netRemove(): string;
  netStatus(): NetStatusResult;
  netGrantDir(path: string): string[];
};

let native: NativeNetModule | null | undefined; // undefined = 尚未尝试加载
/** 已授权的工作区根（本会话缓存） */
const grantedRoots = new Set<string>();
let enabledCache: boolean | undefined;

function loadNative(): NativeNetModule | null {
  if (native !== undefined) return native;
  try {
    const m = require("@infu/sandbox-rs") as unknown as Record<string, unknown>;
    // 旧产物没有 net* 系列 → 视为不可用（与 winRestrictedAvailable 的退化逻辑一致）
    native =
      typeof m.netStatus === "function" && typeof m.netGrantDir === "function"
        ? (m as NativeNetModule)
        : null;
  } catch {
    native = null;
  }
  return native;
}

/**
 * 网络出站控制是否启用：
 *   - INFU_SANDBOX_NET=0 强制禁用（故障排查/降级测试，与 INFU_SANDBOX_RESTRICTED 同风格）
 *   - 配置 sandboxNet.enabled=false 禁用
 *   - 原生模块可用 + 状态文件存在（configured）才算启用
 */
export async function sandboxNetEnabled(): Promise<boolean> {
  if (process.env.INFU_SANDBOX_NET === "0") return false;
  if (enabledCache !== undefined) return enabledCache;
  const m = loadNative();
  if (!m) return false;
  try {
    const cfg = loadConfig();
    if (cfg?.sandboxNet?.enabled === false) return false;
    const st = m.netStatus();
    enabledCache = st.configured && st.offlineOk && st.onlineOk;
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}

/** 状态（每次真实查询，不缓存——status 命令要如实反映） */
export function netStatus(): NetStatusResult | null {
  const m = loadNative();
  if (!m) return null;
  try {
    return m.netStatus();
  } catch {
    return null;
  }
}

/** 当前进程是否提权（UAC） */
export function netIsElevated(): boolean {
  const m = loadNative();
  return m ? m.netIsElevated() : false;
}

/** 安装（仅提权进程调用；CLI 负责 UAC 重启动线） */
export function netSetup(): NetSetupResult {
  const m = loadNative();
  if (!m) throw new Error("原生模块不可用（未构建或平台不支持）");
  return m.netSetup();
}

/** 移除（仅提权进程调用） */
export function netRemove(): string {
  const m = loadNative();
  if (!m) throw new Error("原生模块不可用（未构建或平台不支持）");
  return m.netRemove();
}

/** 授权目录（不缓存——CLI `sandbox-net grant` 显式调用用） */
export function netGrant(dir: string): string[] {
  const m = loadNative();
  if (!m) throw new Error("原生模块不可用（未构建或平台不支持）");
  return m.netGrantDir(dir);
}

/**
 * 确保工作区已授权给沙箱账号（root Modify + 祖先 Traverse）。
 * 每个根本会话只授权一次；返回本次是否执行了授权（用于审计）。
 */
export async function ensureRootGranted(root: string): Promise<boolean> {
  const m = loadNative();
  if (!m) return false;
  if (grantedRoots.has(root)) return false;
  const granted = m.netGrantDir(root);
  grantedRoots.add(root);
  return granted.length > 0;
}

/** 测试专用：清空授权缓存 */
export function resetGrantCache(): void {
  grantedRoots.clear();
  enabledCache = undefined;
}

// ─────────────────────── 提权辅助进程（沙箱命令执行通道）───────────────────────

/**
 * 经提权辅助进程执行沙箱命令（sandboxUser 场景专用）。
 * 流程：写请求文件 → schtasks /run（无 UAC）→ 轮询结果文件 → 返回。
 * 返回 null 表示辅助通道不可用（任务未注册/调度失败），调用方应显式降级。
 */
export async function runElevatedSandbox(req: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  sandboxUser: "offline" | "online";
  /** 调试用：透传给 helper 进程的环境变量（helper 是全新环境） */
  debugEnv?: Record<string, string>;
}): Promise<RestrictedRunResult | null> {
  const dir = HELPER_DIR();
  const uuid = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    // 仅字符串值（ProcessEnv 可能有 undefined，JSON 序列化会丢键）
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.env)) {
      if (typeof v === "string") env[k] = v;
    }
    writeFileSync(
      join(dir, `req-${uuid}.json`),
      // modulePath：原生模块绝对路径（helper 在 %LOCALAPPDATA%\InFu\，无 node_modules 上溯）
      JSON.stringify({ ...req, env, modulePath: require.resolve("@infu/sandbox-rs") }),
      "utf-8"
    );
    const res = await new Promise<{ code: number | null }>((resolve) => {
      execFile("schtasks.exe", ["/run", "/tn", HELPER_TASK], { windowsHide: true }, (e, _o, _err) => {
        resolve({ code: e ? null : 0 });
      });
    });
    if (res.code === null) return null; // schtasks 不可用
    // 轮询结果（命令超时 + 调度/启动余量）
    const resFile = join(dir, `res-${uuid}.json`);
    const deadline = Date.now() + req.timeoutMs + 20000;
    while (Date.now() < deadline) {
      if (existsSync(resFile)) {
        const r = JSON.parse(readFileSync(resFile, "utf-8")) as RestrictedRunResult;
        rmSync(resFile, { force: true });
        return r;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return {
      ok: false, code: -1, stdout: "", stderr: "", timedOut: true,
      level: "helper-timeout", net: req.sandboxUser,
      error: "提权辅助进程无响应（超时）",
    };
  } catch {
    return null;
  } finally {
    rmSync(join(dir, `req-${uuid}.json`), { force: true });
  }
}

/**
 * 注册提权辅助计划任务（仅提权进程调用）：最高权限、交互式触发、无 UAC 弹窗。
 * helper 先复制到 ASCII 路径（%LOCALAPPDATA%\InFu\）——任务 XML 不接受全角字符路径（实测）。
 */
export function installHelperTask(): void {
  const src = join(import.meta.dirname ?? "", "..", "..", "scripts", "sandbox-helper.mjs");
  const dir = join(process.env.LOCALAPPDATA ?? tmpdir(), "InFu");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "sandbox-helper.mjs");
  copyFileSync(src, dest);
  const ps = [
    `$action = New-ScheduledTaskAction -Execute '${process.execPath}' -Argument '"${dest}"'`,
    `$principal = New-ScheduledTaskPrincipal -UserId '$env:USERDOMAIN\$env:USERNAME' -LogonType S4U -RunLevel Highest`,
    `Register-ScheduledTask -TaskName '${HELPER_TASK}' -Action $action -Principal $principal -Force | Out-Null`,
  ].join("; ");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      windowsHide: true,
      encoding: "utf-8",
    });
  } catch (e: any) {
    throw new Error(`注册计划任务失败: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

/**
 * 授予当前用户提权辅助所需特权（SeAssignPrimaryToken / SeImpersonate / SeIncreaseQuota / SeBatchLogon）。
 * 仅提权进程调用；P/Invoke 直调 LSA（本机加固策略移除了这些特权，须在 setup 时补授，
 * S4U 任务的新登录令牌会按当前策略带上）。脚本纯 ASCII，-File 执行无编码问题。
 */
export function grantCurrentUserRights(): void {
  const script = join(import.meta.dirname ?? "", "..", "..", "scripts", "grant-rights.ps1");
  try {
    const out = String(
      execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
        windowsHide: true,
        encoding: "utf-8",
      })
    );
    if (!/rights granted/i.test(out)) throw new Error(out.slice(0, 200));
  } catch (e: any) {
    const detail = String(e?.stderr ?? e?.message ?? e).slice(0, 300);
    throw new Error(`授予用户特权失败: ${detail}`);
  }
}

/** 删除提权辅助计划任务（仅提权进程调用；不存在时静默成功） */
export function removeHelperTask(): void {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Unregister-ScheduledTask -TaskName '${HELPER_TASK}' -Confirm:$false`], {
      windowsHide: true,
      encoding: "utf-8",
    });
  } catch { /* 不存在时忽略 */ }
}
