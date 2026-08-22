import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, X, Globe, Braces, MoreHorizontal, Smartphone, Tablet, Monitor, Plus, ExternalLink, Maximize2, Minus } from "lucide-react";
import { useStore } from "../store";
import { useClickOutside } from "./useClickOutside";
import type { InfuWebviewElement } from "../desktop";

/**
 * 嵌入式真浏览器面板（v3.0 批 8 定稿：<webview> 元素 + 主进程 CDP 桥）
 *
 * 架构（对齐主流「宿主注入」）：
 *  - 每个 tab = 一个 <webview> 元素（DOM 层叠：圆角/阴影/菜单自然盖在浏览器之上，
 *    即用户拍板「infu 覆盖浏览器」；自由尺寸 = 元素 CSS，无需主进程 bounds）
 *  - 面板**常驻不卸载**（visible 切换 display）——webview 元素从 DOM 移除会销毁
 *    guest webContents，所以会话切换/rightTabs 清空绝不能让本组件卸载；
 *    销毁只发生在用户显式关闭浏览器 tab（×）→ browserCloseAll
 *  - 本地 tabs 为事实源（元素生命周期），主进程广播仅校正销毁/导航状态；
 *    open-request（Agent 建 tab）→ 本地创建元素 → dom-ready 上报 webContentsId
 *    → 主进程 CDP 桥就绪（Agent 侧 __infuCdpSend 直发）
 *
 * 布局：
 *  ┌ tab 条：标题 + × + ➕ 新建 ──────┐
 *  │ ◀ ▶ ↻ 【地址输入】 📄尺寸 ⋯更多   │
 *  │ 内容区（webview 元素；active 显示）│
 */
interface Tab {
  id: string; // 本地稳定 key（t1/t2…）——绝不用 wcId 作 key（key 变化 → 元素重建 → 新 guest 无限循环）
  wcId?: string; // 真实 webContents.id（dom-ready 后填充；与主进程注册表对应）
  title: string;
  url: string;
  active: boolean;
  pending?: boolean;
  error?: string;
}

/** 地址栏显示过滤：起始页（data:）显示占位 */
function displayUrl(url: string): string {
  if (!url || url.startsWith("data:")) return "";
  return url;
}
/** tab 标题：起始页显示「新标签页」 */
function tabTitle(t: Tab): string {
  if (!t.url || t.url.startsWith("data:") || t.url === "about:blank") return "新标签页";
  if (t.title) return t.title.slice(0, 24);
  return t.url.slice(0, 24);
}

/** 尺寸预设（手机/平板/桌面；fit = 适应窗口） */
const VIEWPORTS = [
  { label: "桌面 1440×900", icon: Monitor, w: 1440, h: 900 },
  { label: "手机 375×812", icon: Smartphone, w: 375, h: 812 },
  { label: "平板 768×1024", icon: Tablet, w: 768, h: 1024 },
  { label: "适应窗口", icon: Monitor, fit: true as const },
];

/** Web 版占位（无桌面桥） */
function BrowserPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Globe className="h-8 w-8 text-sub" />
      <div className="text-[13px] font-medium text-text">浏览器面板</div>
      <div className="text-xs leading-5 text-caption">
        将在桌面版提供（嵌入式真实浏览器，同款）。
        <br />
        当前 Web 版 Agent 浏览器截图保存在项目 <span className="font-mono text-sub">.infu/browser/</span> 目录
      </div>
    </div>
  );
}

