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
import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, nativeTheme, shell, dialog, type Rectangle } from "electron";
import type { WebContents } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { startServer } from "@infu/agent/dist/server.js";
import { loadConfig } from "@infu/agent/dist/providers/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_DEV = process.env.INFU_DESKTOP_DEV === "1";

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

// ── 窗口状态持久化（~/.infu/desktop-window.json，复用配置目录）──
function windowStatePath() {
  return join(homedir(), ".infu", "desktop-window.json");
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
    mkdirSync(join(homedir(), ".infu"), { recursive: true });
    writeFileSync(windowStatePath(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
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
    minWidth: 1080,
    minHeight: 680,
    x: state.x,
    y: state.y,
    show: false,
    backgroundColor: "#151517",
    // 无边框：隐藏系统标题栏，保留原生窗口按钮（titleBarOverlay 右上角悬浮，随主题配色；
    // height 32 压缩悬浮区——tab 条底部内容（tabs/➕）与按钮垂直错开，无需大让位）
    titleBarStyle: "hidden",
    titleBarOverlay: { ...themeOverlayColors(theme), height: 32 },
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
  win.on("close", () => saveWindowState(win));

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

/** 嵌入浏览器 URL 校验（v3.1 审计修复：拒绝 file:// 等非 Web scheme——webview 无沙箱，
 *  file:// 可直读磁盘；Agent 驱动与 UI 地址栏共用，非法返回 null 不导航） */
function sanitizeBrowserUrl(raw?: string): string | null {
  if (!raw || !raw.trim()) return null;
  const u = raw.trim();
  if (/^https?:/i.test(u)) return u;
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

// ── computer-use 桌面通道（v3.0 vision 底座）──
// 零依赖实现：截图 = PowerShell System.Drawing（CopyFromScreen）；
// 输入 = PowerShell user32 SendInput P/Invoke。每次调用启动一次 PS（~300ms，可接受）。


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
    `$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;` +
    `$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);` +
    `$g=[System.Drawing.Graphics]::FromImage($bmp);` +
    `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);` +
    `$bmp.Save('${psSingleQuote(file)}');` +
    `$g.Dispose();$bmp.Dispose();`;
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", script], { timeout: 15000, windowsHide: true });
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

/** 桌面输入（SendInput P/Invoke）——返回 "OK" 或错误描述 */
(globalThis as Record<string, unknown>).__infuScreenInput = (
  action: "click" | "type",
  ...params: Array<string | number>
): string => {
  try {
    let script = "";
    if (action === "click") {
      const x = Math.round(Number(params[0]));
      const y = Math.round(Number(params[1]));
      const btn = String(params[2] ?? "left");
      const flags = btn === "right" ? 0x0008 : btn === "double" ? 0x0002 : 0x0002; // RButtonDown | LButtonDown
      const upFlags = btn === "right" ? 0x0010 : 0x0004; // RButtonUp | LButtonUp
      const clicks = btn === "double" ? 2 : 1;
      script =
        `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InFuInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public static void Click(int x, int y, uint down, uint up) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(50);
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 0; inputs[0].mi.dwFlags = down;
    inputs[1].type = 0; inputs[1].mi.dwFlags = up;
    SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@;` +
        `[InFuInput]::Click(${x}, ${y}, ${flags}u, ${upFlags}u)` +
        (clicks > 1 ? `;[InFuInput]::Click(${x}, ${y}, ${flags}u, ${upFlags}u)` : "");
    } else {
      // type：剪贴板粘贴（Unicode 安全，绕开 SendKeys 特殊字符转义）
      const text = String(params[0] ?? "").replace(/'/g, "''");
      script =
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `[System.Windows.Forms.Clipboard]::SetText('${text}');` +
        `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InFuKeys {
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static void Paste() {
    keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(0x56, 0, 0, UIntPtr.Zero);
    keybd_event(0x56, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero);
  }
}
'@;` +
        `[InFuKeys]::Paste();[System.Windows.Forms.Clipboard]::Clear();`;
    }
    execFileSync("powershell", ["-NoProfile", "-Command", script], { timeout: 15000, windowsHide: true });
    return "OK";
  } catch (e) {
    return `输入失败：${(e as Error).message.slice(0, 120)}`;
  }
};


function navUrl(raw: string): string | null {
  const u = raw.trim();
  if (/^https?:/i.test(u)) return u;
  if (u === "about:blank") return u;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(u)) return `https://${u}`;
  return null;
}

// ── IPC（渲染进程 preload 桥）──
function registerIpc() {
  // 窗口控制（无边框标题栏）
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:maximize-toggle", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on("window:close", () => mainWindow?.close());

  // v3.0 批 12：附件「选择路径」——桌面版用系统对话框拿真实绝对路径（Web 版才被迫上传内容）
  ipcMain.handle("dialog:select-paths", async (_e, opts: { directories?: boolean }) => {
    const w = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const r = await dialog.showOpenDialog(w!, {
      title: opts?.directories ? "选择文件夹" : "选择文件",
      properties: opts?.directories ? ["openDirectory", "multiSelections"] : ["openFile", "multiSelections"],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  // 主题联动（设置页切换主题 → titleBarOverlay 原生按钮配色）
  ipcMain.on("theme:set", (_e, theme: string) => {
    if (mainWindow) applyThemeOverlay(mainWindow, theme);
  });

  // 嵌入式浏览器（v3.0 批 8：webview 元素——渲染进程管元素，主进程管注册表/CDP）
  // open：渲染进程告知面板已打开（无 tab 时主进程请求渲染进程新建）
  ipcMain.on("browser-view:open", () => {
    if (!activeWc()) {
      mainWindow?.webContents.send("browser-view:open-request", null);
    } else {
      sendBrowserState();
    }
  });
  ipcMain.on("browser-view:new-tab", () => {
    mainWindow?.webContents.send("browser-view:open-request", null);
  });
  // 渲染进程 webview attach 完成 → 激活同步
  ipcMain.on("browser-view:registered", (_e, wcId: number) => {
    if (browserTabs.has(wcId)) {
      activeTabId = wcId;
      refreshGlobalMarkers();
      sendBrowserState();
    }
  });
  ipcMain.on("browser-view:select", (_e, id: string | number) => {
    const n = Number(id);
    if (browserTabs.has(n)) {
      activeTabId = n;
      refreshGlobalMarkers();
      sendBrowserState();
    }
  });
  ipcMain.on("browser-view:close-tab", (_e, id: string | number) => {
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
  ipcMain.on("browser-view:close", () => {
    for (const id of [...browserTabs.keys()]) {
      const wc = browserTabs.get(id);
      if (wc && !wc.isDestroyed()) { try { wc.close(); } catch { /* 忽略 */ } }
    }
    browserTabs.clear();
    activeTabId = null;
    refreshGlobalMarkers();
    sendBrowserState();
  });
  ipcMain.on("browser-view:navigate", (_e, raw: string) => {
    const wc = activeWc();
    if (!wc || wc.isDestroyed()) return;
    const url = navUrl(raw);
    if (url) wc.loadURL(url);
  });
  ipcMain.on("browser-view:back", () => {
    const wc = activeWc();
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  });
  ipcMain.on("browser-view:forward", () => {
    const wc = activeWc();
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  });
  ipcMain.on("browser-view:reload", () => {
    const wc = activeWc();
    if (wc && !wc.isDestroyed()) wc.reload();
  });
  ipcMain.on("browser-view:stop", () => {
    const wc = activeWc();
    if (wc && !wc.isDestroyed()) wc.stop();
  });
  // DevTools 独立小窗（detach，同款）
  ipcMain.on("browser-view:devtools", () => {
    const wc = activeWc();
    if (!wc || wc.isDestroyed()) return;
    try {
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: "detach" });
    } catch (e) {
      console.log(`[infu-desktop] DevTools 失败: ${(e as Error).message}`);
    }
  });
  ipcMain.on("browser-view:open-external", (_e, url: string) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

function createTray() {
  // 托盘图标：16x16 运行绿圆点（正式图标随打包阶段替换）
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="4" fill="#22C55E"/></svg>`;
  tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}`));
  tray.setToolTip("InFu");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => {
      if (!mainWindow) return;
      mainWindow.show();
      mainWindow.focus();
    } },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]));
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

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
});

app.on("window-all-closed", () => {
  app.quit(); // 关闭窗口 = 退出应用（用户拍板）
});
