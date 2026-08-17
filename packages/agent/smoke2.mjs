import { chromium } from "playwright-core";

const URL = "http://localhost:5174/?infuAgentPort=4317";
const errors = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector("textarea", { timeout: 20000 });

// ── 需求 1：自由会话（root 空）→ 代码按钮禁用 ──
await page.locator("textarea").fill("你好，请简单回复一句话");
await page.locator("textarea").press("Enter");
await page.waitForSelector("button:has-text('代码')", { timeout: 30000 });
const codeBtn = page.locator("button:has-text('代码')");
const disabled = await codeBtn.isDisabled();
const title = await codeBtn.getAttribute("title");
console.log("[1] 代码按钮 disabled:", disabled, "| title:", title);

// 等任务结束
await page.waitForFunction(() => !document.body.textContent.includes("InFu 运行中"), { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(800);

// ── 需求 2：折叠 rail 分隔线 ──
if (await page.locator("button[title='折叠右侧栏']").count() > 0) {
  await page.locator("button[title='折叠右侧栏']").click();
  await page.waitForTimeout(500);
}
const railLine = await page.locator("aside[style*='gridColumn'] > div.border-b").count();
const railVisible = await page.locator("button[title='展开右侧栏']").count();
console.log("[2] 折叠 rail 分隔线:", railLine > 0 ? "有" : "无", "| 展开按钮存在:", railVisible > 0);

// ── 需求 3：统计页双图表 ──
if (await page.locator("button[title='展开右侧栏']").count() > 0) {
  await page.locator("button[title='展开右侧栏']").click();
  await page.waitForTimeout(300);
}
// 侧栏底部设置按钮
await page.locator("button[title*='设置（基础设置']").click();
await page.waitForSelector("text=使用统计", { timeout: 10000 });
await page.locator("button:has-text('使用统计')").click();
await page.waitForSelector("text=活跃热力图", { timeout: 15000 }).catch(() => {});
await page.waitForSelector("text=按天 Token 趋势", { timeout: 15000 }).catch(() => {});
const heatCells = await page.locator("div[title*='tokens']").count();
const hasHeatTitle = await page.locator("text=活跃热力图").count();
const hasBarTitle = await page.locator("text=按天 Token 趋势").count();
const barRows = await page.locator("div[title*='tokens']").count();
console.log("[3] 热力图标题:", hasHeatTitle > 0, "| 条形图标题:", hasBarTitle > 0, "| 图表数据格/行:", heatCells);
await page.screenshot({ path: "C:\\Users\\zdx20\\AppData\\Local\\Temp\\opencode\\smoke2-stats.png" });

console.log("[4] console errors:", errors.length ? errors.join(" || ") : "无");
await browser.close();
console.log("DONE");