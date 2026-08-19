/**
 * InFu 桌面端主进程（Electron，v3.0 桌面化）
 *
 * 架构：Electron 主进程 = agent 后端宿主（同进程运行 @infu/agent 的 Hono 服务，
 * 同端口托管 web dist → 前端相对路径 fetch 零改动）+ 主窗口 + 嵌入式真浏览器。
 *
 * 嵌入式浏览器（v3.0 批 8 定稿，宿主注入架构）：
 *  - UI 用 <webview> 元素（DOM 层叠：圆角/阴影/菜单自然盖在浏览器之上——
 *    「infu 覆盖浏览器」，用户拍板形态；多 tab = 渲染进程多个 webview 元素）
 *  - Agent 控制用「主进程 CDP 桥」：每个 webview 的 guest webContents
 *    webContents.debugger.attach("1.3") + sendCommand 注入全局 __infuCdpSend/__infuCdpOn
 *    ——与 playwright connectOverCDP 彻底脱钩（playwright 初始 target 列表过滤
 *    webview 类型 = 批 4-6 灾难根源；移除 remote-debugging-port 后 debugger.attach 独占）
 *  - tab 生命周期：只有用户显式关闭或 Agent 显式 browser_close 才销毁；
 *    面板显隐/会话切换/任务结束一律不销毁（修批 7 遗留：loadSession 清 rightTabs
 *    → BrowserPanel 卸载 → browserCloseAll 误杀浏览器）
 *
 * 决策（2026-08-15 用户拍板）：
 *  - 选型 Electron（InFu Desktop 3.7.6 实证同为 electron-builder 生态）
 *  - 无边框：titleBarStyle hidden，无独立标题栏（v3.0 批 9：三栏顶部各自顶到窗口最顶，
 *    拖拽区 = 各栏顶部行（app-region: drag），窗口按钮 = 右上角自绘悬浮 WindowControls）
 *  - 关闭窗口 = 退出应用；托盘仅「显示主窗口/退出」入口
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, nativeTheme, shell, dialog, powerSaveBlocker, Notification, type Rectangle } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "@infu/agent/dist/server.js";
import { loadConfig } from "@infu/agent/dist/providers/registry.js";
import { resolveDataDir } from "@infu/agent/dist/data-dir.js";
import { getStore } from "@infu/agent/dist/db/store.js";
// v3.6：IPv6 解包 / IPv4 简写归一化判定下沉 @infu/shared（与 agent SSRF 共用同一实现，
// 修复 ::ffff:7f00:1 / ::7f00:1 / 0:0:0:0:0:0:0:1 等 loopback 变体绕过导航守卫）
import { isLoopbackHostText } from "@infu/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_DEV = process.env.INFU_DESKTOP_DEV === "1";

// v3.3 补 7：主进程未捕获异常兜底——后台启动/管道关闭时 console.log 写 stdout 断管
// （EPIPE）会触发 uncaughtException → Windows 弹「A JavaScript error occurred in the
// main process」对话框（用户在桌面看到的多个报错窗口根因）。挂兜底：记录到 stderr，
// 不再弹原生错误对话框；其他无害异常同样走此通道（个人桌面应用，不因日志崩溃）。
process.on("uncaughtException", (err) => {
  try {
    console.error(`[infu-desktop] uncaughtException: ${(err as Error)?.message ?? err}\n${(err as Error)?.stack ?? ""}`);
  } catch {
    /* stderr 同样不可写（极端管道关闭）——静默 */
  }
});

// 本机（Windows 25H2 加固）GPU 子进程无法启动（反复 exit_code=-2147483645 断点异常）→ 软件渲染
// SwiftShader ANGLE 后端（GPU 进程用软件 GL 正常启动 → 合成/截图/ready-to-show 恢复）。
// Chromium 128+ 需 enable-unsafe-swiftshader 才允许；crash-limit 兜底（个人应用可接受）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("disable-gpu-process-crash-limit");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
// 批 8：不再开 remote-debugging-port（webContents.debugger 独占，见文件头注释）

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverPort = 4317;
// v3.5 常规设置：关闭到托盘（close 拦截需要退出标志防误拦） + 防休眠（powerSaveBlocker id）
let quitting = false;
let powerSaveId: number | null = null;

// ── 单实例（重复启动聚焦已有窗口）──
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── 窗口状态持久化（<dataDir>/desktop-window.json，复用配置目录）──
function windowStatePath() {
  return join(resolveDataDir(), "desktop-window.json");
}
function loadWindowState(): Partial<Rectangle> & { maximized?: boolean } {
  try {
    const raw = JSON.parse(readFileSync(windowStatePath(), "utf-8"));
    const state = raw as Rectangle & { maximized?: boolean };
    // 校验坐标落在某显示器内（防拔显示器后窗口丢失）
    if (typeof state.x === "number" && typeof state.y === "number" && typeof state.width === "number" && typeof state.height === "number") {
      const visible = screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return state.x < b.x + b.width - 100 && state.y < b.y + b.height - 40 && state.x + state.width > b.x + 100 && state.y + state.height > b.y + 40;
      });
      if (visible) return state;
    }
  } catch { /* 无记录/损坏 → 默认 */ }
  return {};
}
function saveWindowState(win: BrowserWindow) {
  try {
    const b = win.getBounds();
    mkdirSync(resolveDataDir(), { recursive: true });
    // v3.6 审计修复：原子写（tmp + rename）——原直接 writeFileSync 截断半写，
    // 断电/崩溃会留下损坏的窗口状态文件（loadWindowState 容错返回默认，但可避免）
    const p = windowStatePath();
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ ...b, maximized: win.isMaximized() }));
    renameSync(tmp, p);
  } catch { /* 忽略 */ }
}

// ── 主题联动：titleBarOverlay 系统窗口按钮配色跟随应用主题（v3.0 批 9.5 拍板：
//    Windows 下 titleBarStyle:hidden 保留原生三按钮（右上角悬浮）——三栏顶部顶到
//    窗口最顶；height 32 压缩悬浮区（批 9.6：与 tab 条底部内容错开，无需大让位，
//    背景与右侧栏 bg-ink 同色，视觉融合）──
function themeOverlayColors(theme: string) {
  return theme === "light"
    ? { color: "#FFFFFF", symbolColor: "#0F1115" }
    : { color: "#151517", symbolColor: "#F9FAFB" };
}
function applyThemeOverlay(win: BrowserWindow, theme?: string) {
  try {
    // v3.0 批 12：theme=system → 跟随操作系统（nativeTheme.shouldUseDarkColors）
    const resolved = theme === "system"
      ? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
      : (theme ?? "dark");
    win.setTitleBarOverlay(themeOverlayColors(resolved));
  } catch { /* 平台不支持忽略 */ }
}

