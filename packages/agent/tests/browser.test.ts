/**
 * v2.7 批 1 browser-use 插件自测（真实 playwright chromium + 本地 HTTP）
 * 运行：npx tsx packages/agent/tests/browser.test.ts
 */
import { browserTools } from "../src/plugin/browser/tools.js";
import { resolveChromiumPath, closeBrowser } from "../src/plugin/browser/runtime.js";
import { listMarketplacePlugins, findMarketplacePlugin } from "../src/plugin/marketplace.js";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, AgentEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== v2.7 browser-use 插件自测 ===\n");

// 1. chromium 探测
console.log("▶ chromium 探测");
const chromePath = resolveChromiumPath();
check("找到 chromium 可执行文件", !!chromePath, String(chromePath));

// 2. 参数防御（不启动浏览器）
console.log("\n▶ 参数防御");
const proj = mkdtempSync(join(tmpdir(), "infu-browser-"));
const events: AgentEvent[] = [];
const ctx: ToolContext = {
  root: proj, cwd: proj,
  requestApproval: async () => true,
  emit: (e) => events.push(e),
};
const tool = (name: string) => browserTools.find((t) => t.name === name)!;
const badUrl = await tool("browser_navigate").execute({ url: "ftp://x" }, ctx);
check("navigate 非 http 拒绝", badUrl.includes("http/https"), badUrl);

// 3. 真实浏览器 smoke（本地 http server）
if (chromePath) {
  console.log("\n▶ 真实浏览器 smoke");
  let server: Server;
  let base = "";
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!DOCTYPE html><html><head><title>InFu 浏览器测试页</title></head><body><h1>Hello Browser</h1><input placeholder="用户名"><button>提交</button><a href="/about">关于</a></body></html>`);
    });
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      resolve();
    });
  });
  try {
    const nav = await tool("browser_navigate").execute({ url: base }, ctx);
    check("navigate 打开本地页面", nav.includes("Hello Browser") && nav.includes("InFu 浏览器测试页"), nav.slice(0, 200));
    check("snapshot 含可交互元素", nav.includes("[1]") && nav.includes("用户名") && nav.includes("提交"), nav.slice(0, 300));
    const shot = await tool("browser_screenshot").execute({ name: "smoke" }, ctx);
    check("截图保存到 .infu/browser", shot.includes(".infu") && shot.includes("browser") && shot.includes(".png"), shot);
    const traversalShot = await tool("browser_screenshot").execute({ name: "../escape\\nested" }, ctx);
    const traversalPath = traversalShot.replace("截图已保存：", "").trim();
    check("截图文件名阻止路径穿越", traversalPath.startsWith(join(proj, ".infu", "browser")) && !traversalPath.includes(".."), traversalPath);
    const snap = await tool("browser_snapshot").execute({}, ctx);
    check("snapshot 返回页面状态", snap.includes("Hello Browser"), snap.slice(0, 200));
    const submitIndex = /\[(\d+)\].*提交/.exec(snap)?.[1];
    await tool("browser_eval").execute({ code: "document.querySelector('button').dataset.clicked = 'yes'; document.body.insertAdjacentHTML('afterbegin', '<button>新按钮</button>')" }, ctx);
    const clicked = submitIndex ? await tool("browser_click").execute({ target: submitIndex }, ctx) : "";
    const clickState = await tool("browser_eval").execute({ code: "return document.querySelector('button[data-clicked]')?.dataset.clicked" }, ctx);
    check("编号点击使用快照句柄而非重建编号", clicked.includes("已点击") && clickState.includes("yes"), `${clicked}\n${clickState}`);
  } finally {
    await tool("browser_close").execute({}, ctx);
    server.close();
  }
} else {
  console.log("⚠ 无 chromium，跳过真实浏览器 smoke");
}

// 4. 插件市场雏形
console.log("\n▶ 插件市场");
const mp = listMarketplacePlugins();
check("市场含 browser-use", mp.some((p) => p.id === "browser-use"), JSON.stringify(mp.map((p) => p.id)));
const bup = findMarketplacePlugin("browser-use");
check("市场插件模块路径存在", !!bup && existsSync(bup.path), bup?.path);
check("市场插件含技能目录", !!bup, JSON.stringify(bup?.path));
check("未知插件 → null", findMarketplacePlugin("nope") === null);

// 清理
rmSync(proj, { recursive: true, force: true });
await closeBrowser();

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
