/** 桌面端桥类型（preload contextBridge 暴露；Web 版无 infuDesktop → 保持占位/无标题栏） */
export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  active: boolean;
}
export interface BrowserActiveState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}
export interface BrowserViewState {
  tabs: BrowserTabInfo[];
  active: BrowserActiveState | null;
}
export interface InfuDesktopBridge {
  // 窗口控制（无边框标题栏）
  minimize(): void;
  maximizeToggle(): void;
  close(): void;
  onMaximized(cb: (maximized: boolean) => void): () => void;
  // 主题联动（overlay 按钮配色）
  setTheme(theme: string): void;
  /** v3.0 批 12：附件「选择路径」（系统对话框 → 真实绝对路径数组；取消返回 []） */
  selectPaths(opts?: { directories?: boolean }): Promise<string[]>;
  /** 在 Windows 资源管理器中定位项目内文件，或交由 VS Code 打开。 */
  openProjectFile(opts: { root: string; path: string; editor?: boolean }): Promise<string | null>;
  // 嵌入式浏览器（v3.0 批 8：<webview> 元素 + 主进程 CDP 桥——元素渲染进程管，
  // 注册表/CDP/导航主进程管；显隐/尺寸渲染进程直管，无 rect 让位）
  browserOpen(): void;
  browserNewTab(): void;
  browserSelectTab(id: string): void;
  browserCloseTab(id: string): void;
  browserCloseAll(): void;
  browserNavigate(url: string): void;
  browserBack(): void;
  browserForward(): void;
  browserReload(): void;
  browserStop(): void;
  browserDevtools(): void;
  browserOpenExternal(url: string): void;
  /** v3.5 修复：UI 视口（📄 预设/适应窗口）→ 主进程 CDP Emulation 同步（Agent 残留的
   *  设备度量覆盖会被清除——此前「适应窗口」只改元素 CSS，内容仍按旧视口渲染） */
  browserSetViewport(opts: { width?: number; height?: number; fit?: boolean }): Promise<void>;
  browserSetZoom(factor: number): Promise<void>;
  onOpenRequest(cb: (url: string | null) => void): () => void;
  onBrowserSelect(cb: (id: string) => void): () => void;
  onBrowserState(cb: (s: BrowserViewState) => void): () => void;
  onViewportChanged(cb: (opts: { width?: number; height?: number; fit?: boolean }) => void): () => void;
  /** v5.0（C3）：托盘「最近会话/运行中任务」→ 打开对应会话 */
  onOpenSession(cb: (id: string) => void): () => void;
}

/** Electron <webview> 元素（webviewTag 启用后可用；Electron WebviewTag 的渲染进程 API 子集） */
export interface InfuWebviewElement extends HTMLElement {
  src: string;
  webpreferences?: string;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  openDevTools(options?: { mode?: "detach" | "right" | "bottom" | "undocked" }): void;
  getWebContentsId(): number;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

declare global {
  interface Window {
    infuDesktop?: InfuDesktopBridge;
  }
  interface HTMLElementTagNameMap {
    webview: InfuWebviewElement;
  }
}
