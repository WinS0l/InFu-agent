/**
 * InFu 桌面端 preload（CJS——sandbox 下 preload 仅支持 CommonJS）
 * contextBridge 暴露 window.infuDesktop：
 *  - 窗口控制（无边框标题栏按钮）
 *  - 主题联动（overlay 按钮配色）
 *  - 嵌入式浏览器（v3.0 批 8：<webview> 元素 + 主进程 CDP 桥——
 *    webview 元素由渲染进程创建/管理，主进程持有 guest webContents 注册表
 *    与 CDP 会话；导航/尺寸/DevTools 走主进程，元素显隐由渲染进程直管）
 * Web 版（无 preload）时 window.infuDesktop 不存在 → 前端走现有占位逻辑
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("infuDesktop", {
  // 窗口控制
  minimize: () => ipcRenderer.send("window:minimize"),
  maximizeToggle: () => ipcRenderer.send("window:maximize-toggle"),
  close: () => ipcRenderer.send("window:close"),
  onMaximized: (cb) => {
    const listener = (_e, maximized) => cb(maximized);
    ipcRenderer.on("window:maximized", listener);
    return () => ipcRenderer.removeListener("window:maximized", listener);
  },

  // 主题联动
  setTheme: (theme) => ipcRenderer.send("theme:set", theme),

  // v3.0 批 12：附件「选择路径」（系统对话框 → 真实绝对路径；Web 版无此能力走上传）
  selectPaths: (opts) => ipcRenderer.invoke("dialog:select-paths", opts),

  // 嵌入式浏览器（webview 元素多 tab）
  browserOpen: () => ipcRenderer.send("browser-view:open"),
  browserNewTab: () => ipcRenderer.send("browser-view:new-tab"),
  browserSelectTab: (id) => ipcRenderer.send("browser-view:select", id),
  browserCloseTab: (id) => ipcRenderer.send("browser-view:close-tab", id),
  browserCloseAll: () => ipcRenderer.send("browser-view:close"),
  browserNavigate: (url) => ipcRenderer.send("browser-view:navigate", url),
  browserBack: () => ipcRenderer.send("browser-view:back"),
  browserForward: () => ipcRenderer.send("browser-view:forward"),
  browserReload: () => ipcRenderer.send("browser-view:reload"),
  browserStop: () => ipcRenderer.send("browser-view:stop"),
  browserDevtools: () => ipcRenderer.send("browser-view:devtools"),
  browserOpenExternal: (url) => ipcRenderer.send("browser-view:open-external", url),
  // v3.5 修复：UI 侧视口（📄 预设/适应窗口）→ 主进程 CDP Emulation 同步——
  // 此前用户点击只改元素 CSS，Agent 设过的设备度量覆盖（Emulation）残留 → 「适应窗口」无效
  browserSetViewport: (opts) => ipcRenderer.invoke("browser-view:set-viewport", opts),
  // 主进程广播：Agent/主进程请求建 tab / 切 tab（渲染进程创建 webview 元素 / 切换显隐）
  onOpenRequest: (cb) => {
    const listener = (_e, url) => cb(url);
    ipcRenderer.on("browser-view:open-request", listener);
    return () => ipcRenderer.removeListener("browser-view:open-request", listener);
  },
  onBrowserSelect: (cb) => {
    const listener = (_e, id) => cb(id);
    ipcRenderer.on("browser-view:select", listener);
    return () => ipcRenderer.removeListener("browser-view:select", listener);
  },
  onBrowserState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on("browser-view:state", listener);
    return () => ipcRenderer.removeListener("browser-view:state", listener);
  },
  // Agent 设置 viewport → 面板贴合（freeSize）
  onViewportChanged: (cb) => {
    const listener = (_e, opts) => cb(opts);
    ipcRenderer.on("browser-view:viewport-changed", listener);
    return () => ipcRenderer.removeListener("browser-view:viewport-changed", listener);
  },
});
