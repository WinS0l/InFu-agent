import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import { FolderOpen, PanelsTopLeft, PanelRightClose } from "lucide-react";
import { useStore } from "./store";
import { fetchModels, fetchSessions, fetchSessionEvents, maybeMigrateV1, fetchConfig, fetchProjects } from "./api";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import ApprovalModal from "./components/ApprovalModal";
import AskModal from "./components/AskModal";
import { TerminalToggleButton } from "./components/TerminalPanel";
import CommandPalette from "./components/CommandPalette";
import NotificationCenter from "./components/NotificationCenter";
// v5.0（A5）：重组件懒加载（settings 弹窗 = SettingsPanes 1961 行 + ModelPane + 弹窗本身，
// 首包约 500KB；CodeView 仅代码模式渲染）——首屏 bundle 显著减负
const CodeView = lazy(() => import("./components/CodeView"));
const SettingsModal = lazy(() => import("./components/SettingsModal"));
const RightRail = lazy(() => import("./components/RightRail"));
const SuspenseFallback = () => <div className="flex h-full items-center justify-center text-xs text-caption">加载中…</div>;

/**
 * v3 UI 打磨：三栏骨架——
 * 侧栏 280px（拖拽 264–420 / 折叠 rail 56px / <1024px 自动折叠）
 * 中间对话 min 640 / 右详情 360px（拖拽 300–520 / 可关闭到 0）
 * 顶部区域（对话/代码推拉 + 会话名）仅覆盖中间+右详情；终端在聊天列内（ChatPanel 渲染）
 */
