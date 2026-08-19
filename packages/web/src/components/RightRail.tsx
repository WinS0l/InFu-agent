import { useEffect, useRef, useState } from "react";
import { useClickOutside } from "./useClickOutside";
import { Bot, FileSearch, Globe, Monitor, X, Loader2, PanelRightClose, Plus, PanelsTopLeft } from "lucide-react";
import { useStore, type RightTab } from "../store";
import ReviewPane from "./ReviewPane";
import SubagentThreadView from "./SubagentThreadView";
import BrowserPanel from "./BrowserPanel";
import ComputerUsePane from "./ComputerUsePane";

/**
 * v2.9 右侧栏（浏览器式）：顶部 tab 条（活动高亮 + 状态徽标 + 关闭 ×）+ 内容区。
 * 无 Tab 时显示初始面板（「打开 Tab」标题 + 居中按钮组：审查/浏览器/子 Agent/computer-use，均已激活）。
 */

/** tab 上的子 Agent 状态徽标（运行中 spinner / 完成 / 异常） */
function TabStatusBadge({ tab }: { tab: RightTab }) {
  const thread = useStore((s) => (tab.subagentId ? s.subagentThreads[tab.subagentId] : undefined));
  if (!thread) return null;
  if (thread.status === "running") return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-ongoing" />;
  if (thread.status === "done") return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />;
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />;
}

