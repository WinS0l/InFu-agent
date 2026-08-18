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

/** 获取（或创建）会话；root 变化时自动重建（cwd 跟随项目） */
export function getShellSession(sessionId: string, root: string): ShellSession {
  const existing = sessions.get(sessionId);
  if (existing && existing.cwd === root && !existing.proc.killed) return existing;
  if (existing) {
    try { existing.proc.kill(); } catch { /* 忽略 */ }
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
  proc.once("exit", () => {
    sessions.delete(sessionId);
  });
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
      // 超时：终止当前命令（Ctrl+C 语义）并返回已收集输出
      try { session.proc.stdin.write("\x03"); } catch { /* 忽略 */ }
      finish(new Error(`命令超时（${timeoutMs}ms）——已发送中断；输出：${out.slice(-500)}`));
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
      out += chunk.toString("utf-8");
    };
    session.proc.stdout.on("data", onData);
    session.proc.stderr.on("data", onErrData);

    // 命令 + 标记（换行结尾触发执行；cmd 与 bash 均支持）
    session.proc.stdin.write(`${command}\necho ${marker}\n`);
  });
}

/** 关闭会话（shell_reset / 任务结束清理） */
export function closeShellSession(sessionId?: string): void {
  if (sessionId) {
    const s = sessions.get(sessionId);
    if (s) {
      try { s.proc.kill(); } catch { /* 忽略 */ }
      sessions.delete(sessionId);
    }
    return;
  }
  for (const [id, s] of sessions) {
    try { s.proc.kill(); } catch { /* 忽略 */ }
    sessions.delete(id);
  }
}

/** 活跃会话数（测试/审计用） */
export function shellSessionCount(): number {
  return sessions.size;
}
