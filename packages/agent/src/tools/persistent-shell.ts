/**
 * 持久 shell 会话（v3.0 批 11）——跨 run_command 调用保留 cwd/env（主流 bash-persistent 同款）
 * 协议：spawn 常驻 shell，每次执行写入命令 + 唯一结束标记，读取直到标记返回输出。
 * 安全边界：持久会话进程脱离沙箱（进程已起，受限令牌无法施加）——仅 medium 审批 +
 * 断网策略仍生效（命令文本照常过 detectEgress 门禁）；高风险命令审批逻辑与同步一致。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sanitizeEnv } from "../sandbox/index.js";

interface ShellSession {
  proc: ChildProcessWithoutNullStreams;
  cwd: string;
  createdAt: number;
}

const sessions = new Map<string, ShellSession>();

/** v3.6 审计修复：单次调用输出上限（环形裁剪）——原 out += text 无上限，
 *  刷屏命令（type 大文件 / for 循环输出）在超时前可吃满内存（对比 jobs.ts 的 512KB） */
const SHELL_OUTPUT_LIMIT = 512 * 1024;

function shellCmd(): { file: string; args: string[] } {
  return process.platform === "win32"
    ? { file: "cmd.exe", args: ["/Q"] }
    : { file: "/bin/bash", args: ["--norc", "--noprofile", "-i"] };
}

/** 会话是否存活：proc.killed 只表示「已调用过 kill」——进程自然退出/崩溃时
 *  killed=false 但 stdio 已关，向已死会话写 stdin 会 EPIPE（审计修复）；
 *  kill 后即使进程已死 'exit' 事件也可能长期不触发（Windows libuv 收割延迟），
 *  killed=true 一律视为不可复用（审计修复 H-2） */
function sessionAlive(s: ShellSession): boolean {
  return !s.proc.killed && s.proc.exitCode === null && s.proc.signalCode === null;
}

/** 审计修复（H-2）：kill 后显式销毁 stdio 管道 + unref——Windows 下 cmd 进程被
 *  TerminateProcess 后 'exit' 事件可能长期不触发（libuv 收割延迟/幽灵句柄），
 *  管道 Socket 与子进程句柄保持活跃 → Node 事件循环永不退出（CLI 任务跑完进程挂死、
 *  常驻服务句柄累积）。unref() 让 Node 不再等待该子进程，destroy 释放管道句柄。 */
function killSession(s: ShellSession): void {
  try { s.proc.kill(); } catch { /* 忽略 */ }
  try { s.proc.unref(); } catch { /* 忽略 */ }
  for (const stream of [s.proc.stdin, s.proc.stdout, s.proc.stderr]) {
    try { stream.destroy(); } catch { /* 忽略 */ }
  }
}

/** 获取（或创建）会话；root 变化时自动重建（cwd 跟随项目） */
export function getShellSession(sessionId: string, root: string): ShellSession {
  const existing = sessions.get(sessionId);
  if (existing && existing.cwd === root && sessionAlive(existing)) return existing;
  if (existing) {
    killSession(existing);
    sessions.delete(sessionId);
  }
  const { file, args } = shellCmd();
  // v3.0 审计修复（S3）：环境变量消毒——持久会话进程带完整宿主 env（含 INFU_*_API_KEY）
  // 且脱离沙箱，模型可用 echo 读取凭据回显；改走 sanitizeEnv 剔除敏感键。
  const proc = spawn(file, args, {
    cwd: root,
    windowsHide: true,
    env: { ...sanitizeEnv(), INFU_PERSISTENT_SHELL: "1" },
  });
  const session: ShellSession = { proc, cwd: root, createdAt: Date.now() };
  // v3.1 审计修复：进程级退出清理只在创建时挂一次（原来每次 execPersistent 都挂 exit 监听，
  // 永不移除 → 长会话 N 次调用累积 N 个监听器 + 闭包持续 append 后续输出，内存无界增长）
  // 审计修复（H-2）：exit 监听必须比对会话对象身份再删——kill 是异步的，旧会话进程
  // 退出时新会话可能已存入同 id（close→重建竞态），按 id 盲删会把新会话误删，
  // 致其永不 kill（残留健康 cmd.exe 拖住事件循环 + 目录句柄占用，实测复现）
  proc.once("exit", () => {
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
  });
  // 审计修复：stdin EPIPE 事件必须有监听（无监听器即 throw 崩宿主进程）
  proc.stdin.on("error", () => { /* stdin 已关闭 */ });
  proc.on("error", () => { /* spawn 失败/进程异常，exit 清理兜底 */ });
  sessions.set(sessionId, session);
  return session;
}