/** 子 Agent 列表（初始面板「子 Agent」按钮打开；运行中优先，点击打开详情 tab） */
function SubagentsList() {
  const threads = useStore((s) => s.subagentThreads);
  const openRightTab = useStore((s) => s.openRightTab);
  const list = Object.values(threads).sort((a, b) => {
    const rank = (t: typeof a) => (t.status === "running" ? 0 : t.status === "done" ? 1 : 2);
    return rank(a) - rank(b);
  });
  if (!list.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Bot className="h-8 w-8 text-sub" />
        <div className="text-[13px] text-sub">暂无子 Agent</div>
        <div className="text-xs text-caption">Agent 调用 delegate_task 委派子任务后，这里会实时显示其处理过程</div>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3">
      {list.map((t) => (
        <button
          key={t.id}
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
          onClick={() => openRightTab({ id: `subagent:${t.id}`, kind: "subagent", label: t.name, subagentId: t.id })}
        >
          <Bot className="h-4 w-4 shrink-0 text-info" strokeWidth={2} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-text">{t.name}</span>
            <span className="block truncate text-xs text-caption">{t.prompt}</span>
          </span>
          {t.status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ongoing" />
          ) : t.status === "done" ? (
            <span className="shrink-0 text-[11px] text-success">{t.steps} 步</span>
          ) : (
            <span className="shrink-0 text-[11px] text-danger">异常</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** 空态初始面板（无 tab 时）：「打开 tab」大标题（≈ 欢迎页） + 竖排按钮组
 *  （与左侧栏「新建会话」同宽、高度略高 44px；四个不凑在一起）
 *  v3.2：主按钮（审查）独立区 + 分隔线 + 三个次按钮（更清晰的层级引导） */
function RightRailEmpty() {
  const openRightTab = useStore((s) => s.openRightTab);
  const btn =
    "group flex min-h-[72px] w-full cursor-pointer items-center gap-3 rounded-xl border border-line bg-elevated px-3.5 text-left transition-all duration-150 hover:-translate-y-px hover:border-info/40 hover:bg-hover active:translate-y-0";
  return (
    <div className="flex h-full flex-col items-center justify-center px-5">
      <div className="mb-5 w-full max-w-[272px]">
        <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-info-soft text-info"><PanelsTopLeft className="h-4 w-4" /></div>
        <div className="text-[18px] font-semibold tracking-tight text-text">工作区</div>
        <div className="mt-1 text-[13px] leading-5 text-sub">在这里查看改动、浏览页面或跟踪并行任务。</div>
      </div>
      <div className="w-full max-w-[272px] space-y-2">
        <button
          className={`${btn} border-info/35 bg-info-soft/50 text-text hover:border-info/60`}
          onClick={() => openRightTab({ id: "review", kind: "review", label: "审查" })}
          title="查看代码改动（Diff）/ 文件改动记录 / 测试结果"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info text-white shadow-lv1"><FileSearch className="h-4 w-4" /></span>
          <span><span className="block text-[13px] font-semibold">审查改动</span><span className="mt-0.5 block text-xs text-sub">Diff、文件与测试结果</span></span>
        </button>
        <button
          className={btn}
          onClick={() => openRightTab({ id: "browser", kind: "browser", label: "浏览器" })}
          title="浏览器面板（桌面版提供）"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hover text-info group-hover:bg-info-soft"><Globe className="h-4 w-4" /></span>
          <span><span className="block text-[13px] font-semibold text-text">浏览器</span><span className="mt-0.5 block text-xs text-sub">让 Agent 与页面实时协作</span></span>
        </button>
        <button
          className={btn}
          onClick={() => openRightTab({ id: "subagents", kind: "subagents", label: "子 Agent" })}
          title="查看子 Agent 列表与处理过程"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hover text-info group-hover:bg-info-soft"><Bot className="h-4 w-4" /></span>
          <span><span className="block text-[13px] font-semibold text-text">子 Agent</span><span className="mt-0.5 block text-xs text-sub">查看委派任务与执行过程</span></span>
        </button>
        <button
          className={btn}
          onClick={() => openRightTab({ id: "computeruse", kind: "computeruse", label: "computer-use" })}
          title="桌面操作（截图 → 视觉理解 → 点击/输入；仅桌面版）"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hover text-info group-hover:bg-info-soft"><Monitor className="h-4 w-4" /></span>
          <span><span className="block text-[13px] font-semibold text-text">computer-use</span><span className="mt-0.5 block text-xs text-sub">截图、输入与桌面操作记录</span></span>
        </button>
      </div>
    </div>
  );
}

/** 右侧栏主体（tab 条 + 内容区；由 App.tsx aside 挂载） */
export default function RightRail({ onCollapse }: { onCollapse: () => void }) {
  const { rightTabs, activeRightTab, setActiveRightTab, closeRightTab } = useStore();
  const [newTabOpen, setNewTabOpen] = useState(false);
  // v3.0 批 9.5：➕ 在 overflow 滚动容器内 → 菜单 absolute 会被裁剪（overflow-y 强制 auto），
  // 改用 fixed 视口定位（按钮坐标记录；打开后点按钮/菜单项关闭）
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // v3.0 批 12：新建 tab 菜单点击空白处自动收起
  const newTabRef = useClickOutside(() => setNewTabOpen(false));
  const plusRef = useRef<HTMLButtonElement>(null);
  // v3.0 批 3：菜单打开 → 通知浏览器面板让位视图（WebContentsView 原生层会盖住 DOM 菜单）
  useEffect(() => {
    useStore.getState().setBrowserMenuOpen(newTabOpen);
  }, [newTabOpen]);
  const openTab = useStore((s) => s.openRightTab);
  const thread = useStore((s) => {
    const t = rightTabs.find((x) => x.id === activeRightTab);
    return t?.subagentId ? s.subagentThreads[t.subagentId] : undefined;
  });
  const active = rightTabs.find((t) => t.id === activeRightTab);

  /** v2.9：新建 tab 上拉菜单项（与初始面板 4 按钮一致；样式对齐思考模式/模型选择下拉） */
  const newTabItems = [
    { id: "review", kind: "review" as const, label: "审查", icon: <FileSearch className="h-4 w-4" /> },
    { id: "browser", kind: "browser" as const, label: "浏览器", icon: <Globe className="h-4 w-4" /> },
    { id: "subagents", kind: "subagents" as const, label: "子 Agent", icon: <Bot className="h-4 w-4" /> },
    { id: "computeruse", kind: "computeruse" as const, label: "computer-use", icon: <Monitor className="h-4 w-4" /> },
  ];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 顶部 tab 条（浏览器式：活动高亮 + 状态徽标 + 关闭 ×；v2.9 无下边框与内容区浑然一体。
          v3.0 批 9.5 拍板：折叠按钮在窗口最顶部（与原生三按钮同一高度，self-start 顶对齐）；
          v3.3 补 8：整行补回 -webkit-app-region: drag（批 9 定稿三栏顶部都是拖拽区，
          但右栏 tab 条一直缺失——窗口最上方点右栏拖不动根因；可交互元素 no-drag）
          v3.3 补 3（用户拍板）：恢复右上角 pr-[140px] 让位——标签栏最大长度止于 Electron
          原生三按钮（titleBarOverlay 悬浮右上角）左缘，不重叠；多 tab 时在让位边界内
          滚动堆叠；➕ 改为超大加号、描述「新建 tab」
          v3.2：高度 60px → 3.25rem —— 与聊天 header / 侧栏 Logo 行统一（原生融合） */}
      <div
        className="relative flex h-[3.25rem] shrink-0 items-end gap-1 border-b border-line/80 bg-sidebar px-2 pb-1.5 pr-[140px]"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {/* 折叠按钮（最左 + 窗口最顶部：self-end 顶对齐 = 与原生三按钮同一高度；no-drag 可点） */}
        <button
          className="mb-0.5 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center self-end rounded-lg text-sub transition-colors hover:bg-hover hover:text-text"
          onClick={onCollapse}
          title="折叠右侧栏"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <PanelRightClose className="h-5 w-5" />
        </button>
        <span className="mb-2 hidden shrink-0 text-[11px] font-medium tracking-wide text-caption min-[700px]:inline">工作区</span>
        {/* tab 滚动区（z-0：任何滚动内容都被裁剪在本容器内；到达右侧让位边界即滚动堆叠。
            v3.3 补 7：滚轮水平滑动——Windows 普通滚轮默认只滚垂直，tab 条横向溢出时
            滚轮事件转水平滚动（scrollLeft += deltaY），滑动机制真实可感）
            no-drag：tab 项/关闭按钮可点（区域空白处由父容器 drag 接管） */}
        <div
          className="no-scrollbar relative z-0 flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pr-1"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onWheel={(e) => {
            const el = e.currentTarget;
            if (el.scrollWidth > el.clientWidth) {
              el.scrollLeft += e.deltaY;
              e.preventDefault();
            }
          }}
        >
          {rightTabs.map((t) => (
            <div
              key={t.id}
              className={`group relative flex h-8 min-w-0 max-w-[156px] cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors ${
                t.id === activeRightTab
                  ? "bg-elevated text-text shadow-lv1"
                  : "text-sub hover:bg-hover/70 hover:text-text"
              }`}
              onClick={() => setActiveRightTab(t.id)}
              title={t.label}
            >
              {/* v3.2：活动 tab 顶部 2px 信息蓝指示条（InFu 特色——ZCode/浏览器 tab 同款语义） */}
              {t.id === activeRightTab && (
                <span className="absolute left-2.5 right-2.5 top-0 h-[2px] rounded-full bg-info" />
              )}
              <TabStatusBadge tab={t} />
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
              <button
                className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-caption opacity-0 transition-opacity hover:bg-hover hover:text-text group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  closeRightTab(t.id);
                  // v3.0 批 8：用户显式关闭浏览器 tab = 唯一销毁入口（webview 元素
                  // 移除即销毁 guest；会话切换/rightTabs 清空绝不销毁——浏览器常驻）
                  if (t.id === "browser") window.infuDesktop?.browserCloseAll();
                }}
                title="关闭 tab"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        {/* 新建 tab（➕ 超大加号）：紧贴让位边界（原生三按钮左侧，绝不重叠）；bottom 对齐；
            点击 = 上拉菜单 fixed 视口定位；no-drag（button 上直接设——span 是 inline 元素
            app-region 不生效） */}
        <span className="relative mb-0.5 shrink-0">
          <button
            ref={plusRef}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-line bg-elevated text-sub transition-colors hover:border-info/40 hover:bg-hover hover:text-info"
            onClick={() => {
              if (newTabOpen) {
                setNewTabOpen(false);
              } else {
                const r = plusRef.current?.getBoundingClientRect();
                if (r) setMenuPos({ x: r.right, y: r.bottom + 4 });
                setNewTabOpen(true);
              }
            }}
            title="新建 tab"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <Plus className="h-5 w-5" />
          </button>
        </span>
      </div>

      {/* 新建 tab 菜单（fixed 视口定位——➕ 在 overflow 滚动容器内，absolute 会被裁剪） */}
      {newTabOpen && menuPos && (
        <div
          ref={newTabRef}
          className="fixed z-50 min-w-[150px] rounded-xl border border-line bg-elevated p-1 shadow-lv3"
          style={{ top: menuPos.y, right: window.innerWidth - menuPos.x }}
        >
          {newTabItems.map((it) => (
            <button
              key={it.id}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text transition-colors hover:bg-hover"
              onClick={() => { setNewTabOpen(false); openTab({ id: it.id, kind: it.kind, label: it.label }); }}
            >
              {it.icon}
              <span className="text-sub">{it.label}</span>
            </button>
          ))}

        </div>
      )}

      {/* 内容区：浏览器面板常驻（批 8——webview 元素永不卸载，会话切换/清 rightTabs
          只切显隐不销毁；其余按活动 tab 渲染；无 tab = 初始面板） */}
      <div className="relative min-h-0 flex-1">
        <div className={`absolute inset-0 z-10 ${active?.kind === "browser" ? "" : "pointer-events-none hidden"}`}>
          <BrowserPanel />
        </div>
        {!active ? (
          <RightRailEmpty />
        ) : active.kind === "browser" ? (
          <></>
        ) : active.kind === "review" ? (
          <ReviewPane />
        ) : active.kind === "subagents" ? (
          <SubagentsList />
        ) : active.kind === "computeruse" ? (
          <ComputerUsePane />
        ) : active.subagentId && thread ? (
          <SubagentThreadView thread={thread} />
        ) : (
          <RightRailEmpty />
        )}
      </div>
    </div>
  );
}
