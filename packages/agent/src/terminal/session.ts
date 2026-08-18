/**
 * Web 交互式终端 — 会话管理（v2.4 批 2）
 *
 * 基于 node-pty（真实 PTY：支持 vim/htop 等交互程序；Windows 下经 ConPTY）。
 * 安全边界（docs/TERMINAL.md）：
 *  - 终端 = 用户亲手输入，直连本机 spawn（不走 L1.5 整命令执行模型——PTY 需要交互）
 *  - 环境变量消毒（sanitizeEnv：防宿主凭据泄漏进子进程）
 *  - 高危命令审批 + 全量审计（commands.log）由端点层负责
 *  - 会话输出环形缓冲：SSE 重连可重放最近输出
 */

import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { sanitizeEnv } from "../sandbox/index.js";

/** 会话输出环形缓冲上限（字符） */
export const OUTPUT_BUFFER_MAX = 64 * 1024;

export interface TerminalSession {
  id: string;
  /** 工作目录（UI 当前项目根） */
  cwd: string;
  /** 可执行 shell 路径（cmd.exe / powershell.exe / bash） */
  shell: string;
  pid: number;
  createdAt: number;
  proc: pty.IPty;
  /** 输出缓冲（新 SSE 连接先重放；环形截断） */
  buffer: string;
  /** 输出订阅者（SSE 连接回调） */
  listeners: Set<(data: string) => void>;
  /** 已退出标记（exit 事件后拒绝写入） */
  exited: boolean;
}

const sessions = new Map<string, TerminalSession>();

/** 支持的 shell（Windows 默认 cmd.exe；Git Bash 优先于普通 bash） */
export function resolveShell(shell?: string): string {
  if (shell === "powershell") return "powershell.exe";
  if (shell === "bash") {
    const candidates = [
      process.env.INFU_BASH_PATH,
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\msys64\\usr\\bin\\bash.exe",
      "/usr/bin/bash",
    ];
    for (const c of candidates) {
      if (!c) continue;
      if (existsSync(c)) return c;
    }
    return "bash"; // 兜底：PATH 里的 bash
  }
  return "cmd.exe";
}

/** 创建终端会话（cwd 不存在时回退 process.cwd()） */
export function createTerminalSession(cwd?: string, shell?: string): TerminalSession {
  const workDir = cwd && existsSync(cwd) && statSync(cwd).isDirectory() ? cwd : process.cwd();
  const shellPath = resolveShell(shell);
  const proc = pty.spawn(shellPath, [], {
    name: "xterm-256color",
    cols: 100,
    rows: 24,
    cwd: workDir,
    env: sanitizeEnv() as Record<string, string>,
  });
  const session: TerminalSession = {
    id: randomUUID(),
    cwd: workDir,
    shell: shellPath,
    pid: proc.pid,
    createdAt: Date.now(),
    proc,
    buffer: "",
    listeners: new Set(),
    exited: false,
  };
  proc.onData((data) => {
    session.buffer = (session.buffer + data).slice(-OUTPUT_BUFFER_MAX);
    for (const fn of session.listeners) {
      try { fn(data); } catch { /* 单个订阅者异常不影响其他 */ }
    }
  });
  proc.onExit(() => {
    session.exited = true;
    for (const fn of session.listeners) {
      try { fn(`\r\n[进程已退出]\r\n`); } catch { /* 忽略 */ }
    }
    // v4.0 审计修复（M10）：退出后从注册表移除——原实现只置 exited，僵尸会话
    // （64KB 缓冲 + listeners 集合）在长驻服务永久累积（用户敲 exit/进程自行退出路径）
    sessions.delete(session.id);
  });
  sessions.set(session.id, session);
  return session;
}

/** 获取会话（不存在返回 undefined） */
export function getTerminalSession(id: string): TerminalSession | undefined {
  return sessions.get(id);
}

/** 订阅输出（返回取消订阅函数；先重放缓冲） */
export function subscribeOutput(session: TerminalSession, fn: (data: string) => void): () => void {
  session.listeners.add(fn);
  // 新连接先重放已有输出（SSE 重连不丢内容）
  if (session.buffer) fn(session.buffer);
  return () => session.listeners.delete(fn);
}

/** 写入输入（已退出/不存在由调用方校验；此处只管写入） */
export function writeInput(session: TerminalSession, data: string): void {
  if (session.exited) return;
  // v4.0 审计修复（L9）：exited 检查与 proc.write 之间进程退出会抛异常冒泡到端点层
  try {
    session.proc.write(data);
  } catch {
    session.exited = true;
    sessions.delete(session.id);
  }
}

/** 调整 PTY 尺寸（前端 fit 后同步） */
export function resizeSession(session: TerminalSession, cols: number, rows: number): void {
  if (session.exited || !cols || !rows) return;
  try {
    session.proc.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
  } catch { /* PTY 已退出等场景忽略 */ }
}

/** 终止会话（kill 进程树 + 从 Map 移除） */
export function killTerminalSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  try { s.proc.kill(); } catch { /* 已退出忽略 */ }
  s.exited = true;
  sessions.delete(id);
  return true;
}

/** 活动会话列表（状态展示用） */
export function listTerminalSessions(): Array<{ id: string; cwd: string; shell: string; pid: number; createdAt: number }> {
  return [...sessions.values()].map((s) => ({
    id: s.id, cwd: s.cwd, shell: s.shell, pid: s.pid, createdAt: s.createdAt,
  }));
}

/** 服务退出时统一清理（防残留子进程；与 MCP 连接清理同模式） */
export function closeAllTerminalSessions(): void {
  for (const id of [...sessions.keys()]) killTerminalSession(id);
}
