/**
 * v5.0 生产模式 E2E（A1：页面级测试盲区修复）
 *
 * 背景：43 套件全是单元/集成级，没有真实加载生产页面——v4.0 的 CSP 响应头拦截
 * 内联令牌注入脚本，生产页面重启后全部 API 401「缺少本地令牌」，单元测试完全
 * 测不出来（用户实证回归）。本套件起**真实服务器**（staticDir=web/dist）+ 真实
 * 浏览器（playwright chromium）加载生产页面，断言：
 *  - API 层（无浏览器也跑）：CSP nonce 与注入脚本 nonce 匹配 / 无令牌 401 /
 *    带令牌 200 / theme-init.js 与 assets 可加载
 *  - 浏览器层（chromium 可用时跑）：页面零 401 响应（令牌链路端到端）、
 *    零 CSP 违规（console）、React 真实渲染、主题脚本生效（localStorage 往返）
 *
 * 运行：npx tsx tests/e2e-prod.test.ts（纳入 scripts/test-runner.ts 全量链）
 */
import { startServer } from "../src/server.js";
import { setDataDirForTest } from "../src/data-dir.js";
import { resolveChromiumPath } from "../src/plugin/browser/runtime.js";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// ── 隔离：临时数据目录（服务端 getStore/审计全部落临时目录）──
const tmpData = mkdtempSync(join(tmpdir(), "infu-e2e-data-"));
setDataDirForTest(tmpData);
// 服务端配置 appearance.theme=light——验证「服务端配置 → 前端主题」管线
// （App 启动 fetchConfig 会以服务端 appearance 覆盖 localStorage 主题，这是产品设计）；
// approvalPolicy=smart——非 full 档下 🌐 临时联网按钮才显示（full 档断网本就放行）
writeFileSync(
  join(tmpData, "config.json"),
  JSON.stringify({ version: 1, appearance: { theme: "light" }, approvalPolicy: { mode: "smart" } }),
  "utf-8"
);

// ── 静态目录 = web 生产构建。生产页面 E2E 不允许静默跳过。──
const distDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const distOk = existsSync(join(distDir, "index.html"));

console.log("\n=== v5.0 生产模式 E2E ===\n");

