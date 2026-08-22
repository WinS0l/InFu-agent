import { useEffect, useRef, useState } from "react";
import { useClickOutside } from "./useClickOutside";
import { Bot, FileSearch, Globe, Monitor, X, Loader2, Plus, ListTree, Network, CheckCircle2, CircleAlert, CircleDotDashed } from "lucide-react";
import { useStore, type RightTab } from "../store";
import ReviewPane from "./ReviewPane";
import SubagentThreadView from "./SubagentThreadView";
import BrowserPanel from "./BrowserPanel";
import ComputerUsePane from "./ComputerUsePane";
import SessionTracePane from "./SessionTracePane";
import AttachmentPreviewPane from "./AttachmentPreviewPane";
import { fetchTaskGraph } from "../api";
import type { TaskDependency } from "@infu/shared";

function TaskGraphPane() {
  const sessionId = useStore((s) => s.activeSessionId);
  const [nodes, setNodes] = useState<TaskDependency[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!sessionId) { setNodes([]); return; }
    void fetchTaskGraph(sessionId).then((value) => { if (!cancelled) setNodes(value); }).catch(() => { if (!cancelled) setNodes([]); });
    return () => { cancelled = true; };
  }, [sessionId]);
  if (!nodes.length) return <div className="flex h-full flex-col items-center justify-center px-6 text-center"><Network className="h-8 w-8 text-sub" /><div className="mt-2 text-[13px] text-sub">暂无任务依赖</div><div className="mt-1 text-xs text-caption">任务开始执行后，这里会显示工具与后台任务的先后关系。</div></div>;
  return <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4"><div className="mb-3"><div className="text-[14px] font-semibold text-text">任务依赖图</div><div className="mt-1 text-xs text-sub">按执行审计链展示任务顺序，点击节点查看详情。</div></div><div className="relative space-y-2 pl-3">{nodes.map((node, index) => <div key={node.id} className="relative"><div className="absolute -left-3 top-0 h-full w-px bg-line/80" />{index < nodes.length - 1 && <div className="absolute -left-3 top-5 h-[calc(100%+8px)] w-px bg-info/30" />}<button onClick={() => setSelected(selected === node.id ? null : node.id)} className={`relative flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${selected === node.id ? "border-info/45 bg-info-soft/45" : "border-line/70 bg-hover/35 hover:bg-hover"}`}><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-elevated text-sub">{node.status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : node.status === "failed" ? <CircleAlert className="h-3.5 w-3.5 text-danger" /> : node.status === "running" ? <CircleDotDashed className="h-3.5 w-3.5 animate-spin text-info" /> : <Network className="h-3.5 w-3.5" />}</span><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium text-text">{node.label}</span><span className="block text-[10px] text-caption">{node.status} {node.dependsOn.length ? `· 依赖 ${node.dependsOn.length} 项` : "· 起始节点"}</span></span></button>{selected === node.id && <div className="ml-8 mt-1 rounded-lg bg-hover/40 px-2.5 py-2 text-[11px] text-sub">节点 ID：<span className="font-mono text-caption">{node.id}</span></div>}</div>)}</div></div>;
}

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
  const btn = "group flex min-h-[74px] w-full cursor-pointer items-center gap-3 rounded-2xl border border-line/60 bg-hover/35 px-4 py-3 text-left transition-colors hover:border-info/30 hover:bg-hover";
  const items = [
    { id: "review", label: "审查", sub: "查看改动与验证", icon: <FileSearch className="h-4 w-4" /> },
    { id: "browser", label: "浏览器", sub: "页面与 Agent 协作", icon: <Globe className="h-4 w-4" /> },
    { id: "subagents", label: "子 Agent", sub: "委派任务与过程", icon: <Bot className="h-4 w-4" /> },
    { id: "computeruse", label: "桌面操作", sub: "截图与输入记录", icon: <Monitor className="h-4 w-4" /> },
    { id: "trace", label: "会话追踪", sub: "事件与用量账本", icon: <ListTree className="h-4 w-4" /> },
    { id: "taskgraph", label: "任务图", sub: "依赖与执行顺序", icon: <Network className="h-4 w-4" /> },
  ] as const;
  return (
    <div className="infu-right-empty flex h-full flex-col items-center justify-center px-5 py-8">
      <div className="mb-6 text-center"><div className="text-[20px] font-semibold tracking-tight text-text">打开标签页</div><div className="mt-1.5 text-[13px] text-sub">选择要在侧边面板中打开的标签。</div></div>
      <div className="grid w-full max-w-[420px] grid-cols-1 gap-2.5 sm:grid-cols-2">
        {items.map((item) => <button key={item.id} className={btn} onClick={() => openRightTab({ id: item.id, kind: item.id as RightTab["kind"], label: item.label })} title={item.sub}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sub">{item.icon}</span><span className="min-w-0"><span className="block text-[14px] font-medium text-text">{item.label}</span><span className="mt-0.5 block truncate text-[11px] text-caption">{item.sub}</span></span>
        </button>)}
      </div>
    </div>
  );
}