function createMainWindow() {
  const state = loadWindowState();
  const theme = loadConfig()?.appearance?.theme ?? "dark";
  const win = new BrowserWindow({
    title: "InFu",
    width: state.width ?? 1440,
    height: state.height ?? 900,
    // v3.3 补 8：最小尺寸放宽（1080×680 → 800×560）——此前过大的 min 限制导致
    // 窗口无法像其他窗口一样正常缩小/调整尺寸（用户反馈）
    minWidth: 800,
    minHeight: 560,
    x: state.x,
    y: state.y,
    show: false,
    backgroundColor: "#151517",
    // 无边框：隐藏系统标题栏，保留原生窗口按钮（titleBarOverlay 右上角悬浮，随主题配色；
    // v3.3 补 6/7：height 显式 40px——Electron 不设 height 时用系统默认（Windows 10/11
    // 100% DPI 下 32px，与本机批 9.6 的 32 相同=用户观感「没恢复」）；Windows 11 原生
    // 标题栏视觉高度 40px，显式设 40 对齐原生大小（125% 缩放物理 50px < tab 条 3.25rem
    // 45.5px 逻辑，不越界；折叠 rail 让位区 34.5px+py-3 = 按钮 top≈49px > 40 不被盖））
    titleBarStyle: "hidden",
    titleBarOverlay: { ...themeOverlayColors(theme), height: 40 },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // v3.0 批 3 起：嵌入式浏览器用 <webview> 标签（DOM 层叠：菜单自然盖在浏览器之上）
      webviewTag: true,
    },
  });
  mainWindow = win;

  // webview 元素 → guest webContents 注册（批 8 CDP 桥：debugger.attach + 事件接线）
  win.webContents.on("did-attach-webview", (_e, wc) => registerBrowserWebContents(wc));

  // 导航/渲染状态日志（开发期定位用）
  win.webContents.on("did-finish-load", () => console.log("[infu-desktop] 页面加载完成"));
  // 渲染进程 DOM 诊断（批 8 定位：React 树是否挂载）
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.webContents.executeJavaScript("(document.getElementById('root')?.innerHTML || '').slice(0, 300)").then((html) => {
        console.log(`[infu-desktop] root html: ${String(html).slice(0, 300)}`);
      }).catch((e) => console.log(`[infu-desktop] root 诊断失败: ${e.message}`));
    }
  }, 8000);
  win.webContents.on("did-fail-load", (_e, code, desc) => console.log(`[infu-desktop] 页面加载失败 ${code}: ${desc}`));
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.log(`[infu-desktop] 页面 console: ${String(message).slice(0, 200)}`);
  });

  // 最大化状态同步给渲染进程（标题栏按钮图标切换）
  const sendMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send("window:maximized", win.isMaximized());
  };
  win.on("maximize", sendMaximized);
  win.on("unmaximize", sendMaximized);

  // 窗口状态落盘（防抖）
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 500);
  };
  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  // v3.5 常规设置「关闭到托盘」：拦截 close → 隐藏到托盘（托盘菜单「显示主窗口」/「退出」）；
  // app.quit() 路径（托盘退出/系统注销）经 before-quit 标志放行
  win.on("close", (e) => {
    if (!quitting && loadConfig()?.general?.closeToTray === true) {
      e.preventDefault();
      win.hide();
      return;
    }
    saveWindowState(win);
  });

  // 显示：就绪后展示（避免白屏闪烁）；加固环境首帧合成可能极慢/不触发 → 2s 超时兜底
  win.once("ready-to-show", () => {
    if (state.maximized) win.maximize();
    win.show();
  });
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      if (state.maximized) win.maximize();
      win.show();
    }
  }, 2000);

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 应用内新窗口一律拒绝（外链交给系统浏览器）
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // v4.0 审计修复（M12）：主窗口导航守卫——主窗口持有令牌 + infuDesktop 桥，此前仅
  // setWindowOpenHandler、无 will-navigate/will-redirect（guest webview 有三闸守卫而
  // 主窗口裸奔，与威胁优先级不匹配）。放行 = 应用自身来源（dev localhost:5199 /
  // prod 127.0.0.1:<serverPort>——loadURL 不触发 will-navigate，初始加载不受影响）；
  // 其余 http(s) 交给系统浏览器并拦截（防 XSS/恶意链接把主窗口导航到任意远程页面后
  // 持有完整桥），file:// 等一律拦截
  const mainOrigin = (() => {
    try {
      return new URL(IS_DEV ? "http://localhost:5199" : `http://127.0.0.1:${serverPort}`).origin;
    } catch {
      return "";
    }
  })();
  const isMainOrigin = (url: string) => {
    try {
      return !!mainOrigin && new URL(url).origin === mainOrigin;
    } catch {
      return false;
    }
  };
  const guardMainNav = (url: string) => {
    if (isMainOrigin(url)) return; // 应用自身来源放行
    if (/^https?:/i.test(url)) shell.openExternal(url); // 外链 → 系统浏览器（窗口不离开）
  };
  win.webContents.on("will-navigate", (e, url) => {
    if (!isMainOrigin(url)) {
      e.preventDefault();
      guardMainNav(url);
    }
  });
  win.webContents.on("will-redirect", (e, url) => {
    if (!isMainOrigin(url)) {
      e.preventDefault();
      guardMainNav(url);
    }
  });

  // 导航目标（统一等 agent 服务端口就绪后加载；dev = vite 独立端口 + query 传 API 端口）
  if (serverPort > 0) {
    const url = IS_DEV
      ? `http://localhost:5199?infuAgentPort=${serverPort}`
      : `http://127.0.0.1:${serverPort}/`;
    // browser-use runtime 页识别排除用（精确排除应用自身页面，防把主窗口当嵌入式页）
    (globalThis as Record<string, unknown>).__infuMainWindowUrl = url;
    win.loadURL(url);
  }
}

// ── 嵌入式真浏览器（v3.0 批 8：<webview> 元素 + 主进程 CDP 桥）──
// 注册表 key = webContents.id（渲染进程 webview.getWebContentsId() 天然一致）
const browserTabs = new Map<number, WebContents>();
let activeTabId: number | null = null;

function activeWc(): WebContents | null {
  return (activeTabId != null && browserTabs.get(activeTabId)) || null;
}

/** 广播全 tab 状态 + 活跃 tab 详情（渲染进程 tab 条 + Agent browser_tabs） */
function sendBrowserState() {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return;
  const tabs = [...browserTabs.entries()].map(([id, wc]) => ({
    id: String(id),
    title: wc.isDestroyed() ? "" : wc.getTitle(),
    url: wc.isDestroyed() ? "" : wc.getURL(),
    active: id === activeTabId,
  }));
  const wc = activeWc();
  mainWindow.webContents.send("browser-view:state", {
    tabs,
    active: wc && !wc.isDestroyed()
      ? {
          url: wc.getURL(),
          title: wc.getTitle(),
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          isLoading: wc.isLoading(),
        }
      : null,
  });
}