/** 在持久会话执行命令，返回输出（成功标记出现即返回；超时中止） */
export function execPersistent(sessionId: string, root: string, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const session = getShellSession(sessionId, root);
    const marker = `__INFU_END_${randomUUID().slice(0, 8)}__`;
    let out = "";
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // v3.1 审计修复：移除本次调用的监听器（原实现从不移除——settle 后旧监听仍存活，
      // 持续向闭包 out 追加后续输出 = 内存无界增长）
      session.proc.stdout.removeListener("data", onData);
      session.proc.stderr.removeListener("data", onErrData);
      if (err) reject(err);
      else resolvePromise(out);
    };
    const timer = setTimeout(() => {
      // v4.0 审计修复（M1）：管道 stdin 下 `\x03` 只是普通字节（cmd/bash 均不产生
      // SIGINT——中断依赖控制台信号而非字节流），原实现「已发送中断」是假消息，
      // 命令继续运行且残留输出（含旧 marker）会混入下一次调用，导致结果错位。
      // 处理：销毁整个持久会话（下一次调用自动重建）——残留输出随进程消失，杜绝串扰；
      // 文案如实说明命令可能仍在运行（持久会话本就不受 L1.5 约束，孤儿进程由 OS 回收）。
      // 审计修复（H-2）：kill + destroy 管道（防幽灵句柄拖住事件循环）
      killSession(session);
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      finish(new Error(`命令超时（${timeoutMs}ms）——已终止持久会话，命令可能仍在运行（输出已丢弃尾部）；输出：${out.slice(-500)}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      // v3.6：环形裁剪（marker 恒在输出尾部——命令执行后 echo，裁剪保留尾部不受影响）
      out = (out + text).slice(-SHELL_OUTPUT_LIMIT);
      if (out.includes(marker)) {
        // 去掉标记行与尾部提示符残留
        const idx = out.lastIndexOf(marker);
        out = out.slice(0, idx).replace(/\x1b\[[0-9;]*m/g, "");
        finish(null);
      }
    };
    const onErrData = (chunk: Buffer) => {
      // v4.0 审计修复：stderr 同样环形裁剪（原实现只裁剪 stdout 路径——纯 stderr 刷屏
      // 命令在超时前可吃满内存，与 v3.6 对 stdout 的修复同型遗漏）
      out = (out + chunk.toString("utf-8")).slice(-SHELL_OUTPUT_LIMIT);
    };
    session.proc.stdout.on("data", onData);
    session.proc.stderr.on("data", onErrData);

    // 命令 + 标记（换行结尾触发执行；cmd 与 bash 均支持）
    // 审计修复：写前确认存活 + try/catch——会话在 getShellSession 与 write 之间
    // 退出（进程自然退出/超时销毁）时，向已关 stdin 写入 = EPIPE 崩宿主进程
    if (!sessionAlive(session)) {
      sessions.delete(sessionId);
      finish(new Error("持久 shell 会话已退出，请重试（已自动清除失效会话）"));
      return;
    }
    try {
      session.proc.stdin.write(`${command}\necho ${marker}\n`);
    } catch {
      sessions.delete(sessionId);
      finish(new Error("持久 shell 会话写入失败（进程可能已退出），请重试"));
    }
  });
}

/** 关闭会话（shell_reset / 任务结束清理） */
export function closeShellSession(sessionId?: string): void {
  if (sessionId) {
    const s = sessions.get(sessionId);
    if (s) {
      killSession(s);
      sessions.delete(sessionId);
    }
    return;
  }
  for (const [id, s] of sessions) {
    killSession(s);
    sessions.delete(id);
  }
}

/** 活跃会话数（测试/审计用） */
export function shellSessionCount(): number {
  return sessions.size;
}
