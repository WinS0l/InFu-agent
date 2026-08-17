/** browser-use 桌面模式链路实测：connectOverCDP → 找嵌入式页（无则点开浏览器 tab）→ 导航 → 验证 */
import { chromium } from "playwright-core";

// 视图未打开时：模拟主进程 __infuOpenEmbeddedBrowser 的渲染侧等价物（点开浏览器 tab）
async function openBrowserTab() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("5199"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const res = await new Promise((r, j) => {
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m.result); };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
      expression: `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim().startsWith('浏览器')); if (b) { b.click(); return true; } return false; })()`,
      returnByValue: true,
    } }));
    setTimeout(() => j(new Error("open tab timeout")), 8000);
  });
  ws.close();
  return res.result.value;
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
let page = null;
// 1) data: 起始页
page = ctx.pages().find((p) => p.url().startsWith("data:")) ?? null;
// 2) 非主窗口页
if (!page) page = ctx.pages().find((p) => !p.url().startsWith("http://localhost:5199") && !p.url().startsWith("http://127.0.0.1")) ?? null;
// 3) 视图未打开 → 点开浏览器 tab 后重试（runtime 的 __infuOpenEmbeddedBrowser 同效）
if (!page) {
  const opened = await openBrowserTab();
  console.log("自动打开浏览器 tab:", opened);
  await new Promise((r) => setTimeout(r, 2000));
  page = ctx.pages().find((p) => p.url().startsWith("data:")) ?? null;
  if (!page) page = ctx.pages().find((p) => !p.url().startsWith("http://localhost:5199") && !p.url().startsWith("http://127.0.0.1")) ?? null;
}
if (!page) {
  console.log("FAIL: 找不到嵌入式页面");
  console.log(ctx.pages().map((p) => p.url()).join("\n"));
  process.exit(1);
}
console.log("嵌入式页:", page.url().slice(0, 60));

// 导航（Agent 驱动 browser_navigate 的底层操作）
await page.goto("https://www.bing.com", { timeout: 30000 });
console.log("导航后 URL:", page.url());
console.log("标题:", (await page.title()).slice(0, 50));

// 交互（browser_click/type 的底层操作）
await page.fill("#sb_form_q", "InFu 桌面浏览器测试");
await page.press("#sb_form_q", "Enter");
await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
console.log("搜索后标题:", (await page.title()).slice(0, 60));

// 截图（browser_screenshot 的底层操作）
const shot = await page.screenshot({ path: "E:/InFu（Agent）/.infu-browser/desktop-verify.png" });
console.log("截图字节:", shot.length);

// 注意：connectOverCDP 下不可 browser.close()（会关闭整个应用）——脚本退出自动断连
console.log("OK: Agent 驱动链路全通");
process.exit(0);
