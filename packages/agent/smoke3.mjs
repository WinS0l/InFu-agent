import { chromium } from "playwright-core";

const URL = "http://localhost:5174/?infuAgentPort=4317";
const errors = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector("textarea", { timeout: 20000 });

// 折叠右栏 → 分隔线位置（应与聊天 header 线对齐 ≈ 40px；无消息时 header 不存在，只验 rail 线）
await page.locator("button[title='折叠右侧栏']").click().catch(() => {});
await page.waitForTimeout(500);
const railLine = page.locator("aside[style*='gridColumn'] > div.border-b");
if (await railLine.count() > 0) {
  const box = await railLine.boundingBox();
  console.log("[1] 折叠 rail 分隔线 y:", Math.round(box?.y ?? -1), "(期望 ≈ 40)");
} else {
  console.log("[1] 折叠 rail 分隔线: 无");
}
await page.locator("button[title='展开右侧栏']").click().catch(() => {});
await page.waitForTimeout(300);

// 统计页
await page.locator("button[title*='设置（基础设置']").click();
await page.waitForSelector("text=使用统计", { timeout: 10000 });
await page.locator("button:has-text('使用统计')").click();
await page.waitForSelector("text=活跃热力图", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(600);
const weekdayHeaders = await page.locator("text=一 >> visible=true").count();
const hasLow = await page.locator("text=低 >> visible=true").count();
const hasHigh = await page.locator("text=高 >> visible=true").count();
const monthLabels = await page.locator("span.text-right.text-caption").allTextContents();
const barTitle = await page.locator("text=按天 Token 趋势（模型色标区分）").count();
const cells = await page.locator("div[title*='tokens']").count();
const barRows = await page.locator("div.flex.items-center.gap-2[title*='tokens']").count();
console.log("[2] 星期表头(一):", weekdayHeaders, "| 左侧图例 低/高:", hasLow, hasHigh, "| 月份标签:", JSON.stringify(monthLabels.filter((x) => x)));
console.log("[3] 条形图标题(模型色标区分):", barTitle, "| 热力图数据格:", cells, "| 条形图行:", barRows);
console.log("[4] console errors:", errors.length ? errors.join(" || ") : "无");
await browser.close();
console.log("DONE");