/** 刷新全局标记（Agent 侧 CDP 桥读） */
function refreshGlobalMarkers() {
  const wc = activeWc();
  (globalThis as Record<string, unknown>).__infuBrowserWebContents = wc ?? undefined;
  (globalThis as Record<string, unknown>).__infuBrowserTabs = [...browserTabs.entries()].map(([id, t]) => ({
    id: String(id),
    url: t.isDestroyed() ? "" : t.getURL(),
    title: t.isDestroyed() ? "" : t.getTitle(),
    active: id === activeTabId,
  }));
}

/** webview 元素 attach → 注册 + CDP attach + 事件接线（批 8 核心：宿主 CDP 桥） */
function registerBrowserWebContents(wc: WebContents) {
  if (wc.isDestroyed()) return;
  const id = wc.id;
  console.log(`[infu-desktop] webview attach id=${id} url=${wc.getURL()}`);
  browserTabs.set(id, wc);
  // 新 tab 自动激活（用户新建/Agent tab_new 均可见）
  activeTabId = id;

  try {
    wc.debugger.attach("1.3");
  } catch (e) {
    console.log(`[infu-desktop] CDP attach 失败 ${id}: ${(e as Error).message}`);
  }

  // CDP 事件 → Agent 侧订阅（__infuCdpOn 注册的回调）；UI 状态广播走 webContents 事件
  wc.debugger.on("message", (_e, method: string, params: unknown) => {
    const map = (wc as WebContents & { __infuCdpListeners?: Map<string, Array<(p: unknown) => void>> }).__infuCdpListeners;
    if (!map) return;
    for (const cb of map.get(method) ?? []) {
      try { cb(params); } catch { /* 订阅者异常不影响桥 */ }
    }
  });

  // v3.5 审计修复（H1）：guest 导航守卫（webview sandbox=no + 页面内容不可信——
  // 恶意网页可诱导模型/用户导航到本机 InFu 服务读 __INFU_TOKEN__ 自我提权）。
  // 三闸共用 sanitizeBrowserUrl（file:///非 Web scheme 一律拒绝 + 本机服务端口拦截）：
  // ① will-navigate（页面链接/JS 导航）② will-redirect（重定向链）③ window.open
  const guardNav = (url: string): boolean => {
    if (sanitizeBrowserUrl(url)) return true;
    console.log(`[infu-desktop] 拦截 guest 导航: ${String(url).slice(0, 120)}`);
    return false;
  };
  wc.on("will-navigate", (e, url) => {
    if (!guardNav(url)) e.preventDefault();
  });
  wc.on("will-redirect", (e, url) => {
    if (!guardNav(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    // 新窗口一律拒绝（webview 架构内无法承载新窗口；外链由用户自行处理）
    console.log(`[infu-desktop] 拒绝 guest window.open: ${String(url).slice(0, 120)}`);
    return { action: "deny" };
  });

  // UI 状态广播（tab 条/工具栏）
  const onState = () => sendBrowserState();
  wc.on("did-navigate", onState);
  wc.on("did-navigate-in-page", onState);
  wc.on("page-title-updated", onState);
  wc.on("did-start-loading", onState);
  wc.on("did-stop-loading", onState);
  wc.on("destroyed", () => {
    browserTabs.delete(id);
    if (activeTabId === id) {
      activeTabId = browserTabs.keys().next().value ?? null;
    }
    refreshGlobalMarkers();
  });

  refreshGlobalMarkers();
  sendBrowserState();
}

/** Agent 侧 CDP 命令直发（与主进程同进程 → 全局函数直接调用） */
(globalThis as Record<string, unknown>).__infuCdpSend = async (tabId: string | number, method: string, params?: unknown) => {
  const wc = browserTabs.get(Number(tabId));
  if (!wc || wc.isDestroyed()) throw new Error(`浏览器 tab ${tabId} 不存在`);
  // v3.5 审计修复（H1）：Page.navigate 走与地址栏相同的 URL 策略（主进程侧拦截，
  // Agent 直接 CDP 导航不再绕过 sanitizeBrowserUrl）——loopback 端口判定用真实 serverPort
  if (method === "Page.navigate") {
    const url = (params as { url?: unknown } | undefined)?.url;
    if (typeof url === "string" && !sanitizeBrowserUrl(url)) {
      throw new Error(`导航被拦截（非法/本机服务地址）：${url.slice(0, 120)}`);
    }
  }
  return wc.debugger.sendCommand(method, params);
};
/** Agent 侧 CDP 事件订阅（Page.loadEventFired / Runtime.consoleAPICalled 等） */
(globalThis as Record<string, unknown>).__infuCdpOn = (tabId: string | number, method: string, cb: (params: unknown) => void) => {
  const wc = browserTabs.get(Number(tabId));
  if (!wc || wc.isDestroyed()) throw new Error(`浏览器 tab ${tabId} 不存在`);
  const listeners = (wc as WebContents & { __infuCdpListeners?: Map<string, Array<(p: unknown) => void>> }).__infuCdpListeners;
  const map = listeners ?? new Map<string, Array<(p: unknown) => void>>();
  (wc as WebContents & { __infuCdpListeners?: Map<string, Array<(p: unknown) => void>> }).__infuCdpListeners = map;
  const arr = map.get(method) ?? [];
  arr.push(cb);
  map.set(method, arr);
  return () => {
    const a = map.get(method) ?? [];
    const i = a.indexOf(cb);
    if (i >= 0) a.splice(i, 1);
  };
};

/**
 * v3.4 审计修复（M1）：loopback 检测——webview 可导航到本机 InFu 服务
 * （http://127.0.0.1:4317/），agent 若被网页内容诱导导航过去，可用 browser_eval
 * 读取注入的 window.__INFU_TOKEN__ 并调用 /api/approvals/bypass 自我提权放行全部
 * 审批（confirm 档保证被打破）。localhost / 127.x / ::1 / IPv4 简写 / 非标准数字段
 * （hex/octal）一律拒绝导航（fail-closed）。
 * v3.6 审计修复：判定改用 @infu/shared isLoopbackHostText——IPv6 文本完整解包
 * （原正则只认 ::ffff: 点分形式，`::ffff:7f00:1`、`::7f00:1`、`0:0:0:0:0:0:0:1`
 * 等变体全漏判放行，恶意网页可直达带 token 的 InFu 服务自我提权）。
 */
function isLoopbackTarget(u: URL): boolean {
  return isLoopbackHostText(u.hostname);
}

/** 嵌入浏览器 URL 校验（v3.1 审计修复：拒绝 file:// 等非 Web scheme——webview 无沙箱，
 *  file:// 可直读磁盘；Agent 驱动与 UI 地址栏共用，非法返回 null 不导航。
 *  v3.4 审计修复（M1）：拦截 loopback 目标（见 isLoopbackTarget）。
 *  v3.5 审计修复（H1 收口）：loopback 拦截改为**仅 InFu 服务自身端口**——v3.4 拦全部
 *  回环地址把本地 dev server 预览（如 vite 5173）一并误伤，而嵌入式浏览器预览本地服务
 *  是核心用途；真正要防的是带 __INFU_TOKEN__ 注入面的 InFu 服务（端口随冲突自增，
 *  用当前实际 serverPort 判定；URL 省略端口 = 默认端口 80/443，非 InFu 服务 → 放行） */
function sanitizeBrowserUrl(raw?: string): string | null {
  if (!raw || !raw.trim()) return null;
  const u = raw.trim();
  if (/^https?:/i.test(u)) {
    try {
      if (isLoopbackTarget(new URL(u))) {
        const port = new URL(u).port;
        if (!port || Number(port) === serverPort) {
          console.log(`[infu-desktop] 拒绝本机服务导航: ${u.slice(0, 120)}`);
          return null;
        }
      }
    } catch {
      return null;
    }
    return u;
  }
  if (u === "about:blank") return u;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(u)) return `https://${u}`;
  console.log(`[infu-desktop] 拒绝非法浏览器地址: ${u.slice(0, 120)}`);
  return null;
}

/** Agent 无浏览器时 → 渲染进程建 webview（UI 层创建元素，主进程 did-attach-webview 自动注册） */
(globalThis as Record<string, unknown>).__infuOpenEmbeddedBrowser = (url?: string) => {
  const safe = sanitizeBrowserUrl(url);
  console.log(`[infu-desktop] open-request url=${safe ?? "(blank)"} tabs=${browserTabs.size}`);
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("browser-view:open-request", safe);
  }
};
/** Agent 切换 tab（渲染进程 webview 显隐 + 主进程注册表同步） */
(globalThis as Record<string, unknown>).__infuSelectBrowserTab = (id: string | number) => {
  const wc = browserTabs.get(Number(id));
  if (!wc || wc.isDestroyed()) return;
  activeTabId = Number(id);
  refreshGlobalMarkers();
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("browser-view:select", String(id));
  }
  sendBrowserState();
};

