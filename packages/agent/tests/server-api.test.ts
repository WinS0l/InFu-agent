/**
 * v3.6 server API 回归测试（审计修复）
 * 覆盖：
 *  1. POST /api/approvals/bypass 路由顺序回归——v3.5 曾因注册在 /api/approvals/:id
 *     之后被 :id 吞掉（返回「审批不存在或已过期」，按钮点了没反应）；bypass 必须可达
 *  2. DELETE /api/sessions/:id 联动清理（outputs/browser 前缀文件 + attachments 目录 +
 *     截图）——cleanup 测试此前测的是复制粘贴的副本，这里直接测 server 真实代码
 *  3. 本地令牌鉴权（staticDir 存在时 /api/* 无 token → 401）
 * 运行：npx tsx packages/agent/tests/server-api.test.ts
 */
import { createApp } from "../src/server.js";
import { setDataDirForTest } from "../src/data-dir.js";
import { getStore, resetStore } from "../src/db/store.js";
import { createProject } from "../src/projects.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// 数据目录重定向（原测试会碰真实 ~/.infu；store 单例需在首次 getStore 前重定向）
const tmpData = mkdtempSync(join(tmpdir(), "infu-server-api-"));
setDataDirForTest(tmpData);
resetStore(); // 确保用重定向目录
writeFileSync(join(tmpData, "index.html"), "<!doctype html><html><head></head><body></body></html>", "utf-8");

console.log("\n=== server API 回归（server-api）自测 ===\n");

const rawApp = createApp({ staticDir: tmpData });
const tokenHtml = await (await rawApp.fetch(new Request("http://localhost/"))).text();
const token = /window\.__INFU_TOKEN__="([0-9a-f]{32})"/.exec(tokenHtml)?.[1] ?? "";
const app = {
  fetch(input: Request) {
    const headers = new Headers(input.headers);
    headers.set("x-infu-token", token);
    return rawApp.fetch(new Request(input, { headers }));
  },
};

// ── 0. Agent 健康信息契约（供欢迎页和桌面托盘使用）──
console.log("▶ Agent 健康信息");
{
  const health = await app.fetch(new Request("http://localhost/api/health"));
  const data = await health.json() as { ok?: boolean; name?: string; version?: string; uptimeSeconds?: number; tools?: number; sessions?: number; diagnostics?: { database?: string; models?: string; configuredModels?: number; sandbox?: string; browser?: string } };
  check("健康检查返回结构化运行信息", health.status === 200 && data.ok === true && data.name === "infu-agent" && typeof data.version === "string" && typeof data.uptimeSeconds === "number" && typeof data.tools === "number" && typeof data.sessions === "number", JSON.stringify(data));
  check("健康检查不泄露凭据且包含诊断摘要", data.diagnostics?.database === "ready" && typeof data.diagnostics.configuredModels === "number" && ["configured", "missing"].includes(data.diagnostics.models ?? "") && ["ready", "unavailable"].includes(data.diagnostics.sandbox ?? "") && ["available", "disabled"].includes(data.diagnostics.browser ?? "") && !JSON.stringify(data).toLowerCase().includes("apikey"), JSON.stringify(data.diagnostics));
}

