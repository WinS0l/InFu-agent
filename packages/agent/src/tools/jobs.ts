/**
 * v2.11 后台任务（job）体系 — 主流 jobs 同款
 *
 * run_command background=true 启动 → 立即返回 job id，父 Agent 继续；
 * job_list / job_output / job_kill 三个工具管理。
 *
 * 设计要点：
 *  - per-session 注册表（多会话并行互不干扰）；每会话活跃上限 MAX_JOBS_PER_SESSION
 *  - spawn 直跑 + sanitizeEnv（消毒环境变量）+ cwd 校验；输出环形缓冲（上限 512KB 防爆内存）
 *  - 杀进程树：Windows taskkill /F /T /PID；POSIX 进程组 kill（detached: true 建组）
 *  - 生命周期：父任务（runAgent）结束时按委派深度自动中止本深度启动的 job（子任务随父结束）
 *  - 安全边界：后台任务暂走软沙箱语义（L1.5 受限沙箱接口为同步执行，无法后台化；
 *    命令审批/断网策略/审计与 run_command 完全一致——启动前已过门禁）
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { sanitizeEnv, auditCommand } from "../sandbox/index.js";

/** 输出环形缓冲上限（超出丢头部，防常驻进程输出无限膨胀） */
export const JOB_OUTPUT_LIMIT = 512 * 1024;
/** 每会话活跃后台任务上限 */
export const MAX_JOBS_PER_SESSION = 8;

export type JobStatus = "running" | "done" | "failed" | "killed";

/** 后台任务句柄（job_list 视角） */
export interface JobHandle {
  id: string;
  command: string;
  cwd: string;
  status: JobStatus;
  /** 退出码（运行中为 null） */
  code: number | null;
  /** 输出缓冲（stdout+stderr 合并；环形截断） */
  out: string;
  startedAt: number;
  endedAt?: number;
  /** 启动方委派深度（父任务结束时按深度清理） */
  parentDepth: number;
  /** 已被 job_kill/深度清理请求终止（Windows 被杀进程退出码非 null，需区分"被杀"与"自身失败"） */
  killRequested: boolean;
  /** 底层子进程（杀进程树用） */
  child: ChildProcess;
}

/** per-session 后台任务注册表（sessionId → jobId → handle） */
const jobsBySession = new Map<string, Map<string, JobHandle>>();

function jobsOf(sessionId: string | undefined): Map<string, JobHandle> {
  const key = sessionId ?? "";
  let m = jobsBySession.get(key);
  if (!m) {
    m = new Map();
    jobsBySession.set(key, m);
  }
  return m;
}

/** 生成 job id（短随机，模型好记） */
function genJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * v3.4 审计修复（M6）：job 注册表剪枝——每会话运行中上限 8 但已完成条目**永久累积**
 * （长时间会话可挂数百个含输出缓冲的僵尸句柄 = 内存泄漏）。已完成条目保留最近 20 个
 * （job_output 短期仍可查输出），更老的删除；整个会话全清时空 map 一并删除。
 */
function trimJobRegistry(sessionId: string | undefined): void {
  const key = sessionId ?? "";
  const m = jobsBySession.get(key);
  if (!m) return;
  const done = [...m.entries()].filter(([, j]) => j.status !== "running");
  if (done.length > 20) {
    done.slice(0, done.length - 20).forEach(([id]) => m.delete(id));
  }
  if (m.size === 0) jobsBySession.delete(key);
}

function finalizeJob(h: JobHandle, code: number | null, _signal: string | null): void {
  h.code = code;
  h.endedAt = Date.now();
  if (h.killRequested) h.status = "killed";
  else if (code === null) h.status = "killed";
  else h.status = code === 0 ? "done" : "failed";
}

/** 杀进程树（Windows taskkill /F /T；POSIX 进程组负 pid） */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      // 已在 spawn 时 detached: false + shell: true（cmd.exe）——taskkill /T 递归杀 cmd 树
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
    } else {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    /* 杀失败忽略（进程可能已退出） */
  }
}

/**
 * 启动后台任务：spawn 直跑（软沙箱语义：cwd 校验 + env 消毒；审批/断网/审计由 run_command 启动前完成）。
 * 返回句柄；完成后 status 更新 + emit job-done（落库审计）+ v3.3 emit task-notification 完成通知
 * （前端通知行 + 父循环上下文注入——notify 回调由 run_command 透传 ToolContext.enqueueTaskNotification）。
 */