/** Agent 设置 viewport → 通知 UI 面板贴合（BrowserPanel freeSize） */
(globalThis as Record<string, unknown>).__infuNotifyViewport = (opts: { width?: number; height?: number; fit?: boolean }) => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("browser-view:viewport-changed", opts);
  }
};

// ── 开机自启（v3.0 批 12：设置 → 常规 → 开机自启；默认关闭，用户主动开启）──
(globalThis as Record<string, unknown>).__infuSetAutoLaunch = (on: boolean) => {
  try {
    app.setLoginItemSettings({ openAtLogin: on });
    console.log(`[infu-desktop] 开机自启已${on ? "开启" : "关闭"}`);
  } catch (e) {
    console.log(`[infu-desktop] 开机自启设置失败: ${(e as Error).message.slice(0, 120)}`);
  }
};

// v3.5 设置审计修复：启动复算开机自启——config 被直接修改/数据迁移后桌面不会主动补建；
// 登录项本身跨重启持久，这里保证「配置为开」与「实际开启」一致（配置为关则保持不打扰）
try {
  if (loadConfig()?.general?.autoLaunch === true) {
    app.setLoginItemSettings({ openAtLogin: true });
  }
} catch { /* 平台不支持忽略 */ }

// ── computer-use 桌面通道（v3.0 vision 底座；v3.2 增强：DPI 感知/多显示器/滚动/按键/移动）──
// 零依赖实现：截图 = PowerShell System.Drawing（CopyFromScreen）；
// 输入 = PowerShell user32 SendInput P/Invoke。每次调用启动一次 PS（~300ms，可接受）。
// v3.2 DPI 修复：PS 进程默认 DPI 非感知时 CopyFromScreen 得到的是**逻辑分辨率**位图，
// 而 SetCursorPos 是物理像素——125%/150% 缩放下截图与点击坐标系统性偏移（点错位置）。
// 修复 = 截图脚本先 SetProcessDPIAware()（物理像素）+ VirtualScreen（全显示器合并边界），
// 并把虚拟原点（可能为负）存全局——click/move 时坐标加回原点偏移。
let lastShotOrigin = { x: 0, y: 0 };


/**
 * B3（v6.0）：桌面 UI 可访问性树读取——对齐 Codex get_app_state。
 * 实现 = Windows UI Automation（UIAutomationClient 系统自带，零依赖）：
 * 读取前台窗口（或指定 pid 窗口）的控件树——类型/名称/位置/可用状态，
 * Agent 不再只靠截图猜坐标（名称直接可读、坐标物理像素与截图/点击同坐标系）。
 * 异步执行（promisify execFile——不阻塞主进程；截图通道的历史 busy-wait 不复用）。
 */