// ── 1. /api/approvals/bypass 路由顺序回归（bypass 不被 :id 吞掉）──
// v4.0 审计修复（H1 缓解）：bypass 必须针对已存在会话（404）+ 开启动作落库审计事件
console.log("▶ approvals/bypass 路由");
{
  const sid = getStore().createSession({ title: "bypass 测试", root: tmpData });
  const r1 = await app.fetch(new Request("http://localhost/api/approvals/bypass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: sid, enabled: true }),
  }));
  const j1 = (await r1.json()) as { ok?: boolean; bypass?: boolean; message?: string };
  check("bypass 开启可达（未被 :id 吞掉）", r1.status === 200 && j1.ok === true && j1.bypass === true, JSON.stringify(j1));

  const r2 = await app.fetch(new Request("http://localhost/api/approvals/bypass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: sid, enabled: false }),
  }));
  const j2 = (await r2.json()) as { bypass?: boolean };
  check("bypass 关闭", j2.bypass === false, JSON.stringify(j2));

  // v4.0：不存在的会话拒绝开启（防任意会话预埋）
  const r404 = await app.fetch(new Request("http://localhost/api/approvals/bypass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "no-such-session", enabled: true }),
  }));
  check("bypass 不存在会话 → 404", r404.status === 404, String(r404.status));

  // v4.0：开启动作落库审计事件（approval-bypass）
  const events = getStore().getEvents(sid);
  check("bypass 开启落库审计事件", events.some((e) => e.event.type === "approval-bypass" && e.event.enabled === true), JSON.stringify(events.map((e) => e.event.type)));

  const r3 = await app.fetch(new Request("http://localhost/api/approvals/bypass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }));
  const j3 = (await r3.json()) as { message?: string };
  check("缺 sessionId 拒绝", j3.message?.includes("sessionId") === true, JSON.stringify(j3));
}

// ── 2. DELETE /api/sessions/:id 联动清理（真实 server 代码，非复制粘贴副本）──
console.log("\n▶ 会话删除联动清理");
{
  const store = getStore();
  const proj = mkdtempSync(join(tmpdir(), "infu-sa-proj-"));
  // 造会话 + 磁盘产物（outputs/browser 前缀文件 + attachments 目录 + 截图）
  const sid = store.createSession({ title: "联动清理测试", root: proj });
  const sid8 = sid.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8);
  const outputsDir = join(proj, ".infu", "outputs");
  const browserDir = join(proj, ".infu", "browser");
  const shotsDir = join(proj, ".infu", "screenshots");
  mkdirSync(outputsDir, { recursive: true });
  mkdirSync(browserDir, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });
  const ownOut = join(outputsDir, `${sid8}-abc.log`);
  const ownShot = join(shotsDir, `screen-${sid8}-1.png`);
  const ownBrowser = join(browserDir, `${sid8}-x.png`);
  const otherOut = join(outputsDir, "other-session.log"); // 其他会话文件必须保留
  writeFileSync(ownOut, "x");
  writeFileSync(ownShot, "x");
  writeFileSync(ownBrowser, "x");
  writeFileSync(otherOut, "x");
  const attachDir = join(tmpData, "attachments", sid);
  mkdirSync(attachDir, { recursive: true });
  writeFileSync(join(attachDir, "a.txt"), "x");
  store.appendEvent(sid, { type: "user-message", text: "t" });

  const r = await app.fetch(new Request(`http://localhost/api/sessions/${sid}`, { method: "DELETE" }));
  check("删除返回 ok", (await r.json()).ok === true);

  check("会话记录已删除", store.getSession(sid) === null);
  check("本会话 outputs 文件已删", !existsSync(ownOut));
  check("本会话 browser 文件已删", !existsSync(ownBrowser));
  check("本会话截图已删", !existsSync(ownShot));
  check("其他会话 outputs 保留", existsSync(otherOut));
  check("attachments 目录已删", !existsSync(attachDir));
}

