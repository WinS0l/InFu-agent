/**
 * Web 交互式终端自测（v2.4 批 2：高危命令策略 / 审计 / 会话生命周期 / API 审批协议）
 * 运行：npx tsx packages/agent/tests/terminal.test.ts
 *
 * 覆盖：
 *  - detectDangerousTerminalCommand：rm -rf / del /f / format / mkfs / dd 命中；普通命令不命中
 *  - auditTerminalCommand：sandbox=terminal 标签 + logPath 注入
 *  - 会话生命周期：createTerminalSession（cwd 校验/回退）/ get / writeInput / resize / kill / list / 清理
 *  - API 审批协议（createApp().request()）：未确认高危 → requireApproval 不执行；
 *    确认后执行；普通命令直接执行；不存在会话 404
 */
import { createApp } from "../src/server.js";
import {
  detectDangerousTerminalCommand, auditTerminalCommand,
} from "../src/terminal/policy.js";
import {
  createTerminalSession, getTerminalSession, writeInput, resizeSession, killTerminalSession,
  listTerminalSessions, closeAllTerminalSessions, subscribeOutput,
} from "../src/terminal/session.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== Web 交互式终端自测（v2.4 批 2）===\n");

// ── 1. 高危命令检测 ──
console.log("▶ detectDangerousTerminalCommand");
{
  check("rm -rf 命中", detectDangerousTerminalCommand("rm -rf dist") === "rm -rf");
  check("rm -rf 带路径命中", detectDangerousTerminalCommand("rm -rf node_modules") === "rm -rf");
  check("del /f 命中", detectDangerousTerminalCommand("del /f C:\\x.txt") === "del /f");
  check("rmdir /s 命中", detectDangerousTerminalCommand("rmdir /s C:\\x") === "rmdir /s");
  check("format 命中", detectDangerousTerminalCommand("format D: /q") === "format");
  check("mkfs 命中", detectDangerousTerminalCommand("mkfs.ext4 /dev/sdb1") === "mkfs");
  check("dd if= 命中", detectDangerousTerminalCommand("dd if=/dev/zero of=/dev/sda") === "dd if=");
  check("普通命令不命中", detectDangerousTerminalCommand("echo hello") === null);
  check("npm run build 不命中", detectDangerousTerminalCommand("npm run build") === null);
  check("git status 不命中", detectDangerousTerminalCommand("git status") === null);
  check("空命令不命中", detectDangerousTerminalCommand("") === null);
  check("大小写不敏感", detectDangerousTerminalCommand("RM -RF /tmp") === "RM -RF");
}