const execFileAsync = promisify(execFile);
(globalThis as Record<string, unknown>).__infuScreenTree = async (opts: {
  maxDepth?: number;
  maxElements?: number;
  pid?: number;
} = {}): Promise<string> => {
  const maxDepth = Math.max(1, Math.min(10, opts.maxDepth ?? 5));
  const maxElements = Math.max(10, Math.min(300, opts.maxElements ?? 120));
  const pid = opts.pid ? Math.max(0, Math.floor(opts.pid)) : 0;
  // 参数全为数字（无用户字符串进脚本）——无注入面。
  // ⚠ -Command 单行模式：每条语句必须以 ; 结尾（换行不可用——`')'if(` 直接拼接是
  // 解析错误，本机冒烟实证）
  const script =
    // PS 5.1 默认以 OEM 代码页（GBK）输出——Node 按 UTF-8 解码会乱码（本机冒烟实证），
    // 强制 stdout 编码 UTF-8
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `Add-Type -AssemblyName UIAutomationClient;` +
    `Add-Type -AssemblyName UIAutomationTypes;` +
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class UiaWin{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}';` +
    `$hwnd=[UiaWin]::GetForegroundWindow();` +
    (pid > 0
      ? `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;` +
        `if(-not $p){Write-Output "ERR: 进程 ${pid} 不存在";exit 1};` +
        `if($p.MainWindowHandle -ne 0){$hwnd=$p.MainWindowHandle};` +
        `if($p.MainWindowHandle -eq 0){Write-Output "ERR: 进程 ${pid} 无主窗口";exit 1};`
      : "") +
    `if($hwnd -eq 0){Write-Output "ERR: 未找到前台窗口";exit 1};` +
    `$root=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd);` +
    `if(-not $root){Write-Output "ERR: 窗口不支持 UIA";exit 1};` +
    `$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker;` +
    `$out=New-Object System.Collections.Generic.List[string];` +
    `$script:count=0;` +
    `$maxD=${maxDepth};` +
    `$maxN=${maxElements};` +
    `function Walk($el,$depth){` +
    `if($depth -gt $maxD -or $script:count -ge $maxN){return};` +
    `try{` +
    `$name=($el.Current.Name -replace "[\\r\\n]+"," ");` +
    `$ct=($el.Current.ControlType.ProgrammaticName -replace 'ControlType\\.','');` +
    `$r=$el.Current.BoundingRectangle;` +
    `$en=$el.Current.IsEnabled;` +
    `$inter=$ct -in @('Button','Edit','ListItem','MenuItem','CheckBox','RadioButton','ComboBox','TabItem','Hyperlink','TreeItem','Slider','Spinner','SplitButton','Custom','DataItem','HeaderItem');` +
    `if($r.Width -gt 0 -and $r.Height -gt 0){` +
    `$indent='  ' * $depth;` +
    `if($inter){` +
    `$line=$indent+'['+$script:count+'] '+$ct+' "'+$name+'" ('+[int]$r.X+','+[int]$r.Y+' '+[int]$r.Width+'x'+[int]$r.Height+')';` +
    `if(-not $en){$line+=' [禁用]'};` +
    `$script:count++;` +
    `}else{$line=$indent+'- '+$ct+' "'+$name+'"'};` +
    `if($line.Trim().Length -gt 0){$out.Add($line)};` +
    `};` +
    `}catch{};` +
    `$c=$walker.GetFirstChild($el);` +
    `while($c -ne $null){Walk $c ($depth+1);$c=$walker.GetNextSibling($c)};` +
    `};` +
    `Walk $root 0;` +
    `$title=$root.Current.Name;` +
    `Write-Output "【窗口】 $title";` +
    `if($out.Count -eq 0){Write-Output "（无可访问控件——应用可能不支持 UI Automation）"}` +
    `else{$out | ForEach-Object { Write-Output $_ }};`;
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 10000, windowsHide: true, encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 }
    );
    return (stdout ?? "").trim() || "（空树）";
  } catch (e) {
    console.log(`[infu-desktop] UI 树读取失败: ${(e as Error).message.slice(0, 120)}`);
    return `UI 树读取失败：${(e as Error).message.slice(0, 120)}`;
  }
};

/** 桌面截图 → 保存 PNG → 返回路径（失败 null）。dir 必须已存在；
 *  minimize=true 时先最小化 InFu 窗口（单屏用户 InFu 挡在最前 → 永远截到 InFu 界面），
 *  截完 800ms 后恢复窗口（Agent 操作期间用户仍可观察） */
(globalThis as Record<string, unknown>).__infuScreenCapture = (dir: string, minimize?: boolean, sessionId?: string): string | null => {
  // 会话前缀（批 12：computer use 数据按会话对应——面板按当前会话过滤截图流）
  const sid = sessionId ? sessionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8) : "";
  const file = join(dir, `screen-${sid ? sid + "-" : ""}${Date.now().toString(36)}.png`);
  let minimized = false;
  if (minimize && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.minimize();
    minimized = true;
    // 等窗口动画完成（~500ms）
    const t0 = Date.now();
    while (Date.now() - t0 < 500) { /* busy-wait 极短 */ }
  }
  // v3.0 审计修复（C1）：PS 单引号字符串内 `'` 需转义为 `''`——原实现只转义反斜杠，
  // root 路径含单引号（如 E:\It's a project）会截断字符串造成脚本注入
  const psSingleQuote = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const script =
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
    // v3.2：DPI 感知（物理像素——截图与 SendInput 坐标一致；否则高 DPI 缩放系统性偏移）
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class DpiFix{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}';` +
    `[DpiFix]::SetProcessDPIAware();` +
    // v3.2：VirtualScreen = 全显示器合并边界（多显示器也完整）；主屏在右侧/下方时原点为负值
    `$b=[System.Windows.Forms.Screen]::VirtualScreen.Bounds;` +
    `$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);` +
    `$g=[System.Drawing.Graphics]::FromImage($bmp);` +
    `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);` +
    `$bmp.Save('${psSingleQuote(file)}');` +
    `$g.Dispose();$bmp.Dispose();` +
    `Write-Output "$($b.Location.X),$($b.Location.Y)"`;
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { timeout: 15000, windowsHide: true, encoding: "utf-8" });
    // 解析虚拟屏原点（"X,Y"）——click/move 坐标要加回该偏移（位图坐标 → 物理坐标）
    const m = /(-?\d+)\s*,\s*(-?\d+)/.exec((out ?? "").trim());
    if (m) lastShotOrigin = { x: Number(m[1]), y: Number(m[2]) };
    if (minimized && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.restore();
      }, 800);
    }
    return existsSync(file) ? file : null;
  } catch (e) {
    if (minimized && mainWindow && !mainWindow.isDestroyed()) mainWindow.restore();
    console.log(`[infu-desktop] 截图失败: ${(e as Error).message.slice(0, 120)}`);
    return null;
  }
};

/** 桌面输入（SendInput P/Invoke）——返回 "OK" 或错误描述。
 *  action：click（坐标点击）/ type（文本粘贴）/ move（仅移动光标）/
 *          scroll（滚轮：direction up/down/left/right + amount 格数）/
 *          key（按键组合：如 ctrl+c、alt+tab、enter、f5）/
 *          drag（v3.3 拖拽：x1,y1 → x2,y2，steps 分步） */