// ── 3. 本地令牌鉴权（staticDir 存在时 /api/* 无 token → 401）──
console.log("\n▶ 本地令牌鉴权");
{
  const staticDir = mkdtempSync(join(tmpdir(), "infu-sa-static-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><html><head></head><body></body></html>", "utf-8");
  const secured = createApp({ staticDir });
  const r = await secured.fetch(new Request("http://localhost/api/health"));
  check("无 token 访问 /api/* → 401", r.status === 401);
  const r2 = await secured.fetch(new Request("http://localhost/api/health", {
    headers: { "x-infu-token": "wrong-token" },
  }));
  check("错误 token → 401", r2.status === 401);
  // token 注入 index.html（前端读取凭据的载体）
  const html = await (await secured.fetch(new Request("http://localhost/"))).text();
  check("index.html 注入 window.__INFU_TOKEN__", /window\.__INFU_TOKEN__="[0-9a-f]{32}"/.test(html));
}


// ── 3.5 后台任务中断 API（追踪胶囊调用；必须限定到会话）──
console.log("\n▶ 后台任务中断 API");
{
  const sid = getStore().createSession({ title: "job kill API", root: tmpData });
  const catalog = await app.fetch(new Request("http://localhost/api/agents/tools"));
  const catalogData = await catalog.json() as { tools?: Array<{ name: string }> };
  check("子 Agent 工具目录返回全部可注入工具", catalog.status === 200 && catalogData.tools?.some((tool) => tool.name === "web_search") === true && catalogData.tools?.some((tool) => tool.name === "run_command") === true && !catalogData.tools?.some((tool) => tool.name === "delegate_task"), JSON.stringify(catalogData.tools?.map((tool) => tool.name)));
  const missingSid = await app.fetch(new Request("http://localhost/api/jobs/nope/kill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "nope" }) }));
  check("后台任务中断拒绝不存在会话", missingSid.status === 404, String(missingSid.status));
  const noJob = await app.fetch(new Request("http://localhost/api/jobs/nope/kill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid }) }));
  const noJobData = await noJob.json() as { ok?: boolean; message?: string };
  check("后台任务中断拒绝未知 job", noJob.status === 200 && noJobData.ok === false && noJobData.message?.includes("未找到") === true, JSON.stringify(noJobData));
}

// ── 4. Arbitrary filesystem roots must be server-authorized ──
console.log("\n▶ API root authorization");
{
  const privateRoot = mkdtempSync(join(tmpdir(), "infu-sa-private-"));
  writeFileSync(join(privateRoot, "secret.txt"), "not an authorized project", "utf-8");
  const denied = await app.fetch(new Request(`http://localhost/api/fs/file?root=${encodeURIComponent(privateRoot)}&path=secret.txt`));
  check("未注册任意 root → 400", denied.status === 400, String(denied.status));
  const registered = createProject(privateRoot, "授权项目");
  const allowed = await app.fetch(new Request(`http://localhost/api/fs/file?root=${encodeURIComponent(privateRoot)}&path=secret.txt`));
  const allowedJson = await allowed.json() as { content?: string };
  check("注册项目 root 可读取", registered.ok && allowed.status === 200 && allowedJson.content === "not an authorized project", JSON.stringify(allowedJson));
}

// ── 5. 终端双字段旁路回归（v3.7）：command 与 data 并存时 data 段同样过高危检测 ──
console.log("\n▶ 终端双字段高危检测（command + data 并存）");
{
  const terminalRoot = mkdtempSync(join(tmpdir(), "infu-sa-terminal-"));
  const terminalOwner = getStore().createSession({ title: "终端测试", root: terminalRoot });
  const t = await app.fetch(new Request("http://localhost/api/terminal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: terminalOwner }),
  }));
  const tj = (await t.json()) as { ok?: boolean; id?: string };
  if (!tj.ok || !tj.id) {
    check("终端会话创建（前置）", false, JSON.stringify(tj));
  } else {
    const tid = tj.id;
    // 此前漏洞：{command:"echo ok", data:"rm -rf C:\r\n"} 时 data 段跳过检测 → 200 直写
    const r = await app.fetch(new Request(`http://localhost/api/terminal/${tid}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: terminalOwner, command: "echo ok", data: "rm -rf C:\r\n" }),
    }));
    const j = (await r.json()) as { requireApproval?: boolean; risk?: string };
    check("command+data 并存时 data 高危 → requireApproval", r.status === 200 && j.requireApproval === true && j.risk === "high", JSON.stringify(j));

    const r2 = await app.fetch(new Request(`http://localhost/api/terminal/${tid}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: terminalOwner, command: "rm -rf C:", data: "rm -rf C:\r\n", confirmed: true }),
    }));
    const j2 = (await r2.json()) as { ok?: boolean };
    check("confirmed:true 后放行", j2.ok === true, JSON.stringify(j2));

    const r3 = await app.fetch(new Request(`http://localhost/api/terminal/${tid}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: terminalOwner, command: "echo ok", data: "" }),
    }));
    const j3 = (await r3.json()) as { ok?: boolean; requireApproval?: boolean };
    check("command-only 也过检测（echo ok 放行）", j3.ok === true, JSON.stringify(j3));

    const r4 = await app.fetch(new Request(`http://localhost/api/terminal/${tid}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: terminalOwner, command: "del /s /q C:", data: "" }),
    }));
    const j4 = (await r4.json()) as { requireApproval?: boolean };
    check("command-only 高危 → requireApproval", j4.requireApproval === true, JSON.stringify(j4));

    await app.fetch(new Request(`http://localhost/api/terminal/${tid}?sessionId=${encodeURIComponent(terminalOwner)}`, { method: "DELETE" }));
  }
}

// ── 5. rewind 运行中拒绝回归（v3.7）：running 会话回滚 → 400 ──
console.log("\n▶ rewind 运行中拒绝");
{
  const store = getStore();
  const proj = mkdtempSync(join(tmpdir(), "infu-sa-rewind-"));
  const sid = store.createSession({ title: "rewind 竞态测试", root: proj });
  store.appendEvent(sid, { type: "user-message", text: "t" });
  store.updateStatus(sid, "running");
  const r = await app.fetch(new Request(`http://localhost/api/sessions/${sid}/rewind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seq: 0 }),
  }));
  const j = (await r.json()) as { ok?: boolean; message?: string };
  check("running 会话回滚 → 400 + 提示先停止", r.status === 400 && j.ok !== true && (j.message ?? "").includes("运行"), JSON.stringify(j));
  // 停止后可回滚（原链路不破坏）
  store.updateStatus(sid, "stopped");
  const r2 = await app.fetch(new Request(`http://localhost/api/sessions/${sid}/rewind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seq: 0 }),
  }));
  const j2 = (await r2.json()) as { ok?: boolean };
  check("停止后回滚正常（原链路保留）", j2.ok === true, JSON.stringify(j2));
}

// 清理
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