export default function BrowserPanel({ active: isActive }: { active: boolean }) {
  const desktop = window.infuDesktop;
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [navState, setNavState] = useState<{ canGoBack: boolean; canGoForward: boolean; isLoading: boolean }>({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  });
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [menu, setMenu] = useState<"viewport" | "more" | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customW, setCustomW] = useState("375");
  const [customH, setCustomH] = useState("812");
  const [freeSize, setFreeSize] = useState<{ w?: number; h?: number } | null>(null);
  const [zoom, setZoom] = useState(100);
  const wvRefs = useRef(new Map<string, InfuWebviewElement>());
  const autoCreatedRef = useRef(false);
  // v3.0 批 12：📄/⋯ 下拉菜单点击空白处自动收起
  const menuRef = useClickOutside(() => setMenu(null));
  const seqRef = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const active = tabs.find((t) => t.active) ?? null;
  const activeEl = active ? wvRefs.current.get(active.id) : undefined;
  const changeZoom = (delta: number) => {
    const next = Math.max(50, Math.min(200, zoom + delta));
    setZoom(next);
    void desktop?.browserSetZoom(next / 100);
  };

  /** 对活跃元素执行导航操作（webview 元素自带方法，无需 IPC） */
  const act = <T,>(fn: (el: InfuWebviewElement) => T): T | undefined => {
    const el = activeEl;
    if (!el || active?.pending) return undefined;
    return fn(el);
  };

  /** 新建 tab（用户 ➕ / Agent open-request）：本地 pending → webview dom-ready 后填充 wcId */
  const createTab = (url?: string) => {
    // v4.0 审计修复（M8）：渲染层对 Agent open-request URL 双保险校验——主进程
    // sanitizeBrowserUrl（will-navigate 等）会拦截恶意导航，但渲染层不能把安全
    // 完全押在单一防线（webview sandbox=no 可直读磁盘，file:// 等 scheme 在此拒绝；
    // normalizeUrl 与地址栏共用同一规范化，行为一致）
    let safeUrl = "";
    if (url) {
      safeUrl = normalizeUrl(url);
      if (!safeUrl) return; // 非法 scheme：拒绝建 tab（与地址栏非法输入同语义）
    }
    const id = `t${++seqRef.current}`;
    setTabs((ts) => [...ts.map((t) => ({ ...t, active: false })), { id, title: "新标签页", url: safeUrl, active: true, pending: true }]);
    setFreeSize(null);
  };

  /** 关闭单个 tab：本地移除 + 主进程销毁 guest（pending 未填充 wcId 时跳过——
   *  主进程注册表 key = wcId，传本地 id 找不到会残留 guest） */
  const closeTab = (tab: Tab) => {
    if (desktop && tab.wcId) desktop.browserCloseTab(tab.wcId);
    setTabs((ts) => ts.filter((t) => t.id !== tab.id));
  };

  // ── 订阅主进程广播 ──
  // 状态广播（Agent 销毁全部 → 本地清空；导航能力 → 工具栏）
  useEffect(() => {
    if (!desktop) return;
    return desktop.onBrowserState((s) => {
      setNavState({
        canGoBack: s.active?.canGoBack ?? false,
        canGoForward: s.active?.canGoForward ?? false,
        isLoading: s.active?.isLoading ?? false,
      });
      // Main process is authoritative for guests. Reconcile removals, titles,
      // URLs and active state without creating guest elements from broadcasts.
      setTabs((local) => {
        const mainById = new Map(s.tabs.map((tab) => [tab.id, tab]));
        const next = local
          .filter((tab) => !tab.wcId || mainById.has(tab.wcId))
          .map((tab) => {
            const main = tab.wcId ? mainById.get(tab.wcId) : undefined;
            return main ? { ...tab, title: main.title, url: main.url, active: main.active, pending: false } : tab;
          });
        return next;
      });
      if (s.tabs.length === 0) setFreeSize(null);
    });
  }, [desktop]);

  // v3.3 补 16：Agent 开浏览器建 tab——open-request 事件可能在本组件挂载前已发出
  // （右侧栏折叠时 App 顶层先响应展开），改为消费 store 的 pendingBrowserOpen 状态
  // （App handler 记录；本组件挂载时/变化时消费建 tab），不再依赖事件时序
  const pendingBrowserOpen = useStore((s) => s.pendingBrowserOpen);
  const setPendingBrowserOpen = useStore((s) => s.setPendingBrowserOpen);
  useEffect(() => {
    if (pendingBrowserOpen === null) return;
    setPendingBrowserOpen(null); // 先清空防重入（React 18 StrictMode 双调用）
    createTab(pendingBrowserOpen || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBrowserOpen]);

  // select（Agent 切 tab）→ 本地 active 跟随（id = wcId）
  useEffect(() => {
    if (!desktop) return;
    return desktop.onBrowserSelect((id) => {
      setTabs((ts) => ts.map((t) => ({ ...t, active: t.wcId === id })));
    });
  }, [desktop]);

  // Agent 设置 viewport → 面板贴合（freeSize；fit = 恢复 100%）
  useEffect(() => {
    if (!desktop) return;
    return desktop.onViewportChanged((opts) => {
      if (opts.fit) setFreeSize(null);
      else if (opts.width && opts.height) setFreeSize({ w: opts.width, h: opts.height });
    });
  }, [desktop]);

  // 浏览器 tab 被用户打开时，确保总有一个可立即使用的新标签页。组件本身常驻，
  // 因此以 active 状态而非挂载时机判断，避免打开其他工作区时意外创建 guest。
  useEffect(() => {
    if (tabs.length) {
      autoCreatedRef.current = false;
      return;
    }
    if (!desktop || !isActive || autoCreatedRef.current) return;
    autoCreatedRef.current = true;
    createTab();
    // createTab only appends one local tab. StrictMode is guarded by the ref above.
  }, [desktop, isActive, tabs.length]);

  /** webview 元素挂载后初始化（React 19 对 webview 属性用 property 会丢失 → setAttribute） */
  const attachWebview = (el: InfuWebviewElement | null, tabId: string) => {
    if (!el) {
      wvRefs.current.delete(tabId);
      return;
    }
    wvRefs.current.set(tabId, el);
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab) return;
    // 属性兜底（React 19 property 赋值 webpreferences 会静默丢失；sandbox=no 是
    // 本机加固环境 webview 渲染进程不崩溃的命门——批 8 验证）
    el.setAttribute("webpreferences", "contextIsolation=yes,nodeIntegration=no,sandbox=no,backgroundThrottling=no");
    const src = tab.url || START_URL;
    if (el.getAttribute("src") !== src) el.setAttribute("src", src);

    // 元素事件 → 本地状态（只绑一次）
    if (!(el as InfuWebviewElement & { __infuBound?: boolean }).__infuBound) {
      (el as InfuWebviewElement & { __infuBound?: boolean }).__infuBound = true;
      const update = (patch: Partial<Tab>) =>
        setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, ...patch } : t)));

      el.addEventListener("did-navigate", () => update({ url: el.getURL() }));
      el.addEventListener("did-navigate-in-page", () => update({ url: el.getURL() }));
      el.addEventListener("page-title-updated", () => update({ title: el.getTitle() }));
      el.addEventListener("did-start-loading", () => setNavState((s) => ({ ...s, isLoading: true })));
      el.addEventListener("did-stop-loading", () => setNavState((s) => ({ ...s, isLoading: false })));
      el.addEventListener("did-fail-load", (event) => {
        const detail = event as Event & { errorDescription?: string; errorCode?: number; isMainFrame?: boolean };
        if (detail.isMainFrame === false) return;
        update({ error: detail.errorDescription || `页面加载失败（${detail.errorCode ?? "未知错误"}）` });
      });
      el.addEventListener("dom-ready", () => {
        // 填充真实 webContentsId（主进程注册表 key + CDP 桥就绪）；
        // ⚠️ 绝不能拿 wcId 当 React key（key 变化 → 元素重建 → 新 guest 无限循环）
        const wcId = String(el.getWebContentsId());
        setTabs((ts) =>
          ts.map((t) => (t.id === tabId ? { ...t, wcId, pending: false, error: undefined, url: el.getURL() || t.url } : t))
        );
        // 主进程激活同步（did-attach-webview 已注册 CDP，这里上报激活）
        if (desktop) desktop.browserSelectTab(wcId);
      });
    }
  };

  if (!desktop) return <BrowserPlaceholder />;

  const navBtn =
    "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sub transition-colors hover:bg-hover hover:text-text disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";
  const menuBtn = "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sub transition-colors hover:bg-hover hover:text-text";
  const addr = displayUrl(active?.url ?? "");

  // 自由尺寸：预设/自定义变成可滚动画布内的浏览器窗口；不会把页面滚动误作窗口移动。
  const freeCss =
    freeSize && freeSize.w
      ? { width: `${freeSize.w}px`, height: `${freeSize.h}px` }
      : {};
  const canvasStyle = freeSize?.w && freeSize.h
    ? { minWidth: `${freeSize.w}px`, minHeight: `${freeSize.h}px` }
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── tab 条 ── */}
      <div className="no-scrollbar flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto px-1.5">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group flex h-7 min-w-0 max-w-[150px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
              t.active ? "bg-hover text-text" : "text-sub hover:bg-hover/60 hover:text-text"
            }`}
            onClick={() => {
              setTabs((ts) => ts.map((x) => ({ ...x, active: x.id === t.id })));
              if (desktop && t.wcId) desktop.browserSelectTab(t.wcId);
            }}
            title={displayUrl(t.url) || "新标签页"}
          >
            <span className="min-w-0 flex-1 truncate">{tabTitle(t)}</span>
            <button
              className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-caption opacity-0 transition-opacity hover:bg-line hover:text-text group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t);
              }}
              title="关闭标签页"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button className={menuBtn} onClick={() => createTab()} title="新建标签页">
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* ── 工具栏 ── */}
      <div ref={menuRef} className="relative flex h-10 shrink-0 items-center gap-1 px-2">
        <button className={navBtn} onClick={() => act((el) => el.goBack())} disabled={!navState.canGoBack || !!active?.pending} title="后退">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button className={navBtn} onClick={() => act((el) => el.goForward())} disabled={!navState.canGoForward || !!active?.pending} title="前进">
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          className={navBtn}
          onClick={() => (navState.isLoading ? act((el) => el.stop()) : act((el) => el.reload()))}
          title={navState.isLoading ? "停止" : "刷新"}
        >
          {navState.isLoading ? <X className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
        </button>
        <div className="relative min-w-0 flex-1">
          <input
            className="h-7 w-full rounded-lg border border-line bg-hover px-2.5 text-xs text-text outline-none transition-colors placeholder:text-caption focus:border-info/60"
            value={editing ? input : addr}
            placeholder="输入网址后回车"
            spellCheck={false}
            onFocus={() => {
              setEditing(true);
              setInput(addr);
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && input.trim()) {
                // v3.6 审计修复：地址栏导航改走主进程 IPC（browser-view:navigate）——
                // 原实现 el.loadURL() 直接渲染侧导航，绕过主进程 sanitizeBrowserUrl
                // （loopback + InFu 服务端口拦截），且 loadURL 不触发 will-navigate 守卫
                const url = normalizeUrl(input.trim());
                if (url && desktop) desktop.browserNavigate(url);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
        <div className="flex shrink-0 items-center rounded-lg border border-line p-0.5">
          <button className={menuBtn} onClick={() => changeZoom(-10)} title="缩小页面"><Minus className="h-3.5 w-3.5" /></button>
          <button className="min-w-10 cursor-pointer rounded-md px-1 text-[11px] text-sub hover:bg-hover hover:text-text" onClick={() => { setZoom(100); void desktop.browserSetZoom(1); }} title="重置缩放">{zoom}%</button>
          <button className={menuBtn} onClick={() => changeZoom(10)} title="放大页面"><Plus className="h-3.5 w-3.5" /></button>
        </div>
        {/* 📄 自由尺寸（面板贴合 = 元素 CSS；内容模拟 = Agent CDP Emulation） */}
        <div className="relative">
          <button className={menuBtn} onClick={() => setMenu(menu === "viewport" ? null : "viewport")} title="选择视口尺寸（自由尺寸模式）">
            <Maximize2 className="h-4 w-4" />
          </button>
          {menu === "viewport" && (
            <div className="absolute right-0 top-full z-50 mt-1 w-[180px] rounded-xl border border-line bg-elevated p-1 shadow-lv3">
              {VIEWPORTS.map((v) => (
                <button
                  key={v.label}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-text transition-colors hover:bg-hover"
                  onClick={() => {
                    setMenu(null);
                    // v3.5 修复：UI 预设/适应窗口必须同步主进程 CDP Emulation——
                    // 只改元素 CSS 时 Agent 设过的设备度量覆盖残留 → 「适应窗口」无效
                    if ("fit" in v) {
                      setFreeSize(null);
                      void desktop.browserSetViewport({ fit: true });
                    } else {
                      setFreeSize({ w: v.w, h: v.h });
                      void desktop.browserSetViewport({ width: v.w, height: v.h });
                    }
                  }}
                >
                  <v.icon className="h-3.5 w-3.5 text-sub" />
                  <span>{v.label}</span>
                </button>
              ))}
              <button
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-text transition-colors hover:bg-hover"
                onClick={() => setCustomOpen(!customOpen)}
              >
                <Maximize2 className="h-3.5 w-3.5 text-sub" />
                <span>自定义尺寸…</span>
              </button>
              {customOpen && (
                <div className="mt-1 flex items-center gap-1 border-t border-line px-1 pt-1.5">
                  <input
                    className="h-6 w-14 rounded-md border border-line bg-hover px-1.5 text-center text-xs text-text outline-none focus:border-info/60"
                    value={customW}
                    onChange={(e) => setCustomW(e.target.value.replace(/\D/g, ""))}
                    placeholder="宽"
                  />
                  <span className="text-xs text-caption">×</span>
                  <input
                    className="h-6 w-14 rounded-md border border-line bg-hover px-1.5 text-center text-xs text-text outline-none focus:border-info/60"
                    value={customH}
                    onChange={(e) => setCustomH(e.target.value.replace(/\D/g, ""))}
                    placeholder="高"
                  />
                  <button
                    className="ml-auto h-6 cursor-pointer rounded-md bg-primary px-2 text-xs text-primary-fg transition-colors hover:bg-primary-hover"
                    onClick={() => {
                      const w = parseInt(customW, 10);
                      const h = parseInt(customH, 10);
                      if (w > 100 && h > 100 && w < 4000 && h < 4000) {
                        setFreeSize({ w, h });
                        void desktop.browserSetViewport({ width: w, height: h });
                        setCustomOpen(false);
                        setMenu(null);
                      }
                    }}
                  >
                    应用
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {/* ⋯ 更多浏览器操作 */}
        <div className="relative">
          <button className={menuBtn} onClick={() => setMenu(menu === "more" ? null : "more")} title="更多浏览器操作">
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menu === "more" && (
            <div className="absolute right-0 top-full z-50 mt-1 w-[180px] rounded-xl border border-line bg-elevated p-1 shadow-lv3">
              <button
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-text transition-colors hover:bg-hover"
                onClick={() => {
                  setMenu(null);
                  if (addr) desktop.browserOpenExternal(addr);
                }}
              >
                <ExternalLink className="h-3.5 w-3.5 text-sub" />
                <span>在默认浏览器中打开</span>
              </button>
              <button
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-text transition-colors hover:bg-hover"
                onClick={() => {
                  setMenu(null);
                  act((el) => el.openDevTools({ mode: "detach" }));
                }}
              >
                <Braces className="h-3.5 w-3.5 text-sub" />
                <span>调试工具（DevTools）</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── 内容区：自由尺寸时滚动的是外层画布，不是网页；webview 仍常驻，避免 guest 被销毁。 ── */}
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface" data-browser-canvas={freeSize ? "free" : "fit"}>
        <div className="relative min-h-full min-w-full" style={canvasStyle}>
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <Globe className="h-8 w-8 text-sub" />
            <div className="text-[13px] font-medium text-text">浏览器</div>
            <div className="text-xs text-caption">点击「+」或让 Agent 打开网页</div>
          </div>
        )}
        {tabs.map((t) => (
          <div key={t.id} className={`absolute inset-0 ${t.active ? "" : "pointer-events-none opacity-0"}`}>
            <webview
              ref={(el) => attachWebview(el as InfuWebviewElement | null, t.id)}
              className="absolute inset-0 h-full w-full"
              style={t.active ? freeCss : undefined}
            />
            {t.active && t.error && <div className="absolute inset-x-4 top-4 z-20 flex items-center gap-2 rounded-xl border border-danger/30 bg-elevated/95 px-3 py-2 text-xs text-danger shadow-lv2"><span className="min-w-0 flex-1 truncate">{t.error}</span><button className="rounded-lg bg-danger-soft px-2 py-1 text-[11px] text-danger hover:bg-danger/15" onClick={() => { setTabs((ts) => ts.map((x) => x.id === t.id ? { ...x, error: undefined } : x)); activeEl?.reload(); }}>重试</button></div>}
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}

/** 起始页（data: URL 美化提示——与主进程 START_URL 一致；webview 元素渲染） */
const START_HTML = `<html><body style="background:#151517;margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif"><div style="text-align:center"><svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="#56575C" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2c2.5 2.6 3.9 6.2 3.9 10S14.5 19.4 12 22c-2.5-2.6-3.9-6.2-3.9-10S9.5 4.6 12 2z"/></svg><div style="font-size:16px;color:#F9FAFB;font-weight:600;margin-top:16px">浏览器</div><div style="font-size:13px;color:#8E8E93;margin-top:8px">粘贴或输入 URL 以打开网页。</div></div></body></html>`;
const START_URL = `data:text/html;charset=utf-8,${encodeURIComponent(START_HTML)}`;

/** 地址栏规范化（v3.1 审计修复：拒绝 file:/// 等非 Web scheme——嵌入式 webview 带
 *  sandbox=no，file:// 可直读磁盘任意文件 → 非法输入返回空串，调用方不加载。
 *  v3.6：导航判定统一在主进程 sanitizeBrowserUrl（含 loopback + InFu 服务端口拦截），
 *  本函数只做输入预规范化（补 https://、去非 Web scheme），不再承担安全判定 */
function normalizeUrl(raw: string): string {
  const u = raw.trim();
  if (/^https?:/i.test(u)) return u;
  if (u === "about:blank") return u;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(u)) return `https://${u}`;
  return "";
}
