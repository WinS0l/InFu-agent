/** 桌面端验证脚本：CDP 连接 Electron → 检查主窗口页面与 API 连通性 */
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const pages = ctx.pages();
console.log("=== targets ===");
for (const p of pages) console.log(" -", p.url().slice(0, 100));

const main = pages.find((p) => p.url().includes("localhost:5199"));
if (!main) {
  console.log("FAIL: 主窗口页面未找到");
  process.exit(1);
}
console.log("\n=== 主窗口 ===");
console.log("title:", await main.title());
const info = await main.evaluate(async () => {
  // API 连通性：直接调 fetchModels 链路（走 apiFetch → API_BASE）
  try {
    const res = await fetch("/api/health");
    const health = await res.json();
    return {
      apiBase: window.location.search,
      health: health.name + " tools=" + health.tools,
      sidebarText: document.querySelector("aside")?.innerText.slice(0, 120) ?? "无侧栏",
      hasTitleBar: !!document.querySelector("[class*='app-region']") || !!document.querySelector("button[title='最小化']"),
      hasDesktopBridge: !!window.infuDesktop,
    };
  } catch (e) {
    return { error: String(e) };
  }
});
console.log("apiBase:", info.apiBase);
console.log("health:", info.health);
console.log("侧栏文本:", info.sidebarText?.replace(/\n/g, " | "));
console.log("标题栏按钮:", info.hasTitleBar);
console.log("infuDesktop 桥:", info.hasDesktopBridge);

// 脚本退出自动断连（connectOverCDP 下 close 会关闭整个应用）
process.exit(0);
