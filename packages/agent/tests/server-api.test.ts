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

console.log("\n=== server API 回归（server-api）自测 ===\n");

const app = createApp({});

// ── 1. /api/approvals/bypass 路由顺序回归（bypass 不被 :id 吞掉）──
console.log("▶ approvals/bypass 路由");
{
  const r1 = await app.fetch(new Request("http://localhost/api/approvals/bypass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "server-api-test-s1", enabled: true }),
  }));
  const j1 = (await r1.json()) as { ok?: boolean; bypass?: boolean; message?: string };
  check("bypass 开启可达（未被 :id 吞掉）", r1.status === 200 && j1.ok === true && j1.bypass === true, JSON.stringify(j1));

  const r2 = await app.fetch(new Request("http://localhost/api/approvals/bypass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "server-api-test-s1", enabled: false }),
  }));
  const j2 = (await r2.json()) as { bypass?: boolean };
  check("bypass 关闭", j2.bypass === false, JSON.stringify(j2));

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

// 清理
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