let server: Server | null = null;
let base = "";
try {
  check("web/dist 生产构建存在", distOk, distDir);
  if (!distOk) throw new Error("web/dist 不存在：生产页面 E2E 需要先构建 Web");
  const chromePath = resolveChromiumPath();
  check("Chromium 可用（生产页面 E2E 必需）", !!chromePath, String(chromePath));
  if (!chromePath) throw new Error("未找到 Chromium：请安装 Playwright Chromium 或配置系统 Chromium");
  // 真实服务器：staticDir 生产模式（端口 0 = 系统分配，onListening 回传实际端口）
  const started = await new Promise<Server | null>((resolve) => {
    const srv = startServer({
      port: 0,
      staticDir: distDir,
      onListening: (port) => {
        base = `http://127.0.0.1:${port}`;
        resolve(srv);
      },
    });
  });
  server = started;
  if (!base) throw new Error("服务器未就绪");

  // ── API 层（无浏览器依赖）──
  console.log("▶ API 层：令牌注入 + CSP nonce + 鉴权");
  {
    const get = async (path: string, token?: string) => {
      const res = await fetch(base + path, { headers: token ? { "X-InFu-Token": token } : {} });
      return { status: res.status, text: await res.text(), csp: res.headers.get("content-security-policy"), xfo: res.headers.get("x-frame-options") };
    };

    const noToken = await get("/api/projects");
    check("无令牌 /api/projects → 401（鉴权生效）", noToken.status === 401, String(noToken.status));

    {
      const home = await get("/");
      const csp = home.csp ?? "";
      const nonce = /'nonce-([a-f0-9]+)'/.exec(csp)?.[1] ?? "";
      const m = /<script nonce="([a-f0-9]+)">window\.__INFU_TOKEN__="([a-f0-9]+)";<\/script>/.exec(home.text);
      check("CSP 含响应级 nonce", !!nonce, csp.slice(0, 120));
      check("令牌注入脚本 nonce 与 CSP nonce 匹配", m?.[1] === nonce, `script=${m?.[1]} csp=${nonce}`);
      check("X-Frame-Options: DENY", home.xfo === "DENY", String(home.xfo));
      const token = m?.[2] ?? "";
      const withToken = await get("/api/projects", token);
      check("带令牌 /api/projects → 200（令牌链路通）", withToken.status === 200, String(withToken.status));
      const theme = await get("/theme-init.js");
      check("theme-init.js 外置脚本可加载（'self' 放行）", theme.status === 200, String(theme.status));
      const asset = await get("/assets/");
      check("SPA fallback 带 CSP 头", (asset.csp ?? "").includes("frame-ancestors 'none'"), String(asset.status));
    }
  }

  // ── 浏览器层（真实加载生产页面）──
  {
    console.log("\n▶ 浏览器层：真实加载生产页面");
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    try {
      const page = await browser.newPage();
      // 收集：401 响应（令牌链路断裂 = CSP 回归重现）+ CSP 违规 console + 请求失败
      const unauthorized: string[] = [];
      const cspViolations: string[] = [];
      page.on("response", (r) => { if (r.status() === 401) unauthorized.push(r.url().slice(0, 80)); });
      page.on("console", (msg) => {
        const t = msg.text();
        if (t.includes("Refused to execute inline script") || t.includes("Content Security Policy")) cspViolations.push(t.slice(0, 100));
      });
      page.on("requestfailed", (r) => cspViolations.push(`requestfailed: ${r.url().slice(0, 80)}`));

      // 主题两阶段断言：
      // ① theme-init.js（外置 head 同步脚本）在 CSP 下真实执行——阻断 bundle 后页面
      //    无 React，dataset.theme 完全由 theme-init 决定（localStorage 注入 light）
      // ② 服务端配置 appearance.theme=light → 应用挂载后主题为 light（config 管线）
      // 注：zustand persist 水合校验 version 字段，写完整格式 {"state","version":0}
      const initThemePage = await browser.newPage();
      await initThemePage.addInitScript(() => {
        try { localStorage.setItem("infu-chat", JSON.stringify({ state: { theme: "light" }, version: 0 })); } catch { /* 忽略 */ }
      });
      await initThemePage.route("**/assets/*.js", (route) => route.abort());
      await initThemePage.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await initThemePage.waitForTimeout(300);
      const themeInitVal = await initThemePage.evaluate(() => document.documentElement.dataset.theme);
      check("theme-init.js 在 CSP 下执行（bundle 阻断仍生效）", themeInitVal === "light", String(themeInitVal));
      await initThemePage.close();

      await page.addInitScript(() => {
        // 右栏偏好为开启时，新建会话返回欢迎态也必须不渲染工作区；否则欢迎页会
        // 出现一块无法通过顶部会话动作收起的右栏。
        try { localStorage.setItem("infu-chat", JSON.stringify({ state: { theme: "light", detailsOpen: true, viewMode: "code" }, version: 0 })); } catch { /* 忽略 */ }
      });
      await page.goto(base + "/", { waitUntil: "networkidle", timeout: 30000 });
      // React 真实渲染（#root 有内容）
      await page.waitForSelector("#root > *", { timeout: 15000 }).catch(() => {});
      const rootHtml = await page.evaluate(() => (document.getElementById("root")?.innerHTML ?? "").slice(0, 200));
      check("React 应用真实渲染", rootHtml.length > 50, rootHtml.slice(0, 120));
      await page.waitForTimeout(700);
      const rootHtmlStable = await page.evaluate(() => (document.getElementById("root")?.innerHTML ?? "").length);
      check("空 trace 欢迎态持续渲染（无 React 更新深度错误）", rootHtmlStable > 50, String(rootHtmlStable));
      const welcomeHeading = await page.getByText("把想法变成进展。", { exact: true }).count();
      check("欢迎态忽略遗留代码视图，始终显示新版聊天欢迎页", welcomeHeading === 1, String(welcomeHeading));
      const workspaceVisibleOnWelcome = await page.getByText("工作区", { exact: true }).isVisible().catch(() => false);
      check("欢迎态不渲染右侧工作区（即使右栏偏好已开启）", !workspaceVisibleOnWelcome, String(workspaceVisibleOnWelcome));
      const suggestions = await page.locator('button[title="填入输入框后可继续补充上下文或直接发送"]').count();
      check("欢迎态提供三个可填入输入框的建议任务", suggestions === 3, String(suggestions));
      const workspaceSelector = page.getByText("选择工作区", { exact: true });
      check("欢迎态显示紧凑的工作区选择说明", await workspaceSelector.count() >= 1, String(await workspaceSelector.count()));
      const selectorWidth = await workspaceSelector.locator("..").evaluate((element) => Math.round(element.getBoundingClientRect().width));
      check("欢迎态工作区选择器按内容收紧", selectorWidth < 360, String(selectorWidth));
      const modelControl = page.getByTitle("选择模型与推理强度");
      check("Composer 直接提供合并的模型与推理选择", await modelControl.count() === 1, String(await modelControl.count()));
      const collapsedToolDetails = await page.locator('[data-state="ok"]').getByText("IN", { exact: true }).count();
      check("历史消息流工具详情默认收起", collapsedToolDetails === 0, String(collapsedToolDetails));
      await page.locator('button[title="填入输入框后可继续补充上下文或直接发送"]').first().click();
      const suggestedInput = await page.locator("textarea").inputValue();
      check("建议任务只填入输入框，不会立即执行", suggestedInput === "分析这个项目的结构", suggestedInput);
      await page.locator("textarea").fill("");
      // 令牌链路端到端：页面自身所有 API 调用零 401（CSP 回归的直接判据）
      await page.waitForTimeout(1500); // 等启动期 fetchSessions/fetchProjects 完成
      check("页面 API 调用零 401（令牌链路端到端）", unauthorized.length === 0, unauthorized.join(", "));
      check("零 CSP 违规 / 零请求失败", cspViolations.length === 0, cspViolations.join(" | "));
      // 服务端配置 → 主题管线（fetchConfig 应用 appearance.theme=light）
      await page.waitForTimeout(800);
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      check("服务端配置主题生效（config→store→dataset.theme）", theme === "light", String(theme));
      // 欢迎界面可直接设置临时联网时长（无会话时暂存，发送时绑定到新会话）。
      // （无会话时不开 POST，发送消息时随 /api/chat 的 egressMinutes 对本会话生效）
      const pillClickable = await page.locator("button", { hasText: "自定义联网" }).count();
      check("欢迎界面自定义联网按钮可见", pillClickable > 0, String(pillClickable));
      // button:has-text 精确命中按钮（text= 会同时匹配内层 span，严格模式抛错）
      await page.locator("button", { hasText: "自定义联网" }).first().click().catch((e) => console.log("  ⚠ pill click:", String(e).slice(0, 100)));
      await page.waitForTimeout(300);
      const menuOpen = await page.locator("text=快捷时长").count();
      check("欢迎界面药丸可展开时长菜单", menuOpen > 0, String(menuOpen));
      await page.locator("button", { hasText: "10 分钟" }).first().click().catch(() => {});
      await page.waitForTimeout(300);
      const pillActive = await page.locator("button", { hasText: "自定义联网" }).count();
      check("欢迎界面选时长后药丸激活（本地待定态）", pillActive > 0, String(pillActive));
      // 关闭恢复
      await page.locator("button", { hasText: "自定义联网" }).first().click().catch(() => {});
      await page.waitForTimeout(200);
      await page.locator("button", { hasText: "关闭临时联网" }).first().click().catch(() => {});
      await page.waitForTimeout(300);
      const pillClosed = await page.locator("button", { hasText: "关闭临时联网" }).count() === 0;
      check("欢迎界面可关闭临时联网", pillClosed, "");
      // v5.1 补 5：full 档（全权放行）下断网本就放行 → 🌐 临时联网按钮隐藏
      const modeBtn = page.locator('button[title="全局审批档位（写入设置，即时生效）"]');
      await modeBtn.click().catch(() => {});
      await page.waitForTimeout(200);
      await page.locator("button", { hasText: "全权放行" }).first().click().catch(() => {});
      await page.waitForTimeout(400);
      const pillHiddenInFull = await page.locator("button", { hasText: "自定义联网" }).count() === 0;
      check("full 档下临时联网按钮隐藏", pillHiddenInFull, `pill=${await page.locator("button", { hasText: "临时联网" }).count()}`);
      // 切回非 full 档 → 按钮恢复
      await modeBtn.click().catch(() => {});
      await page.waitForTimeout(200);
      await page.locator("button", { hasText: "全自动" }).first().click().catch(() => {});
      await page.waitForTimeout(400);
      const modeLabel = await page.locator('button[title="全局审批档位（写入设置，即时生效）"]').innerText().catch(() => "?");
      const pillBack = await page.locator("button", { hasText: "自定义联网" }).count() > 0;
      check("切回非 full 档后自定义联网按钮恢复", pillBack, `pill=${await page.locator("button", { hasText: "自定义联网" }).count()} mode=${modeLabel.trim()}`);
      await page.evaluate(() => localStorage.removeItem("infu-chat"));
    } finally {
      await browser.close().catch(() => {});
    }
  }
} finally {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
  }
  try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
