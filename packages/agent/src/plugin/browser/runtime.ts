/**
 * browser-use 插件运行时（v3.0 批 8 定稿：宿主注入架构）
 *
 * 桌面模式（Electron）：主进程对每个 <webview> 的 guest webContents
 * debugger.attach("1.3") 并注入 __infuCdpSend/__infuCdpOn——Agent 与主进程
 * 同进程，直接调桥直发 CDP（不经 playwright；playwright connectOverCDP 的
 * target 过滤 = 批 4-6 灾难根源，批 8 彻底弃用，连 remote-debugging-port 都移除）。
 * 页识别：主进程 __infuBrowserTabs 注册表（webContents.id = tabId，无歧义）。
 * Web/CLI 模式：playwright 独立 chromium（headless）保留原逻辑。
 *
 * 设计：
 *  - getTab() 统一返回 BrowserTab 抽象（桌面 = CDP 桥包装；Web = playwright 包装）
 *  - 模块级单例，跨工具调用保持（browser_close 才重置）
 *  - 输入全走页面内 JS 注入（与键盘焦点解耦——根治输入污染）
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import type { CdpClient } from "./cdp.js";
import { isDesktopMode, desktopCdpForTab, playwrightCdp, cdpEvaluate } from "./cdp.js";
import { axSnapshot, clickByIndex } from "./ax.js";

/** 浏览器 tab 抽象（桌面 = CDP 桥；Web = playwright） */
export interface BrowserTab {
  /** 唯一标识（桌面 = webContents.id 字符串；Web = "web"） */
  id: string;
  url(): Promise<string>;
  title(): Promise<string>;
  bodyText(): Promise<string>;
  /** 页面内求值（语句/表达式/函数三态，replMode） */
  evaluate(code: string, arg?: unknown): Promise<unknown>;
  goto(url: string, timeoutMs: number): Promise<void>;
  waitForLoad(timeoutMs: number): Promise<void>;
  axSnapshot(): Promise<Awaited<ReturnType<typeof axSnapshot>>>;
  clickByIndex(idx: number, ax?: Awaited<ReturnType<typeof axSnapshot>> | null): Promise<string>;
  /** CSS 选择器点击（页面内 JS 定位 + click） */
  clickSelector(sel: string): Promise<string>;
  /** 填入输入框（CSS → placeholder → 可访问名/aria-label → text 多级匹配） */
  fill(sel: string, value: string): Promise<string>;
  /** 在当前聚焦元素输入（JS 注入，焦点解耦） */
  typeText(text: string): Promise<string>;
  screenshot(): Promise<Buffer>;
  setViewport(opts: { width?: number; height?: number; fit?: boolean }): Promise<void>;
  cdp(): Promise<CdpClient>;
}

const g = globalThis as Record<string, unknown>;
const NET_TIMEOUT = 30000;

/** ─────────────────────────── 桌面模式（CDP 桥） ─────────────────────────── */

interface MainTabInfo {
  id: string | number;
  url: string;
  title: string;
  active: boolean;
}

function mainTabs(): MainTabInfo[] {
  return (g.__infuBrowserTabs as MainTabInfo[] | undefined) ?? [];
}
function mainActiveTab(): MainTabInfo | null {
  return mainTabs().find((t) => t.active) ?? mainTabs()[0] ?? null;
}

