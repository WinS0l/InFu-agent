import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useStore } from "./store";
import { fetchModels, fetchSessions, fetchSessionEvents, maybeMigrateV1, fetchConfig, fetchProjects } from "./api";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import CodeView from "./components/CodeView";
import RightRail from "./components/RightRail";
import ApprovalModal from "./components/ApprovalModal";
import AskModal from "./components/AskModal";
import SettingsModal from "./components/SettingsModal";

/**
 * v3 UI 打磨：三栏骨架——
 * 侧栏 280px（拖拽 264–420 / 折叠 rail 56px / <1024px 自动折叠）
 * 中间对话 min 640 / 右详情 360px（拖拽 300–520 / 可关闭到 0）
 * 顶部区域（对话/代码推拉 + 会话名）仅覆盖中间+右详情；终端在聊天列内（ChatPanel 渲染）
 */
export default function App() {
  const {
    theme, fontSize, streamCursor, setAppearance,
    sidebarCollapsed, sidebarWidth, detailsOpen, detailsWidth,
    setSidebarCollapsed, setSidebarWidth, setDetailsOpen, setDetailsWidth,
    focusSearch, settingsTab, setSettingsTab,
  } = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
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
        focusSearch();
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
  const { viewMode, setViewMode } = useStore();
  // v3.0 UI 审查：代码视图可用性——root 为空（自由会话未配默认工作目录）时禁用「代码」按钮
  const root = useStore((s) => s.root);
  // v3：右侧栏折叠后保留 56px rail（与左侧栏 rail 对称；代码模式完全隐藏）
  const detW = viewMode === "code" ? 0 : detailsOpen ? detailsWidth : 56;
  // v3：顶部栏左侧——项目会话显示项目名，自由会话显示会话名
  const [projects, setProjects] = useState<Array<{ id: string; name: string; root: string }>>([]);
  const { sessions, activeSessionId } = useStore();
  useEffect(() => {
    fetchProjects().then(setProjects).catch(() => {});
  }, []);
  // v3.0 批 12 修复：Agent 请求开浏览器时右侧栏可能折叠（RightRail 未挂载 →
  // BrowserPanel 的 onOpenRequest 无人响应）→ 顶层订阅 open-request 展开右侧栏
  useEffect(() => {
    const d = window.infuDesktop;
    if (!d) return;
    return d.onOpenRequest(() => {
      setDetailsOpen(true);
      useStore.getState().openRightTab({ id: "browser", kind: "browser", label: "浏览器" });
    });
  }, []);

  // v3.0 批 12：孤儿 root 清理——persist 的 root 若不属于任何已注册项目（项目已删除），
  // 且无会话引用它，启动时自动清空（否则删除项目后新建会话仍显示旧项目名）
  useEffect(() => {
    const st = useStore.getState();
    if (!st.root) return;
    const norm = (p: string) => p.replace(/[\/]+$/, "").toLowerCase();
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
    <div className="relative flex h-full flex-col overflow-hidden bg-ink">
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
          gridTemplateColumns: `${sideW}px minmax(0, 1fr) ${viewMode === "code" ? 0 : detW}px`,
          // 关键：行高约束（防止 grid 隐式行被内容撑高）；有消息时首行为顶部区域
          gridTemplateRows: hasMessages ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)",
          transition: dragging ? "none" : "grid-template-columns 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <Sidebar
          className="row-span-2"
          onOpenSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true); }}
        />

        {/* 中间列（v2.14 批 5：整体 = 大圆角卡片——header 与聊天界面一体，圆角处透出侧栏/光晕）
            v2.14 批 6：顶部不留缝（pt-0）、右侧无缝贴右侧栏（pr-0，分隔线 = 卡片边框）
            v2.14 批 7：右侧直角（rounded-l-only）——与右侧栏融为一体，圆角只保留在左侧
            v3.3 补 4：右侧栏折叠时去掉卡片右边框（border-r-0）——折叠形态与聊天界面之间无分隔线 */}
        <div className="min-h-0 min-w-0 pb-2 pl-2" style={{ gridColumn: 2, gridRow: "1 / span 2" }}>
          <div className={`flex h-full flex-col overflow-hidden rounded-l-[20px] border border-line bg-ink shadow-lv2 ${detailsOpen ? "" : "border-r-0"}`}>
            {/* 顶部区域（v2.14 批 5：进卡片，与聊天界面一体；左侧会话归属 + 推拉居中）
                v3.0 批 9：整行 = 窗口拖拽区（no-drag 给可交互元素） */}
            {hasMessages && (
              <header
                className="relative flex h-[3.25rem] shrink-0 items-center border-b border-line bg-ink px-4"
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
            <div className="min-h-0 flex-1">
              <ChatPanel />
            </div>
          </div>
        </div>
        {viewMode === "code" && (
          <div
            className="absolute bottom-0 z-10 overflow-hidden"
            style={{
              left: sideW + 8,
              top: hasMessages ? "calc(3.25rem + 1px)" : 0,
              right: 0,
              // 覆盖层用不透明底（不透出下层聊天）；卡片边框保留（一体式代码视图）
              background: "var(--bg-base)",
            }}
          >
            <CodeView />
          </div>
        )}
        {/* 右详情栏（v2.9 浏览器式：顶部 tab 条 + 内容区 + 空态初始面板；折叠后保留 56px rail；
            代码模式隐藏）
            v2.14 批 6：与聊天卡片无缝贴齐（去掉 border-l——分隔线 = 卡片右边框） */}
        {viewMode === "chat" && (detailsOpen ? (
          <aside className="row-span-2 flex min-h-0 min-w-0 flex-col bg-ink" style={{ gridColumn: 3 }}>
            <RightRail onCollapse={() => setDetailsOpen(false)} />
          </aside>
        ) : (
          // 折叠 rail（56px）：展开按钮放在原生窗口按钮（titleBarOverlay 悬浮
          // 右上角，约 38px 高）正下方——顶部让位，按钮紧贴其下（v3.0 批 9.5 拍板）
          // v3.3 补：去掉分隔细线——折叠形态只有拉出按钮，别的什么都没有（用户拍板）
          <aside className="row-span-2 flex flex-col items-center gap-1 bg-ink py-3" style={{ gridColumn: 3 }}>
            {/* 顶部让位区（避开原生窗口按钮悬浮区约 38px 高；无边框无线条 = 视觉空白） */}
            <div className="h-[calc(3.25rem-11px)] shrink-0" />
            <button
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-sub transition-colors hover:bg-hover hover:text-text"
              onClick={() => setDetailsOpen(true)}
              title="展开右侧栏"
            >
              <PanelRightOpen className="h-5 w-5" />
            </button>
          </aside>
        ))}
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
        {/* 右详情栏拖拽热区 +  12×32 拖柄（关闭态常显；点击重开，拖拽调宽）。
            v3.0 UI 审查：代码模式完全隐藏（右栏 = 0 宽，热区会悬在代码视图右缘盖住内容） */}
        {viewMode !== "code" && (
        <div
          className="group absolute bottom-0 top-0 z-30 w-2 cursor-col-resize"
          style={{ right: Math.max(0, detW - 4) }}
          onPointerDown={onDragStart("details")}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onClick={() => { if (!detailsOpen) setDetailsOpen(true); }}
          title={detailsOpen ? "拖拽调整详情栏宽度" : "点击重新打开详情栏（可拖拽调宽）"}
        >
          <div
            className={`absolute left-1/2 top-1/2 h-8 w-3 -translate-x-1/2 -translate-y-1/2 rounded-[10px] border border-line bg-elevated shadow-lv2 transition-opacity ${
              detailsOpen ? "opacity-0 group-hover:opacity-100" : "opacity-70 group-hover:opacity-100"
            }`}
          />
        </div>
        )}
      </div>

      <ApprovalModal />
      {/* v2.6 收尾：Agent 执行中提问（ask_user 工具） */}
      <AskModal />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} initialTab={settingsTab} />}
    </div>
  );
}