/** 右侧栏主体（tab 条 + 内容区；由 App.tsx aside 挂载） */
export default function RightRail() {
  const rightTabs = useStore((s) => s.rightTabs);
  const activeRightTab = useStore((s) => s.activeRightTab);
  const setActiveRightTab = useStore((s) => s.setActiveRightTab);
  const closeRightTab = useStore((s) => s.closeRightTab);
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
    { id: "computeruse", kind: "computeruse" as const, label: "桌面操作", icon: <Monitor className="h-4 w-4" /> },
    { id: "trace", kind: "trace" as const, label: "会话追踪", icon: <ListTree className="h-4 w-4" /> },
    { id: "taskgraph", kind: "taskgraph" as const, label: "任务图", icon: <Network className="h-4 w-4" /> },
  ];

  return (
    <div className="infu-right-rail flex h-full min-h-0 min-w-0 flex-col">
      {/* 打开工作 Tab 后才显示浏览器式标签条；空态保持一个安静的顶部工作区入口。 */}
      {rightTabs.length > 0 && <div
        className="relative flex h-9 shrink-0 items-end gap-1 border-b border-line/80 bg-ink px-2 pb-0.5"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {/* tab 滚动区（z-0：任何滚动内容都被裁剪在本容器内；到达右侧让位边界即滚动堆叠。
            v3.3 补 7：滚轮水平滑动——Windows 普通滚轮默认只滚垂直，tab 条横向溢出时
            滚轮事件转水平滚动（scrollLeft += deltaY），滑动机制真实可感）
            no-drag：tab 项/关闭按钮可点（区域空白处由父容器 drag 接管） */}
        <div
          className="no-scrollbar relative z-0 flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pr-1 touch-pan-x"
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
              className={`group relative flex h-8 min-w-[96px] max-w-[156px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors ${
                t.id === activeRightTab
                  ? "bg-elevated text-text shadow-lv1"
                  : "text-sub hover:bg-hover/70 hover:text-text"
              }`}
              onClick={() => setActiveRightTab(t.id)}
              title={t.label}
            >
              {/* v3.2：活动 tab 顶部 2px 信息蓝指示条。 */}
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
          {/* Edge 式新建标签：作为最后一个 tab 随标签流动，空间不足时自然横向滚动。 */}
          <span className="relative mb-0.5 shrink-0">
            <button
              ref={plusRef}
              className="flex h-7 w-8 cursor-pointer items-center justify-center rounded-t-md border border-b-0 border-transparent text-sub transition-colors hover:border-line hover:bg-elevated hover:text-text"
              onClick={() => {
                if (newTabOpen) setNewTabOpen(false);
                else {
                  const r = plusRef.current?.getBoundingClientRect();
                  if (r) setMenuPos({ x: r.right, y: r.bottom + 4 });
                  setNewTabOpen(true);
                }
              }}
              title="新建标签页"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <Plus className="h-4 w-4" strokeWidth={2.25} />
            </button>
          </span>
        </div>
      </div>}

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
          <BrowserPanel active={active?.kind === "browser"} />
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
        ) : active.kind === "trace" ? (
          <SessionTracePane />
        ) : active.kind === "taskgraph" ? (
          <TaskGraphPane />
        ) : active.kind === "attachment" ? (
          <AttachmentPreviewPane />
        ) : active.subagentId && thread ? (
          <SubagentThreadView thread={thread} />
        ) : (
          <RightRailEmpty />
        )}
      </div>
    </div>
  );
}