class DesktopTab implements BrowserTab {
  readonly id: string;
  private cdpClient: CdpClient;
  constructor(info: MainTabInfo) {
    this.id = String(info.id);
    this.cdpClient = desktopCdpForTab(info.id);
  }
  async cdp(): Promise<CdpClient> {
    return this.cdpClient;
  }
  async url(): Promise<string> {
    try {
      return String(await cdpEvaluate(this.cdpClient, "location.href"));
    } catch { return ""; }
  }
  async title(): Promise<string> {
    try {
      return String(await cdpEvaluate(this.cdpClient, "document.title"));
    } catch { return ""; }
  }
  async bodyText(): Promise<string> {
    try {
      return String(await cdpEvaluate(this.cdpClient, "document.body ? document.body.innerText : ''"));
    } catch { return ""; }
  }
  async evaluate(code: string, arg?: unknown): Promise<unknown> {
    return cdpEvaluate(this.cdpClient, code, arg);
  }
  async goto(url: string, timeoutMs: number): Promise<void> {
    // Page.navigate + loadEventFired 等待（桥事件订阅；超时兜底轮询 readyState）
    await this.cdpClient.send("Page.navigate", { url });
    await this.waitForLoad(timeoutMs);
  }
  async waitForLoad(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await cdpEvaluate(this.cdpClient, "document.readyState");
        if (state === "complete" || state === "interactive") return;
      } catch { /* 页面切换中 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  axSnapshot() {
    return axSnapshot(this.cdpClient);
  }
  clickByIndex(idx: number, ax?: Awaited<ReturnType<typeof axSnapshot>> | null): Promise<string> {
    return clickByIndex(this.cdpClient, idx, ax);
  }
  async clickSelector(sel: string): Promise<string> {
    const r = await cdpEvaluate(
      this.cdpClient,
      `(() => {
        const q = ${JSON.stringify(sel)};
        let el = null;
        try { el = document.querySelector(q); } catch {}
        if (!el) {
          // 文本匹配（text= 前缀或裸文本）→ 按可点击角色 + 文本包含
          const text = q.startsWith("text=") ? q.slice(5) : q;
          const roles = ["button", "a", "input[type=submit]", "input[type=button]", "[role=button]", "[role=link]", "[role=menuitem]", "[role=tab]"];
          for (const r of roles) {
            const nodes = document.querySelectorAll(r);
            for (const n of nodes) {
              const t = (n.textContent || "").trim();
              if (t === text || t.includes(text)) { el = n; break; }
            }
            if (el) break;
          }
        }
        if (!el) return "NOT_FOUND";
        el.click();
        if (typeof el.focus === "function") el.focus();
        return "CLICKED";
      })()`
    );
    if (r === "NOT_FOUND") return `错误：找不到可点击元素 "${sel}"（请 browser_snapshot 确认）`;
    return "已点击";
  }
  async fill(sel: string, value: string): Promise<string> {
    const r = await cdpEvaluate(
      this.cdpClient,
      `((q, val) => {
        const findInput = () => {
          const all = Array.from(document.querySelectorAll("input, textarea"));
          // 1) CSS 选择器
          try {
            const el = document.querySelector(q);
            if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return el;
          } catch {}
          // 2) placeholder / aria-label / name / title 包含
          const text = q.startsWith("text=") ? q.slice(5) : q;
          for (const el of all) {
            const attrs = [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.name, el.getAttribute("title")].filter(Boolean);
            if (attrs.some((a) => a.includes(text))) return el;
          }
          // 3) 关联 label（for / 包裹）
          for (const el of all) {
            if (el.id) {
              const lbl = document.querySelector('label[for="' + el.id + '"]');
              if (lbl && (lbl.textContent || "").includes(text)) return el;
            }
            const wrap = el.closest("label");
            if (wrap && (wrap.textContent || "").includes(text)) return el;
          }
          // 4) 兜底：可见的第一个输入框
          const visible = all.find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          return visible || null;
        };
        const el = findInput();
        if (!el) return "NOT_FOUND";
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.focus();
          return "FILLED";
        }
        return "NOT_INPUT";
      })`,
      [sel, value]
    );
    if (r === "NOT_FOUND") return `填写失败：找不到 "${sel}"（可先 browser_snapshot 获取输入框的可访问名或编号）`;
    if (r === "NOT_INPUT") return `填写失败：${sel} 不是输入框`;
    return `已填写 ${sel}`;
  }
  async typeText(text: string): Promise<string> {
    const ok = await cdpEvaluate(
      this.cdpClient,
      `((t) => {
        const el = document.activeElement;
        if (!el) return false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          const next = (el.value || "") + t;
          if (setter) setter.call(el, next);
          else el.value = next;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
        if (el.isContentEditable) {
          el.textContent = (el.textContent || "") + t;
          return true;
        }
        return false;
      })`,
      text
    );
    return ok ? "已输入" : "当前无聚焦输入框（请先用 browser_click 定位输入框）";
  }
  async screenshot(): Promise<Buffer> {
    const { data } = await this.cdpClient.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(String(data), "base64");
  }
  async setViewport(opts: { width?: number; height?: number; fit?: boolean }): Promise<void> {
    if (opts.fit) {
      await this.cdpClient.send("Emulation.clearDeviceMetricsOverride");
    } else if (opts.width && opts.height) {
      await this.cdpClient.send("Emulation.setDeviceMetricsOverride", {
        width: Math.round(opts.width),
        height: Math.round(opts.height),
        deviceScaleFactor: 0,
        mobile: false,
      });
    }
    const notify = g.__infuNotifyViewport as ((o: { width?: number; height?: number; fit?: boolean }) => void) | undefined;
    try { notify?.(opts); } catch { /* 忽略 */ }
  }
}

