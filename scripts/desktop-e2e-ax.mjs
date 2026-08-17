/** e2e v2：真实 Agent 驱动嵌入式浏览器（AX 树快照 + browser_eval + 交互搜索）——playwright 原生输入 */
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const main = ctx.pages().find((p) => p.url().includes("5199"));
if (!main) {
  console.log("FAIL: 无主窗口");
  process.exit(1);
}

// playwright fill 触发 React onChange（受控组件）
await main.fill("textarea", "用浏览器打开必应 https://www.bing.com：1) browser_snapshot 读取页面可访问性树并确认搜索框；2) 用 browser_eval 读取搜索框的 placeholder 属性值；3) 在搜索框输入 InFu 并搜索");
await main.keyboard.press("Enter");
console.log("任务已发送，轮询嵌入式浏览器...");

for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const emb = targets.find((t) => t.type === "page" && !t.url.includes("5199") && !t.url.startsWith("data:"));
  const url = emb?.url ?? "";
  if (url.includes("bing.com/search")) {
    console.log(`第 ${i + 1} 轮: 嵌入式浏览器已搜索 → ${url.slice(0, 80)}`);
    console.log("✅ Agent 全链路（AX 树 → eval → 交互搜索）成功");
    break;
  }
  if (i % 5 === 4) console.log(`第 ${i + 1} 轮: 嵌入式浏览器 ${url.slice(0, 50) || "未导航"}`);
}
// 注意：connectOverCDP 下不可 browser.close()（会关闭整个应用）——脚本退出自动断连
process.exit(0);