(globalThis as Record<string, unknown>).__infuScreenInput = (
  action: "click" | "type" | "move" | "scroll" | "key" | "drag",
  ...params: Array<string | number>
): string => {
  try {
    // 统一 P/Invoke 头（一次编译，多方法；user32 SendInput/keybd_event/SetCursorPos）
    const addType =
      `Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class InFuInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public static void Click(int x, int y, uint down, uint up) {
    SetCursorPos(x, y); Thread.Sleep(50);
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 0; inputs[0].mi.dwFlags = down;
    inputs[1].type = 0; inputs[1].mi.dwFlags = up;
    SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
  // v3.3 computer use 补齐：拖拽（左键按下 → 分步移动 → 松开；对齐 Codex/Claude Code drag 能力）
  public static void Drag(int x1, int y1, int x2, int y2, int steps) {
    SetCursorPos(x1, y1); Thread.Sleep(50);
    INPUT down = new INPUT(); down.type = 0; down.mi.dwFlags = 0x0002; // LEFT DOWN
    SendInput(1, new INPUT[] { down }, Marshal.SizeOf(typeof(INPUT)));
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
      Thread.Sleep(15);
    }
    INPUT up = new INPUT(); up.type = 0; up.mi.dwFlags = 0x0004; // LEFT UP
    SendInput(1, new INPUT[] { up }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Scroll(int delta, bool horizontal) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = 0;
    inputs[0].mi.dwFlags = horizontal ? 0x1000u : 0x0800u; // MOUSEEVENTF_HWHEEL / WHEEL
    inputs[0].mi.mouseData = (uint)delta;
    SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
public static class InFuKeys {
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static void Press(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void Release(byte vk) { keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static void Paste() {
    Press(0x11); Tap(0x56); Release(0x11); // Ctrl+V
  }
}
'@;`;
    const shift = lastShotOrigin;
    let script = addType;
    if (action === "click") {
      const x = Math.round(Number(params[0])) + shift.x;
      const y = Math.round(Number(params[1])) + shift.y;
      const btn = String(params[2] ?? "left");
      const flags = btn === "right" ? 0x0008 : 0x0002; // RButtonDown | LButtonDown
      const upFlags = btn === "right" ? 0x0010 : 0x0004; // RButtonUp | LButtonUp
      const clicks = btn === "double" ? 2 : 1;
      script += `[InFuInput]::Click(${x}, ${y}, ${flags}u, ${upFlags}u)` +
        (clicks > 1 ? `;[InFuInput]::Click(${x}, ${y}, ${flags}u, ${upFlags}u)` : "");
    } else if (action === "move") {
      const x = Math.round(Number(params[0])) + shift.x;
      const y = Math.round(Number(params[1])) + shift.y;
      script += `[InFuInput]::Move(${x}, ${y})`;
    } else if (action === "drag") {
      // v3.3：拖拽（x1,y1 → x2,y2；steps 分步移动，默认 10）
      const x1 = Math.round(Number(params[0])) + shift.x;
      const y1 = Math.round(Number(params[1])) + shift.y;
      const x2 = Math.round(Number(params[2])) + shift.x;
      const y2 = Math.round(Number(params[3])) + shift.y;
      const steps = Math.max(1, Math.min(50, Math.round(Number(params[4] ?? 10))));
      script += `[InFuInput]::Drag(${x1}, ${y1}, ${x2}, ${y2}, ${steps})`;
    } else if (action === "scroll") {
      // params: direction("up"|"down"|"left"|"right"), amount(格数，默认 1)
      const dir = String(params[0] ?? "down");
      const amount = Math.max(1, Math.round(Number(params[1] ?? 1)));
      const delta = 120 * amount;
      const horizontal = dir === "left" || dir === "right";
      const signed = dir === "down" || dir === "right" ? delta : -delta;
      script += `[InFuInput]::Scroll(${signed}, ${horizontal ? "true" : "false"})`;
    } else if (action === "key") {
      // 按键组合：ctrl+c / alt+tab / enter / f5 / shift+up …（+ 分隔；先修饰键后主键）
      const combo = String(params[0] ?? "").trim().toLowerCase();
      const MAP: Record<string, number> = {
        enter: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, space: 0x20,
        delete: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
        up: 0x26, down: 0x28, left: 0x25, right: 0x27,
        ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b,
        f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76,
        f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
      };
      const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
      const vks: number[] = [];
      for (const p of parts) {
        if (p.length === 1 && /[a-z0-9]/.test(p)) vks.push(p.charCodeAt(0) >= 0x30 && p.charCodeAt(0) <= 0x39 ? p.charCodeAt(0) : p.toUpperCase().charCodeAt(0));
        else if (MAP[p]) vks.push(MAP[p]);
        else return `按键未知：${p}（支持 a-z/0-9/enter/tab/esc/space/方向键/f1-f12/ctrl/alt/shift/win，用 + 组合如 ctrl+c）`;
      }
      if (!vks.length) return "按键为空";
      // 先按修饰键（ctrl/alt/shift/win），再 Tap 主键，再松开修饰键
      for (const v of vks) if (v === 0x11 || v === 0x12 || v === 0x10 || v === 0x5b) script += `[InFuKeys]::Press(${v}u);`;
      const main = vks[vks.length - 1];
      script += `[InFuKeys]::Tap(${main}u);`;
      for (const v of [...vks].reverse()) if (v === 0x11 || v === 0x12 || v === 0x10 || v === 0x5b) script += `[InFuKeys]::Release(${v}u);`;
    } else {
      // type：剪贴板粘贴（Unicode 安全，绕开 SendKeys 特殊字符转义）
      const text = String(params[0] ?? "").replace(/'/g, "''");
      script +=
        `[System.Windows.Forms.Clipboard]::SetText('${text}');` +
        `[InFuKeys]::Paste();[System.Windows.Forms.Clipboard]::Clear();`;
    }
    execFileSync("powershell", ["-NoProfile", "-Command", script], { timeout: 15000, windowsHide: true });
    return "OK";
  } catch (e) {
    return `输入失败：${(e as Error).message.slice(0, 120)}`;
  }
};

/**
 * v3.3 computer use 补齐：窗口管理（PowerShell 零依赖）——
 *  list：Get-Process 主窗口句柄非零的进程（可见窗口；标题/进程名/窗口句柄）；
 *  activate：按进程名或标题关键词模糊匹配 → SetForegroundWindow + ShowWindow(SW_RESTORE 9)。
 * 返回 "OK" 或错误描述；每次调用启动一次 PS（~300ms）。
 */
(globalThis as Record<string, unknown>).__infuScreenWindows = (action: string, name?: string): string => {
  try {
    if (action === "list") {
      const script =
        `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ` +
        `Select-Object -First 40 ProcessName, Id, MainWindowTitle | ` +
        `ForEach-Object { "$($_.ProcessName)|$($_.Id)|$($_.MainWindowTitle)" }`;
      const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
        timeout: 15000, windowsHide: true, encoding: "utf8",
      }).toString().trim();
      if (!out) return "当前没有可见窗口（或主进程枚举受限）";
      const lines = out.split(/\r?\n/).filter(Boolean).map((l) => {
        const [proc, pid, ...titleParts] = l.split("|");
        const title = titleParts.join("|").trim();
        return `· ${proc}（pid ${pid}）${title ? `— ${title.slice(0, 80)}` : ""}`;
      });
      return `可见窗口（${lines.length} 个）：\n${lines.join("\n")}\n\n激活: screen_windows(action=activate, name=进程名或标题关键词)`;
    }
    if (action === "activate") {
      if (!name) return "错误：activate 需要 name 参数";
      const safe = String(name).replace(/'/g, "''");
      const script =
        `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InFuWin {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  public static bool Activate(IntPtr h) { if (IsIconic(h)) ShowWindow(h, 9); return SetForegroundWindow(h); }
}
'@;` +
        // 模糊匹配用 Contains（-match 是正则——用户输入含元字符会报错/误配；' 已转义防注入）
        `$ps = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName.Contains('${safe}') -or $_.MainWindowTitle.Contains('${safe}')) } | Select-Object -First 1;` +
        `if (-not $ps) { "NOT_FOUND" } else { if ([InFuWin]::Activate($ps.MainWindowHandle)) { "OK:$($ps.ProcessName):$($ps.MainWindowTitle)" } else { "FAILED" } }`;
      const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
        timeout: 15000, windowsHide: true, encoding: "utf8",
      }).toString().trim();
      if (out === "NOT_FOUND") return `未找到匹配窗口「${name}」——先 screen_windows(action=list) 查看可见窗口（用进程名或标题关键词）`;
      if (out === "FAILED") return `激活失败：窗口句柄无效或前台限制（Windows 前台锁——通常点击一次即可恢复）`;
      const [, proc, title] = out.split(":");
      return `已激活窗口 ${proc}${title ? `（${title}）` : ""}`;
    }
    return `错误：未知操作 ${action}（支持 list / activate）`;
  } catch (e) {
    return `窗口操作失败：${(e as Error).message.slice(0, 120)}`;
  }
};