/** 桌面模式：注册表取活跃 tab；无 → 主进程建 webview（open-request → 渲染进程建元素） */
async function getDesktopTab(opts?: { create?: boolean }): Promise<BrowserTab> {
  let info = mainActiveTab();
  if (!info && opts?.create !== false) {
    const openFn = g.__infuOpenEmbeddedBrowser as ((url?: string) => void) | undefined;
    if (typeof openFn === "function") openFn();
    // 等渲染进程 webview dom-ready → 主进程注册（加固环境初始化慢，轮询最长 20s）
    for (let i = 0; i < 40 && !info; i++) {
      await new Promise((r) => setTimeout(r, 500));
      info = mainActiveTab();
    }
  }
  if (!info) {
    if (opts?.create === false) throw new Error("当前没有浏览器标签页");
    throw new Error("桌面模式：无法创建浏览器标签页（请打开右侧栏「浏览器」tab 或重启应用）");
  }
  return new DesktopTab(info);
}

/** ─────────────────────────── Web/CLI 模式（playwright） ─────────────────────────── */

let browser: Browser | null = null;
let page: Page | null = null;

/** 探测 chromium 可执行文件（ms-playwright 缓存，zcode/playwright 常用路径） */
export function resolveChromiumPath(): string | null {
  const env = process.env.INFU_BROWSER_PATH;
  if (env && existsSync(env)) return env;
  const base = join(homedir(), "AppData", "Local", "ms-playwright");
  const candidates = [
    join(base, "chromium-1234", "chrome-win64", "chrome.exe"),
    join(base, "chromium_headless_shell-1234", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // 遍历 ms-playwright 下任意 chromium* 目录
  try {
    for (const dir of readdirSync(base)) {
      if (!dir.startsWith("chromium")) continue;
      const exe = join(base, dir, "chrome-win64", "chrome.exe");
      if (existsSync(exe)) return exe;
      const shell = join(base, dir, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
      if (existsSync(shell)) return shell;
    }
  } catch { /* 目录不存在 */ }
  return null; // 交给 playwright 默认查找（装了 playwright 包时）
}

class WebTab implements BrowserTab {
  readonly id = "web";
  private page: Page;
  private cdpClient: CdpClient | null = null;
  constructor(page: Page) {
    this.page = page;
  }
  async cdp(): Promise<CdpClient> {
    if (!this.cdpClient) this.cdpClient = await playwrightCdp(this.page);
    return this.cdpClient;
  }
  async url() {
    return this.page.url();
  }
  async title() {
    return this.page.title().catch(() => "");
  }
  async bodyText() {
    return this.page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  }
  async evaluate(code: string, arg?: unknown): Promise<unknown> {
    // 与桌面统一语义：函数体带参调用；其余 replMode 由 playwright 表达式兜底
    if (arg !== undefined) {
      return this.page.evaluate(
        `((code, arg) => { const fn = eval("(" + code + ")"); return fn(arg); })`,
        { code, arg }
      );
    }
    // 语句支持：先试函数体包装，失败按表达式执行
    try {
      return await this.page.evaluate(`(async () => { ${code} })()`);
    } catch {
      return this.page.evaluate(code);
    }
  }
  async goto(url: string, timeoutMs: number) {
    await this.page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
  }
  async waitForLoad(timeoutMs: number) {
    await this.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  }
  axSnapshot() {
    return this.cdp().then((cdp) => axSnapshot(cdp));
  }
  async clickByIndex(idx: number, ax?: Awaited<ReturnType<typeof axSnapshot>> | null) {
    return clickByIndex(await this.cdp(), idx, ax);
  }
  async clickSelector(sel: string) {
    try {
      await this.page.locator(sel).first().click({ timeout: 10000 });
      return "已点击";
    } catch {
      return `错误：找不到可点击元素 "${sel}"（请 browser_snapshot 确认）`;
    }
  }
  async fill(sel: string, value: string) {
    // 与桌面同一页面内多级匹配逻辑（CSS → placeholder/aria-label/name/title → label → 可见兜底）
    const r = await cdpEvaluate(
      await this.cdp(),
      `((q, val) => {
        const findInput = () => {
          const all = Array.from(document.querySelectorAll("input, textarea"));
          try {
            const el = document.querySelector(q);
            if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return el;
          } catch {}
          const text = q.startsWith("text=") ? q.slice(5) : q;
          for (const el of all) {
            const attrs = [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.name, el.getAttribute("title")].filter(Boolean);
            if (attrs.some((a) => a.includes(text))) return el;
          }
          for (const el of all) {
            if (el.id) {
              const lbl = document.querySelector('label[for="' + el.id + '"]');
              if (lbl && (lbl.textContent || "").includes(text)) return el;
            }
            const wrap = el.closest("label");
            if (wrap && (wrap.textContent || "").includes(text)) return el;
          }
          const visible = all.find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          return visible || null;
        };
        const el = findInput();
        if (!el) return "NOT_FOUND";
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.focus();
          return "FILLED";
        }
        return "NOT_INPUT";
      })`,
      [sel, value]
    );
    if (r === "NOT_FOUND") return `填写失败：找不到 "${sel}"（可先 browser_snapshot 获取输入框的可访问名或编号）`;
    if (r === "NOT_INPUT") return `填写失败：${sel} 不是输入框`;
    return `已填写 ${sel}`;
  }
  async typeText(text: string) {
    const injected = await this.page.evaluate(
      `(t) => {
        const el = document.activeElement;
        if (!el) return false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          const next = (el.value || "") + t;
          if (setter) setter.call(el, next);
          else el.value = next;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
        if (el.isContentEditable) { el.textContent = (el.textContent || "") + t; return true; }
        return false;
      }`,
      text
    );
    return injected ? "已输入" : "当前无聚焦输入框（请先用 browser_click 定位输入框）";
  }
  async screenshot() {
    return this.page.screenshot({ fullPage: false });
  }
  async setViewport(opts: { width?: number; height?: number; fit?: boolean }) {
    const cdp = await this.cdp();
    if (opts.fit) await cdp.send("Emulation.clearDeviceMetricsOverride");
    else if (opts.width && opts.height) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: Math.round(opts.width),
        height: Math.round(opts.height),
        deviceScaleFactor: 0,
        mobile: false,
      });
    }
  }
}