export default function App() {
  const theme = useStore((s) => s.theme);
  const fontSize = useStore((s) => s.fontSize);
  const streamCursor = useStore((s) => s.streamCursor);
  const setAppearance = useStore((s) => s.setAppearance);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const detailsWidth = useStore((s) => s.detailsWidth);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const setDetailsOpen = useStore((s) => s.setDetailsOpen);
  const setDetailsWidth = useStore((s) => s.setDetailsWidth);
  const focusSearch = useStore((s) => s.focusSearch);
  const settingsTab = useStore((s) => s.settingsTab);
  const setSettingsTab = useStore((s) => s.setSettingsTab);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const loaded = useRef(false);
  const dragRef = useRef<{ side: "sidebar" | "details"; startX: number; startW: number } | null>(null);

  // v2.6 全局快捷键：Ctrl+N 新建会话 / Ctrl+K 聚焦搜索（输入框聚焦时不劫持）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (!typing) useStore.getState().newSession();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!typing) setCommandOpen(true);
        else focusSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusSearch]);

  // v2.4 外观即时应用 + v3 主题（html data 属性 → index.css 变量翻转）
  // v3.0 批 12：theme=system → 跟随操作系统（matchMedia 解析；系统切换时实时跟随）
  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize;
    document.documentElement.dataset.streamCursor = streamCursor ? "on" : "off";
    const apply = () => {
      const resolved = theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : theme;
      document.documentElement.dataset.theme = resolved;
      window.infuDesktop?.setTheme(resolved);
    };
    apply();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [fontSize, streamCursor, theme]);

  // v3：极窄窗口（<768px 平板以下）初始自动折叠侧栏——仅在挂载时判断一次，
  // 不监听后续窗口变化（避免拖拽窗口大小时侧栏突然消失）；桌面窗口保持展开
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarCollapsed(true);
  }, [setSidebarCollapsed]);



  // ── v3 三栏拖拽（8px 隐形热区；指针捕获 + 拖拽期间关闭轨道过渡）──
  const onDragStart = (side: "sidebar" | "details") => (e: React.PointerEvent<HTMLDivElement>) => {
    if (side === "sidebar" && sidebarCollapsed) return;
    dragRef.current = {
      side,
      startX: e.clientX,
      startW: side === "sidebar" ? sidebarWidth : detailsWidth,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (d.side === "sidebar") setSidebarWidth(d.startW + dx);
    else setDetailsWidth(d.startW - dx); // 右栏：向左拖 = 变宽
  };
  const onDragEnd = () => {
    dragRef.current = null;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const loadModels = useCallback(async () => {
    try {
      await fetchModels();
    } catch {
      /* 模型加载失败静默（5 秒重试；输入区模型选择器与设置页可查） */
    }
  }, []);

  useEffect(() => {
    // v5.0（C3）：托盘「最近会话/运行中任务」→ 打开对应会话（桌面端）
    if (!window.infuDesktop?.onOpenSession) return;
    return window.infuDesktop.onOpenSession((id) => {
      if (!id) return;
      fetchSessionEvents(id)
        .then(({ events }) => {
          const st = useStore.getState();
          st.loadSession(events, id, true);
          st.setActiveSessionId(id);
          useStore.setState({ messages: useStore.getState().sessionCache[id] ?? [] });
          fetchSessions().catch(() => {});
        })
        .catch(() => {
          useStore.getState().addError("会话加载失败（托盘打开）");
        });
    });
  }, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    loadModels();
    // v2.4 设置：应用外观（字号/流式光标/主题）与默认根目录（仅当输入框仍是默认值时）
    fetchConfig()
      .then((cfg) => {
        const st = useStore.getState();
        setAppearance({
          fontSize: cfg.appearance.fontSize ?? "sm",
          streamCursor: cfg.appearance.streamCursor ?? true,
          theme: (cfg.appearance.theme as "light" | "dark" | "system") ?? "dark",
        });
        if (cfg.general.defaultRoot && !st.root) {
          st.setRoot(cfg.general.defaultRoot);
        }
        // v2.14 批 18：默认模型真实生效——Web 会话初始模型取 config.defaultModelId
        // （setModels 会校验存在性：配置的模型不存在时回退列表第一个）
        if (cfg.defaultModelId) {
          st.setModelId(cfg.defaultModelId);
        }
        // v3.5 常规设置：对话流显示开关（config.general.showThinking/showTodos）
        st.setUiFlags({
          showThinking: cfg.general.showThinking !== false,
          showTodos: cfg.general.showTodos !== false,
        });
      })
      .catch(() => {});
    // v2.1 会话：v1 localStorage 数据迁移 + 加载会话列表 + 恢复上次会话
    (async () => {
      try {
        await maybeMigrateV1();
        await fetchSessions();
        const st = useStore.getState();
        if (st.activeSessionId) {
          // 恢复上次会话（服务端已删除时回到空态）
          try {
            const { events, session } = await fetchSessionEvents(st.activeSessionId);
            st.loadSession(events);
            // v2.9：恢复会话的 root（代码界面/审查依赖 st.root；刷新后不设置会变空）
            if (session?.root && !useStore.getState().root) {
              useStore.getState().setRoot(session.root);
            }
          } catch {
            st.newSession();
          }
        }
      } catch {
        /* 会话服务未就绪时静默，5 秒重试（与模型加载同一节奏） */
      }
    })();
    // Agent 服务可能尚未就绪：每 5 秒自动重试直到模型加载成功
    const timer = setInterval(() => {
      if (useStore.getState().models.length === 0) loadModels();
    }, 5000);
    return () => clearInterval(timer);
  }, [loadModels, setAppearance]);

  const sideW = sidebarCollapsed ? 56 : sidebarWidth;
  // v3：顶部区域（仅非空会话显示）——「对话/代码」推拉 + 左侧会话归属
  const hasMessages = useStore((s) => s.messages.length > 0);
  const viewMode = useStore((s) => s.viewMode);
  const effectiveViewMode = hasMessages ? viewMode : "chat";
  const setViewMode = useStore((s) => s.setViewMode);
  // v3.3 补 13：终端开关移入聊天 header 右上角（store 状态与 ChatPanel 共享）
  const terminalOpen = useStore((s) => s.terminalOpen);
  const setTerminalOpen = useStore((s) => s.setTerminalOpen);
  // v3.0 UI 审查：代码视图可用性——root 为空（自由会话未配默认工作目录）时禁用「代码」按钮
  const root = useStore((s) => s.root);
  // 欢迎态没有工作区语义：即使用户在上个会话打开过右栏，也不能让空白欢迎页
  // 继承一块无法收起的工作区。detailsOpen 仍作为工作会话的用户偏好保留。
  const detW = !hasMessages || effectiveViewMode === "code" || !detailsOpen ? 0 : detailsWidth;
  // v3：顶部栏左侧——项目会话显示项目名，自由会话显示会话名
  const [projects, setProjects] = useState<Array<{ id: string; name: string; root: string }>>([]);
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  useEffect(() => {
    fetchProjects().then(setProjects).catch(() => {});
  }, []);
  // v3.0 批 12 修复：Agent 请求开浏览器时右侧栏可能折叠（RightRail 未挂载 →
  // BrowserPanel 的 onOpenRequest 无人响应）→ 顶层订阅 open-request 展开右侧栏
  useEffect(() => {
    const d = window.infuDesktop;
    if (!d) return;
    return d.onOpenRequest((url) => {
      setDetailsOpen(true);
      useStore.getState().openRightTab({ id: "browser", kind: "browser", label: "浏览器" });
      // v3.3 补 16：记录待建 tab——BrowserPanel 可能此刻才挂载（订阅已错过 open-request
      // 事件），由 store 状态驱动它消费建 webview（修复「Agent 打开浏览器无内容」）
      useStore.getState().setPendingBrowserOpen(url ?? "");
    });
  }, [setDetailsOpen]);

  // v3.0 批 12：孤儿 root 清理——persist 的 root 若不属于任何已注册项目（项目已删除），
  // 且无会话引用它，启动时自动清空（否则删除项目后新建会话仍显示旧项目名）
  useEffect(() => {
    const st = useStore.getState();
    if (!st.root) return;
    // v4.0（L5）：Windows 反斜杠尾分隔符同样归一（与下方 normP 同款；原只去 `/`）
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    fetchProjects().then((ps) => {
      const registered = ps.some((p) => norm(p.root) === norm(st.root));
      const inSession = st.sessions.some((s) => norm(s.root) === norm(st.root));
      if (!registered && !inSession) useStore.getState().setRoot("");
    }).catch(() => {});
  }, []);
  const normP = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  // v3：顶部栏会话名/项目名各最多 12 字符，超长省略号（中英文统一按字符数）
  const clip = (s: string, n = 12) => (s.length > n ? s.slice(0, n) + "…" : s);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeProject = projects.find((p) => normP(p.root) === normP(activeSession?.root ?? ""));

  return (
    <div className="infu-shell relative flex h-full flex-col overflow-hidden bg-ink">
      {/* v3.0 批 9.5：无独立标题栏——三栏顶部顶到最顶；窗口按钮 = 原生 titleBarOverlay
          （右上角悬浮），拖拽区分散到各栏顶部（Sidebar Logo 行 / Chat header / RightRail tab 条） */}
      {/* v2.14 批 5：底层装饰光晕（磨砂玻璃透出物——侧栏 backdrop-blur 后可见，玻璃质感来源） */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(620px 320px at 8% -2%, var(--glow-a) 0%, transparent 62%), radial-gradient(520px 300px at 96% 104%, var(--glow-b) 0%, transparent 60%)",
        }}
      />
      {/* 三栏主体（v3： Grid 骨架；顶部区域仅覆盖中间+右详情，侧栏与欢迎界面不受影响） */}
      <div
        className="relative grid min-h-0 flex-1 overflow-hidden"
        style={{
          gridTemplateColumns: `${sideW}px minmax(0, 1fr) ${effectiveViewMode === "code" ? 0 : detW}px`,
          // 关键：行高约束（防止 grid 隐式行被内容撑高）；有消息时首行为顶部区域
          gridTemplateRows: hasMessages ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)",
          transition: dragging ? "none" : "grid-template-columns 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <Sidebar
          className="row-span-2"
          onOpenSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true); }}
        />

        {/* 中间列与工作区共用一条紧凑顶部基线；正文不再像浮在窗口中的独立白纸。 */}
      <div
        className="relative min-h-0 min-w-0"
        style={{ gridColumn: 2, gridRow: "1 / span 2" }}
      >
          <div className="flex h-full flex-col overflow-hidden">
            {/* 顶部工作台栏：会话上下文、模式切换与右侧动作在同一视觉基线。 */}
            {hasMessages && (
              <header
                className="infu-topbar relative flex h-10 shrink-0 items-center bg-sidebar px-4"
                style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
              >
                <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-text" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                  <span className="shrink-0" title={activeSession?.title ?? ""}>
                    {clip(activeSession?.title ?? "")}
                  </span>
                  {activeProject && (
                    <>
                      <span className="shrink-0 text-sub">-</span>
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sub" />
                      <span className="shrink-0" title={activeProject.name}>
                        {clip(activeProject.name)}
                      </span>
                    </>
                  )}
                </span>
                <div
                  className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-line p-0.5"
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                >
                  <button
                    className={`h-7 cursor-pointer rounded-md px-3 text-[13px] font-medium transition-colors ${
                      viewMode === "chat" ? "bg-hover text-text" : "text-sub hover:text-text"
                    }`}
                    onClick={() => setViewMode("chat")}
                  >
                    对话
                  </button>
                  <button
                    className={`h-7 cursor-pointer rounded-md px-3 text-[13px] font-medium transition-colors ${
                      viewMode === "code" ? "bg-hover text-text" : "text-sub hover:text-text"
                    } ${
                      !root
                        ? "cursor-not-allowed opacity-40 disabled:hover:text-sub"
                        : ""
                    }`}
                    onClick={() => setViewMode("code")}
                    disabled={!root}
                    title={
                      root
                        ? "查看当前会话工作目录的代码"
                        : "该会话未关联工作目录，代码视图不可用（请选择项目或在设置中配置默认工作目录）"
                    }
                  >
                    代码
                  </button>
                </div>
              </header>
            )}
            {/* 顶栏无额外底线；正文卡片自身上边线是唯一分隔，贴紧顶部并只在左侧圆角悬浮。 */}
            <div className="infu-stage ml-2 min-h-0 flex-1 overflow-hidden rounded-l-[22px] border border-r-0 border-line bg-ink shadow-[-5px_10px_26px_rgba(0,0,0,0.10),0_2px_6px_rgba(0,0,0,0.04)]">
              <ChatPanel />
            </div>
          </div>
        </div>
        {effectiveViewMode === "code" && (
          <div
            className="absolute bottom-0 z-40 isolate overflow-hidden rounded-l-[22px] border border-r-0 border-line bg-base shadow-[-5px_10px_26px_rgba(0,0,0,0.10),0_2px_6px_rgba(0,0,0,0.04)]"
            style={{ left: sideW + 8, top: hasMessages ? "40px" : 0, right: 0, backgroundColor: "var(--bg-base)", opacity: 1 }}
          >
            <Suspense fallback={<SuspenseFallback />}>
              <CodeView />
            </Suspense>
          </div>
        )}
        {/* 右详情栏：窗口级顶部与聊天顶栏连续无竖线；分隔线从正文共同的 y=40 基线才开始。 */}
        {hasMessages && viewMode === "chat" && (detailsOpen ? (
          <aside className="infu-context-rail row-span-2 flex min-h-0 min-w-0 flex-col bg-ink" style={{ gridColumn: 3 }}>
            <div className="h-10 shrink-0 bg-sidebar" />
            <div className="min-h-0 flex-1 border-t border-line">
              <Suspense fallback={<SuspenseFallback />}><RightRail /></Suspense>
            </div>
          </aside>
        ) : (
          <></>
        ))}
        {/* 窗口级动作固定在原生控制区左侧：终端在前，右栏展开/收起紧随其后。 */}
        {hasMessages && viewMode === "chat" && (
          <div
            className="infu-top-actions absolute right-[140px] top-0 z-20 flex h-10 items-center gap-1 bg-sidebar pr-2"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <TerminalToggleButton open={terminalOpen} onClick={() => setTerminalOpen(!terminalOpen)} />
            <button
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-sub transition-colors hover:bg-hover hover:text-text"
              onClick={() => setDetailsOpen(!detailsOpen)}
              title={detailsOpen ? "收起右侧栏" : "展开右侧栏"}
            >
              {detailsOpen ? <PanelRightClose className="h-4.5 w-4.5" /> : <PanelsTopLeft className="h-4.5 w-4.5" />}
            </button>
          </div>
        )}
        {/* v2.5 子智能体详情（v2.9：右侧栏 tab 承载——subagent-start 自动开 tab 实时跟随） */}

        {/* 侧栏拖拽热区（8px，隐形；折叠态禁用） */}
        {!sidebarCollapsed && (
          <div
            className="absolute bottom-0 top-0 z-30 w-2 cursor-col-resize"
            style={{ left: sideW - 4 }}
            onPointerDown={onDragStart("sidebar")}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
          />
        )}
        {/* 右详情栏拖拽热区（8px 隐形；折叠态点击重开，拖拽调宽）。
            v3.0 UI 审查：代码模式完全隐藏（右栏 = 0 宽，热区会悬在代码视图右缘盖住内容）
            v3.3 补 8：可见拖柄块移除（用户拍板）——只留隐形热区，拖拽能力不变 */}
        {hasMessages && viewMode !== "code" && (
        <div
          className="group absolute bottom-0 top-0 z-30 w-2 cursor-col-resize"
          style={{ right: Math.max(0, detW - 4) }}
          onPointerDown={onDragStart("details")}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onClick={() => { if (!detailsOpen) setDetailsOpen(true); }}
          title={detailsOpen ? "拖拽调整详情栏宽度" : "点击重新打开详情栏（可拖拽调宽）"}
        />
        )}
      </div>

      <ApprovalModal />
      {/* v2.6 收尾：Agent 执行中提问（ask_user 工具） */}
      <AskModal />
      {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} onOpenSettings={() => { setSettingsTab("general"); setSettingsOpen(true); }} />}
      <NotificationCenter />
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal onClose={() => setSettingsOpen(false)} initialTab={settingsTab} />
        </Suspense>
      )}
    </div>
  );
}