// ── IPC（渲染进程 preload 桥）──
/**
 * 审计修复（H-2）：IPC 调用方校验——全部 ipcMain 通道只接受主窗口 webContents。
 * 此前无校验：嵌入式浏览器的 webview guest（内容来自任意网站，如示例 iframe/广告）与
 * 未来任何渲染进程都能向主进程发 window:close / browser-view:navigate / open-external 等
 * 控制类消息（guest 页面可注入 JS 调 ipcRenderer.send——webview 未加载 preload 时
 * ipcRenderer 仍可达主进程通道）。preload 仅注入主窗口，信任面 = 应用自身页面。
 */
function isTrustedSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const wc = mainWindow?.webContents;
  return !!wc && e.sender === wc;
}

function registerIpc() {
  const trusted = isTrustedSender;
  // 窗口控制（无边框标题栏）
  ipcMain.on("window:minimize", (e) => { if (!trusted(e)) return; mainWindow?.minimize(); });
  ipcMain.on("window:maximize-toggle", (e) => {
    if (!trusted(e)) return;
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on("window:close", (e) => { if (!trusted(e)) return; mainWindow?.close(); });

  // v3.0 批 12：附件「选择路径」——桌面版用系统对话框拿真实绝对路径（Web 版才被迫上传内容）
  ipcMain.handle("dialog:select-paths", async (e, opts: { directories?: boolean }) => {
    if (!trusted(e)) return [];
    const w = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const r = await dialog.showOpenDialog(w!, {
      title: opts?.directories ? "选择文件夹" : "选择文件",
      properties: opts?.directories ? ["openDirectory", "multiSelections"] : ["openFile", "multiSelections"],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  // 主题联动（设置页切换主题 → titleBarOverlay 原生按钮配色）
  ipcMain.on("theme:set", (e, theme: string) => {
    if (!trusted(e)) return;
    if (mainWindow) applyThemeOverlay(mainWindow, theme);
  });

  // 嵌入式浏览器（v3.0 批 8：webview 元素——渲染进程管元素，主进程管注册表/CDP）
  // open：渲染进程告知面板已打开（无 tab 时主进程请求渲染进程新建）
  ipcMain.on("browser-view:open", (e) => {
    if (!trusted(e)) return;
    if (!activeWc()) {
      mainWindow?.webContents.send("browser-view:open-request", null);
    } else {
      sendBrowserState();
    }
  });
  ipcMain.on("browser-view:new-tab", (e) => {
    if (!trusted(e)) return;
    mainWindow?.webContents.send("browser-view:open-request", null);
  });
  // 渲染进程 webview attach 完成 → 激活同步
  ipcMain.on("browser-view:registered", (e, wcId: number) => {
    if (!trusted(e)) return;
    if (browserTabs.has(wcId)) {
      activeTabId = wcId;
      refreshGlobalMarkers();
      sendBrowserState();
    }
  });
  ipcMain.on("browser-view:select", (e, id: string | number) => {
    if (!trusted(e)) return;
    const n = Number(id);
    if (browserTabs.has(n)) {
      activeTabId = n;
      refreshGlobalMarkers();
      sendBrowserState();
    }
  });
  ipcMain.on("browser-view:close-tab", (e, id: string | number) => {
    if (!trusted(e)) return;
    const wc = browserTabs.get(Number(id));
    if (!wc || wc.isDestroyed()) return;
    browserTabs.delete(Number(id));
    if (activeTabId === Number(id)) {
      activeTabId = browserTabs.keys().next().value ?? null;
    }
    try { wc.close(); } catch { /* 已销毁 */ }
    refreshGlobalMarkers();
    sendBrowserState();
  });
  ipcMain.on("browser-view:close", (e) => {
    if (!trusted(e)) return;
    for (const id of [...browserTabs.keys()]) {
      const wc = browserTabs.get(id);
      if (wc && !wc.isDestroyed()) { try { wc.close(); } catch { /* 忽略 */ } }
    }
    browserTabs.clear();
    activeTabId = null;
    refreshGlobalMarkers();
    sendBrowserState();
  });
  ipcMain.on("browser-view:navigate", (e, raw: string) => {
    if (!trusted(e)) return;
    const wc = activeWc();
    if (!wc || wc.isDestroyed()) return;
    // v3.6 审计修复：程序化导航统一走 sanitizeBrowserUrl（含 loopback + InFu 服务端口
    // 拦截）——原 navUrl 仅 scheme 检查，且 wc.loadURL() 不触发 will-navigate 守卫
    const url = sanitizeBrowserUrl(raw);
    if (url) wc.loadURL(url);
  });
  ipcMain.on("browser-view:back", (e) => {
    if (!trusted(e)) return;
    const wc = activeWc();
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  });
  ipcMain.on("browser-view:forward", (e) => {
    if (!trusted(e)) return;
    const wc = activeWc();
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  });
  ipcMain.on("browser-view:reload", (e) => {
    if (!trusted(e)) return;
    const wc = activeWc();
    if (wc && !wc.isDestroyed()) wc.reload();
  });
  ipcMain.on("browser-view:stop", (e) => {
    if (!trusted(e)) return;
    const wc = activeWc();
    if (wc && !wc.isDestroyed()) wc.stop();
  });
  // DevTools 独立小窗（detach，同款）
  ipcMain.on("browser-view:devtools", (e) => {
    if (!trusted(e)) return;
    const wc = activeWc();
    if (!wc || wc.isDestroyed()) return;
    try {
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: "detach" });
    } catch (err) {
      console.log(`[infu-desktop] DevTools 失败: ${(err as Error).message}`);
    }
  });
  ipcMain.on("browser-view:open-external", (e, url: string) => {
    if (!trusted(e)) return;
    // v4.0 审计修复（M5）：本机回环地址不进系统浏览器——https://127.0.0.1:4317/（含
    // token 的 InFu UI）经此通道在外部浏览器打开，浏览器扩展/历史缓存可读取令牌；
    // isLoopbackHostText（IPv6 解包/简写 fail-closed）拦回环与 localhost，公网与
    // 内网（192.168 等）属用户意图照常打开
    if (typeof url !== "string" || !/^https?:/i.test(url)) return;
    try {
      if (isLoopbackHostText(new URL(url).hostname)) return;
    } catch {
      return;
    }
    shell.openExternal(url);
  });
  // v3.5 修复：UI 视口（📄 预设/适应窗口）→ CDP Emulation 同步（与 Agent
  // browser_viewport 同一通道——此前只改元素 CSS，Agent 设过的设备度量残留 → 适应窗口无效）
  ipcMain.handle("browser-view:set-viewport", async (e, opts: { width?: number; height?: number; fit?: boolean }) => {
    if (!trusted(e)) return;
    const wc = activeWc();
    if (!wc || wc.isDestroyed()) return;
    try {
      if (opts?.fit) {
        await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      } else if (opts?.width && opts?.height) {
        await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: Math.round(opts.width),
          height: Math.round(opts.height),
          deviceScaleFactor: 0,
          mobile: false,
        });
      }
    } catch (err) {
      console.log(`[infu-desktop] viewport 同步失败: ${(err as Error).message}`);
      return;
    }
    // 通知渲染进程保持状态一致（fit 清 freeSize）
    const notifyViewport = (globalThis as Record<string, unknown>).__infuNotifyViewport as ((opts: unknown) => void) | undefined;
    notifyViewport?.(opts);
  });
}

function createTray() {
  // 托盘图标：16x16 运行绿圆点（正式图标随打包阶段替换）
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="4" fill="#22C55E"/></svg>`;
  tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}`));
  tray.setToolTip("InFu");
  refreshTrayMenu();
  tray.on("click", () => refreshTrayMenu());
  tray.on("right-click", () => refreshTrayMenu());
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

/** v5.0（C3）：托盘菜单动态重建——最近会话 / 运行中任务（数据来自同进程 agent 会话库） */
function refreshTrayMenu() {
  if (!tray) return;
  const show = () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  };
  const openSession = (id: string) => {
    show();
    mainWindow?.webContents.send("session:open", id);
  };
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "显示主窗口", click: show },
    { type: "separator" },
  ];
  try {
    const sessions = getStore().listSessions(10, false);
    const running = sessions.filter((s) => s.status === "running");
    if (running.length > 0) {
      items.push({ label: `运行中任务（${running.length}）`, enabled: false });
      for (const s of running) {
        items.push({ label: `▶ ${s.title.slice(0, 20)}`, click: () => openSession(s.id) });
      }
      items.push({ type: "separator" });
    }
    items.push({ label: "最近会话", enabled: sessions.length === 0 });
    for (const s of sessions.slice(0, 5)) {
      items.push({ label: `${s.status === "running" ? "▶ " : ""}${s.title.slice(0, 24)}`, click: () => openSession(s.id) });
    }
    if (sessions.length === 0) items.push({ label: "（暂无会话）", enabled: false });
  } catch {
    items.push({ label: "（会话库未就绪）", enabled: false });
  }
  items.push({ type: "separator" });
  items.push({ label: "退出", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// 托盘打开会话 → 渲染进程（前端 onOpenSession 处理：加载会话 + 切换视图）
// 审计修复（H-2）：与 registerIpc 同款 sender 校验——防非主窗口进程伪造调用
ipcMain.on("session:open", (e, id: string) => {
  if (e.sender !== mainWindow?.webContents) return;
  const sid = String(id ?? "");
  if (!sid || !mainWindow || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("session:open", sid);
});

// ── 生命周期 ──
app.whenReady().then(() => {
  registerIpc();
  createMainWindow();
  createTray();

  // 启动 agent 后端（同进程宿主；生产模式同端口托管 web dist）
  // dist/main.js → ../.. = packages → web/dist
  const staticDir = IS_DEV ? undefined : join(__dirname, "..", "..", "web", "dist");
  startServer({
    host: "127.0.0.1",
    ...(staticDir ? { staticDir } : {}),
    onEvent: (sessionId, ev) => {
      // v3.5 常规设置：运行中防休眠（user-message 开始 / done·stopped·error 结束）
      // v3.6：stopped/error 也解除（原只处理 done——用户中止时 loop 只 emit error，
      // 防休眠永不解除，系统空闲后照常休眠与用户意图相悖）
      if (loadConfig()?.general?.preventSleep === true) {
        if (ev.type === "user-message") {
          if (powerSaveId == null) {
            powerSaveId = powerSaveBlocker.start("prevent-app-suspension");
          }
        } else if (ev.type === "done" || ev.type === "error") {
          if (powerSaveId != null) {
            try { powerSaveBlocker.stop(powerSaveId); } catch { /* 忽略 */ }
            powerSaveId = null;
          }
        }
      }
      // v3.5 常规设置：任务完成系统通知（仅桌面端；done 是会话终态事件）
      if (ev.type === "done") {
        const g = loadConfig()?.general;
        if (g?.taskNotifications !== false) {
          try {
            const ok = !String(ev.text ?? "").startsWith("任务已中止") && (ev.text?.length ?? 0) > 0;
            new Notification({
              title: ok ? "InFu · 任务完成" : "InFu · 任务结束",
              body: String(ev.text ?? "").replace(/\s+/g, " ").slice(0, 160),
              silent: g?.notificationSound === false,
            }).show();
          } catch { /* 通知失败忽略（未授权等） */ }
        }
      }
      void sessionId;
    },
    onListening: (port) => {
      serverPort = port;
      console.log(`[infu-desktop] agent 服务就绪: http://127.0.0.1:${port}`);
      if (mainWindow) {
        const url = IS_DEV
          ? `http://localhost:5199?infuAgentPort=${port}`
          : `http://127.0.0.1:${port}/`;
        // 同步更新页识别标记（createMainWindow 的初始标记可能因端口冲突过期）
        (globalThis as Record<string, unknown>).__infuMainWindowUrl = url;
        mainWindow.loadURL(url);
      }
    },
  });

  app.on("activate", () => {
    // macOS dock 点击（保留兼容）
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  // v3.5 关闭到托盘：真正的退出（托盘菜单/系统）标记后放行 close 拦截
  app.on("before-quit", () => {
    quitting = true;
    if (powerSaveId != null) {
      try { powerSaveBlocker.stop(powerSaveId); } catch { /* 忽略 */ }
      powerSaveId = null;
    }
  });
});

app.on("window-all-closed", () => {
  app.quit(); // 关闭窗口 = 退出应用（用户拍板）
});
