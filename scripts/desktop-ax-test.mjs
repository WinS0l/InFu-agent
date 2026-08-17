/** AX 树验证：connectOverCDP → 嵌入式页导航到构造页 → axSnapshot 输出 */
import { chromium } from "playwright-core";
import { axSnapshot } from "../packages/agent/dist/plugin/browser/ax.js";

// 构造测试页（可控结构：button/link/textbox/checkbox/heading/disabled）
const TEST_HTML = `<html><head><title>AX 测试页</title></head><body>
<h1>测试标题</h1>
<button onclick="this.textContent='已点击'">登录按钮</button>
<a href="https://example.com">示例链接</a>
<input placeholder="用户名" aria-label="用户名输入">
<input type="checkbox" checked aria-label="同意条款">
<button disabled>禁用按钮</button>
<main><p>主体文本内容</p><button>提交</button></main>
</body></html>`;
const TEST_URL = `data:text/html;charset=utf-8,${encodeURIComponent(TEST_HTML)}`;

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().startsWith("data:")) ?? null;
if (!page) page = ctx.pages().find((p) => !p.url().startsWith("http://localhost:5199")) ?? null;
if (!page) {
  // 视图未打开 → 展开右侧栏并点开浏览器 tab（折叠 rail 态需先展开）
  const main = ctx.pages().find((p) => p.url().includes("5199"));
  if (main) {
    await main.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      // 折叠 rail 展开按钮（粗体 Tab）
      const expand = btns.find((b) => (b.textContent || "").trim() === "Tab");
      if (expand) expand.click();
    });
    await new Promise((r) => setTimeout(r, 800));
    await main.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim().startsWith("浏览器"));
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 2000));
  }
  page = ctx.pages().find((p) => p.url().startsWith("data:")) ?? null;
  if (!page) page = ctx.pages().find((p) => !p.url().startsWith("http://localhost:5199")) ?? null;
}
if (!page) {
  console.log("FAIL: 无嵌入式页");
  process.exit(1);
}
await page.goto(TEST_URL, { timeout: 15000 });
await page.waitForLoadState("domcontentloaded");

const tree = await axSnapshot(page);
console.log("=== AX 树输出 ===");
console.log(tree ?? "(null)");

// 断言
const checks = [
  ["含 button 角色", tree?.includes("<button>")],
  ["含链接", tree?.includes("<link>")],
  ["含 textbox", tree?.includes("<textbox>")],
  ["含 checkbox 状态", tree?.includes("[checked]")],
  ["含禁用状态", tree?.includes("[disabled]")],
  ["含标题文本", tree?.includes("测试标题")],
  ["含 heading", tree?.includes("<heading>")],
  ["含主体文本", tree?.includes("主体文本内容")],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
// 注意：connectOverCDP 下不可 browser.close()（会关闭整个应用）——脚本退出自动断连
process.exit(pass === checks.length ? 0 : 1);
process.exit(0);