export function startBackgroundJob(
  command: string,
  cwd: string,
  sessionId: string | undefined,
  parentDepth: number,
  emit: (e: import("@infu/shared").AgentEvent) => void,
  notify?: (note: {
    taskType: "subagent" | "job";
    taskId: string;
    name: string;
    status: "completed" | "failed" | "stopped" | "killed";
    summary: string;
    outputFile?: string;
  }) => void
): JobHandle {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`目录不存在: ${cwd}`);
  }
  const map = jobsOf(sessionId);
  const active = [...map.values()].filter((j) => j.status === "running").length;
  if (active >= MAX_JOBS_PER_SESSION) {
    throw new Error(`后台任务已达上限（${MAX_JOBS_PER_SESSION} 个运行中）——请先 job_kill 或等待完成`);
  }
  const id = genJobId();
  const handle: JobHandle = {
    id,
    command,
    cwd,
    status: "running",
    code: null,
    out: "",
    startedAt: Date.now(),
    parentDepth,
    killRequested: false,
    child: null as unknown as ChildProcess,
  };

  // Windows 走 cmd.exe（与 runShell 一致）；POSIX bash；detached 建进程组（杀树用）
  const child = spawn(command, {
    cwd,
    env: sanitizeEnv(),
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  handle.child = child;

  const append = (chunk: Buffer | string) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    handle.out = (handle.out + s).slice(-JOB_OUTPUT_LIMIT);
  };
  // v2.13：spawn 失败时 error 与 close 都会触发（Node 行为）——finalized 去重只发一次 job-done；
  // spawn 失败（命令不存在等）标 failed 而非 killed（code===null 且非 killRequested）
  let finalized = false;
  const finishOnce = (code: number | null, signal: string | null, spawnError = false) => {
    if (finalized) return;
    finalized = true;
    if (spawnError) {
      handle.code = null;
      handle.endedAt = Date.now();
      handle.status = "failed";
    } else {
      finalizeJob(handle, code, signal);
    }
    emit({ type: "job-done", id, code: handle.code, ok: handle.status === "done" });
    // v3.3 异步任务编排：job 完成通知（killed=被杀 / completed=退出码 0 / failed=失败或 spawn 错误）
    // 摘要 = 输出尾部 + 退出码（上下文预算裁剪；完整输出 job_output 可查）
    const tail = (handle.out || "(无输出)").slice(-500);
    const note = {
      taskType: "job" as const,
      taskId: id,
      name: command.slice(0, 120),
      status: handle.status === "killed" ? ("killed" as const) : handle.status === "done" ? ("completed" as const) : ("failed" as const),
      summary:
        `命令「${command.slice(0, 120)}」已结束（${handle.status}${handle.code != null ? `，退出码 ${handle.code}` : ""}）。输出尾部：\n${tail}`,
    };
    emit({ type: "task-notification", ...note });
    notify?.(note);
    // v3.4 审计修复（M6）：完成即剪枝（已完成条目保留最近 20 个）
    trimJobRegistry(sessionId);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (e) => {
    append(`\n[后台任务错误] ${e.message}`);
    finishOnce(null, null, true);
  });
  child.on("close", (code, signal) => {
    finishOnce(code, signal);
  });

  map.set(id, handle);
  emit({ type: "job-start", id, command });
  return handle;
}

/** v2.11：列出会话内全部后台任务（job_list 工具） */
export function listJobs(sessionId: string | undefined): JobHandle[] {
  return [...jobsOf(sessionId).values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** v2.11：查后台任务（job_output/job_kill 工具；不存在返回 null） */
export function getJob(sessionId: string | undefined, id: string): JobHandle | null {
  return jobsOf(sessionId).get(id) ?? null;
}

/** v2.11：读任务输出（job_output 工具；tail 可选只看尾部） */
export function getJobOutput(sessionId: string | undefined, id: string, tail?: number): string {
  const h = getJob(sessionId, id);
  if (!h) return `错误：未找到后台任务 ${id}（用 job_list 查看当前会话的后台任务）`;
  const body = h.out || "(无输出)";
  const out = tail && tail > 0 ? body.slice(-tail) : body;
  return `后台任务 ${id}（${h.status}${h.code != null ? `，退出码 ${h.code}` : ""}，已运行 ${Math.round((Date.now() - h.startedAt) / 1000)}s）：\n${out}`;
}

/** v2.11：中止后台任务（job_kill 工具；杀进程树） */
export function killJob(sessionId: string | undefined, id: string): string {
  const h = getJob(sessionId, id);
  if (!h) return `错误：未找到后台任务 ${id}（用 job_list 查看当前会话的后台任务）`;
  if (h.status !== "running") return `后台任务 ${id} 已${h.status}（退出码 ${h.code}），无需终止`;
  h.killRequested = true;
  killProcessTree(h.child);
  return `已请求终止后台任务 ${id}（进程树将被强制结束）`;
}

/** v2.11：中止由指定委派深度启动的全部后台任务（任务结束调用——子任务随父结束）；
 *  v2.13：depth < 0 = 会话内全部（后台子智能体内部启动的 job 也一并终止） */
export function abortJobsByDepth(sessionId: string | undefined, parentDepth: number): void {
  const key = sessionId ?? "";
  const m = jobsBySession.get(key);
  if (!m) return;
  for (const h of [...m.values()]) {
    if ((parentDepth < 0 || h.parentDepth === parentDepth) && h.status === "running") {
      h.killRequested = true;
      killProcessTree(h.child);
    }
  }
}

/** 审计辅助（job 启动的 run_command 路径调用；沙箱标签 soft-bg） */
export function auditJobStart(root: string, command: string, jobId: string): void {
  auditCommand(root, command, true, `后台任务 ${jobId} 已启动`, "soft-bg");
}