async function getWebTab(opts?: { create?: boolean }): Promise<BrowserTab> {
  if (page && !page.isClosed()) return new WebTab(page);
  const { chromium } = await import("playwright-core");
  let cfg: { headless?: boolean; executablePath?: string } | undefined;
  try {
    const { loadConfig } = await import("../../providers/registry.js");
    cfg = loadConfig()?.browser;
  } catch { /* config 不可用时回退默认 */ }
  const executablePath = cfg?.executablePath?.trim() ? cfg.executablePath.trim() : resolveChromiumPath();
  const headless = cfg?.headless ?? process.env.INFU_BROWSER_HEADLESS !== "0";
  browser = await chromium.launch({
    headless,
    ...(executablePath ? { executablePath } : {}),
  });
  page = await browser.newPage();
  return new WebTab(page);
}

/** ─────────────────────────── 统一入口 ─────────────────────────── */

/** 获取当前页（幂等：已打开则复用；桌面 = 嵌入式浏览器活跃 tab） */
export async function getPage(opts?: { create?: boolean }): Promise<BrowserTab> {
  if (isDesktopMode()) return getDesktopTab(opts);
  return getWebTab(opts);
}

/** 关闭浏览器并释放单例（桌面模式：不销毁——tab 除非显式关闭永不关闭，对齐主流） */
export async function closeBrowser(): Promise<void> {
  if (isDesktopMode()) {
    // 桌面模式：CDP 桥连接由主进程持有（webview 元素生命周期），这里只清内存态
    return;
  }
  if (browser) {
    try { await browser.close(); } catch { /* 忽略 */ }
  }
  browser = null;
  page = null;
}