// ── 2. 审计（logPath 注入）──
console.log("▶ auditTerminalCommand");
{
  const dir = mkdtempSync(join(tmpdir(), "infu-term-audit-"));
  const log = join(dir, "commands.log");
  auditTerminalCommand("C:\\proj", "echo hi", log);
  auditTerminalCommand("C:\\proj", "rm -rf dist", log);
  const content = readFileSync(log, "utf-8");
  check("普通命令落盘", content.includes("echo hi"));
  check("高危命令落盘", content.includes("rm -rf dist"));
  check("sandbox=terminal 标签", content.includes("sandbox=terminal"));
  check("含 cwd", content.includes("C:\\proj"));
  // 空命令不落盘（行数不变）
  const before = content.length;
  auditTerminalCommand("C:\\proj", "", log);
  auditTerminalCommand("C:\\proj", "   ", log);
  check("空命令不落盘", readFileSync(log, "utf-8").length === before);
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. 会话生命周期（真实 PTY）──
console.log("▶ 会话生命周期（node-pty）");
{
  const proj = mkdtempSync(join(tmpdir(), "infu-term-sess-"));
  writeFileSync(join(proj, "marker.txt"), "hello");
  const s = createTerminalSession(proj);
  check("会话创建（id/pid）", !!s.id && typeof s.pid === "number" && s.pid > 0, JSON.stringify(s));
  check("cwd 正确", s.cwd === proj, s.cwd);
  check("shell 非空", s.shell.length > 0);
  check("getTerminalSession 命中", getTerminalSession(s.id) === s);
  check("listTerminalSessions 包含", listTerminalSessions().some((x) => x.id === s.id));
  check("getTerminalSession 未命中返回 undefined", getTerminalSession("nope") === undefined);

  // 写入 + 输出捕获（简单命令；1s 内应有输出）
  let out = "";
  const unsubscribe = subscribeOutput(getTerminalSession(s.id)!, (d) => { out += d; });
  writeInput(s, "echo pty-ok\r");
  // 等待输出（最多 3s）
  const waitUntil = Date.now() + 3000;
  while (Date.now() < waitUntil && !out.includes("pty-ok")) {
    await sleep(100);
  }
  check("写入后捕获输出（echo 回显）", out.includes("pty-ok"), JSON.stringify(out.slice(0, 120)));
  unsubscribe();

  // resize（不抛错；v3.5 审计修复：原 `check(..., true)` 恒真假阳性 → try/catch 真实断言）
  let resizeOk = true;
  try { resizeSession(s, 120, 30); } catch { resizeOk = false; }
  check("resize 不抛错", resizeOk);
  let badResizeOk = true;
  try { resizeSession(s, 0, 0); } catch { badResizeOk = false; } // 非法尺寸忽略
  check("非法 resize 忽略", badResizeOk);

  // kill
  const ok = killTerminalSession(s.id);
  check("kill 成功", ok === true);
  check("kill 后 get 为 undefined", getTerminalSession(s.id) === undefined);
  check("重复 kill 返回 false", killTerminalSession(s.id) === false);

  // cwd 不存在回退 process.cwd()
  const s2 = createTerminalSession(join(tmpdir(), "no-such-dir-xyz"));
  check("cwd 不存在回退 process.cwd()", s2.cwd === process.cwd(), s2.cwd);
  killTerminalSession(s2.id);

  // 清理
  closeAllTerminalSessions();
  check("closeAll 清空", listTerminalSessions().length === 0);
  rmSync(proj, { recursive: true, force: true });
}

// ── 4. API 审批协议（createApp().request()）──
console.log("▶ /api/terminal API 审批协议");
{
  const app = createApp();
  const proj = mkdtempSync(join(tmpdir(), "infu-term-api-"));
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // 创建会话
  const created = await post("/api/terminal", { cwd: proj });
  const c = await created.json();
  check("创建 200 + id", created.status === 200 && !!c.id, JSON.stringify(c));
  const sid = c.id as string;

  // 普通命令直接执行
  const r1 = await post(`/api/terminal/${sid}/input`, { data: "echo normal\r", command: "echo normal" });
  const j1 = await r1.json();
  check("普通命令 ok", r1.status === 200 && j1.ok === true, JSON.stringify(j1));

  // 高危未确认 → requireApproval（不执行）
  const r2 = await post(`/api/terminal/${sid}/input`, { data: "rm -rf dist\r", command: "rm -rf dist" });
  const j2 = await r2.json();
  check("高危未确认 → requireApproval", r2.status === 200 && j2.requireApproval === true && j2.risk === "high", JSON.stringify(j2));
  check("拦截描述含命令", String(j2.description ?? "").includes("rm -rf dist"));

  // 高危确认 → 执行
  const r3 = await post(`/api/terminal/${sid}/input`, { data: "rm -rf dist\r", command: "rm -rf dist", confirmed: true });
  const j3 = await r3.json();
  check("高危确认 → ok", r3.status === 200 && j3.ok === true, JSON.stringify(j3));

  // 空 data 容忍
  const r4 = await post(`/api/terminal/${sid}/input`, { data: "" });
  check("空 data ok", r4.status === 200);

  // 不存在会话 → 404
  const r5 = await post("/api/terminal/no-such-session/input", { data: "x" });
  check("不存在会话 → 404", r5.status === 404, String(r5.status));

  // resize 端点
  const r6 = await post(`/api/terminal/${sid}/resize`, { cols: 100, rows: 20 });
  check("resize 端点 ok", r6.status === 200);

  // 删除会话
  const del = await app.request(`/api/terminal/${sid}`, { method: "DELETE" });
  const d = await del.json();
  check("删除 ok", del.status === 200 && d.ok === true, JSON.stringify(d));

  // 删除后写入 → 404
  const r7 = await post(`/api/terminal/${sid}/input`, { data: "x" });
  check("删除后写入 → 404", r7.status === 404, String(r7.status));

  closeAllTerminalSessions();
  // Windows 上 PTY 子进程可能短暂占用目录句柄，清理失败不影响断言
  try { rmSync(proj, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* 忽略 */ }
}

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
// Windows 上 node-pty 的 conpty 辅助句柄（Socket/ChildProcess）可能阻止进程自然退出：
// 清理后延迟退出（npm test 串行依赖进程结束）
for (const h of process._getActiveHandles()) {
  const name = h.constructor?.name ?? "";
  if (name === "Socket" || name === "ChildProcess") {
    try { h.destroy?.(); } catch {}
    try { h.kill?.(); } catch {}
    try { h.close?.(); } catch {}
  }
}
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