/** 清空页缓存（browser_tab_select 切换 tab 后强制重匹配）——v6.0 S6：tab 注册表实时读
 * 主进程标记，无缓存可清；本函数与 hasPage 均无任何调用点（死代码），已删除 */

/** 自由尺寸（viewport）：Agent 设置 → CDP Emulation + 通知 UI 面板贴合 */
export async function desktopSetViewport(opts: { width?: number; height?: number; fit?: boolean }): Promise<void> {
  if (!isDesktopMode()) return;
  try {
    const tab = await getDesktopTab({ create: false });
    await tab.setViewport(opts);
  } catch {
    // 找不到页时静默（面板贴合 CSS 仍生效）
    const notify = g.__infuNotifyViewport as ((o: { width?: number; height?: number; fit?: boolean }) => void) | undefined;
    try { notify?.(opts); } catch { /* 忽略 */ }
  }
}

/**
 * 清除浏览器数据（v2.7 设置界面「浏览器数据」）：
 * - cache：清 HTTP 缓存 + Cache Storage + Service Worker（保留 Cookie / localStorage / IndexedDB）
 * - all  ：额外清 Cookie 与全部站点存储（不可撤销）
 */
export async function clearBrowserData(scope: "cache" | "all"): Promise<string> {
  try {
    const tab = await getPage({ create: false });
    const cdp = await tab.cdp();
    try { await cdp.send("Network.clearBrowserCache"); } catch { /* 忽略 */ }
    try {
      const origin = await tab.url().catch(() => "");
      if (origin && /^https?:/.test(origin)) {
        await cdp.send("Storage.clearDataForOrigin", {
          origin: new URL(origin).origin,
          storageTypes: scope === "all"
            ? "cookies,indexeddb,local_storage,service_workers,cache_storage,websql,file_systems"
            : "cache_storage,service_workers",
        }).catch(() => {});
      }
    } catch { /* 无有效 origin 时跳过 */ }
    if (scope === "all") {
      try { await cdp.send("Network.clearBrowserCookies"); } catch { /* 忽略 */ }
    }
    return scope === "all"
      ? "已清除全部浏览器数据（Cookie + 站点数据 + 缓存）"
      : "已清除浏览器缓存（保留 Cookie 与本地站点数据）";
  } catch {
    return "浏览器未启动（当前无活动会话，无需清理）";
  }
}
