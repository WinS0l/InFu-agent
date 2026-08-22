import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, Search, Puzzle, FolderOpen, Folder, ChevronRight, Pin, PinOff, Archive, Pencil,
  Check, X, Trash2, MessageSquare, ChevronsDownUp, Cog, PanelLeftClose,
  MoreHorizontal, ListFilter, GitBranch,
} from "lucide-react";
import type { SessionMeta } from "@infu/shared";
import { useStore, type SettingsTab } from "../store";
import { fetchSessions, fetchSessionEvents, deleteSession, fetchProjects, updateSessionApi, removeProjectApi, fetchConfig } from "../api";
import type { ProjectInfo } from "../api";
import ArchiveModal from "./ArchiveModal";
import CreateProjectModal from "./CreateProjectModal";

/** InFu 宝石 Logo（v3：移入侧栏顶部，替换旧顶栏） */
// v3.0 批 12：侧栏 Logo 用用户提供的 infu-logo（assets/infu-logo.png）
// 批 12：深色主题下深蓝图形不明显 → 提亮 + 对比度 + 蓝色光晕（主体清晰 + 辉光）
import infuLogo from "../assets/infu-logo.png";
const LOGO = (
  <img
    src={infuLogo}
    alt="InFu"
    className="h-5 w-5 shrink-0 transition-[filter] duration-200"
    draggable={false}
    style={{
      filter:
        "brightness(1.55) contrast(1.3) saturate(1.25) drop-shadow(0 0 3px rgba(120,160,255,0.9)) drop-shadow(0 0 9px rgba(80,120,255,0.5))",
    }}
  />
);

/** 时长格式化：刚刚 / N分 / N小时 / N天 */
export function formatDuration(created: number, updated: number): string {
  const ms = Math.max(0, updated - created);
  const min = Math.floor(ms / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时`;
  return `${Math.floor(h / 24)}天`;
}

/** 时间格式化：MM-DD HH:mm */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 小图标按钮（侧栏 hover 操作，主流 规格 20px 热区） */
function IconBtn({ title, onClick, danger, children, active }: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-colors ${
        active ? "bg-hover text-info" : danger ? "text-sub/70 hover:bg-danger-soft hover:text-danger" : "text-sub/70 hover:bg-hover hover:text-info"
      }`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

/** 行内下拉菜单（主流 ellipsis menu：r12 卡片 + lv3 阴影 + 40px 项；点击外部关闭） */
export function RowMenu({ items, onClose }: {
  items: Array<{ label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute right-0 top-6 z-50 min-w-[150px] rounded-xl border border-line bg-elevated p-1 shadow-lv3"
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <button
          key={i}
          className={`flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors ${
            it.danger ? "text-danger hover:bg-danger-soft" : "text-text hover:bg-hover"
          }`}
          onClick={() => { it.onClick(); onClose(); }}
        >
          <span className="flex h-4 w-4 items-center justify-center">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** 会话行（主流 规格：32px 高 r8，悬停时间换成 ⋯ 菜单；无状态圆点） */
function SessionRow({ s, onOpen, onRename, onPin, onArchive, busy }: {
  s: SessionMeta;
  onOpen: () => void;
  onRename: (title: string) => void;
  onPin: () => void;
  onArchive: () => void;
  busy?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const runningIds = useStore((s) => s.runningIds);
  const approvals = useStore((s) => s.approvals);
  const askBySession = useStore((s) => s.askBySession);
  const plansBySession = useStore((s) => s.plansBySession);
  const active = s.id === activeSessionId;
  // v3.1：多会话并行——运行态按会话集合判断（后台任务完成/进行中侧栏可随时切换）
  const isRunning = runningIds.includes(s.id);
  // v5.0（A3）：后台会话待处理徽标——该会话有挂起的审批/提问/计划时亮起
  // （多会话并行时后台任务的决策请求不再无处可寻；切到该会话即弹出对应卡片）
  const pendingCount =
    approvals.filter((a) => a.sessionId === s.id).length +
    (askBySession[s.id] ? 1 : 0) +
    (plansBySession[s.id] ? 1 : 0);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const t = title.trim();
    if (t && t !== s.title) onRename(t);
    setEditing(false);
  };

  return (
    <div
      className={`infu-session-row group relative flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors duration-150 ${
        active ? "bg-hover text-text" : "text-text/80 hover:bg-hover/60 hover:text-text"
      } ${busy ? "opacity-60" : ""}`}
      onClick={() => !editing && onOpen()}
      title={`${s.title}\n${s.root}\n${s.promptCount} 轮 · ${s.toolCount} 工具 · ${fmtTime(s.createdAt)} 创建`}
    >
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            className="h-5 min-w-0 flex-1 rounded border border-info/50 bg-input px-1.5 text-[13px] text-text focus:outline-none"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setTitle(s.title); setEditing(false); } }}
            spellCheck={false}
          />
          <IconBtn title="保存" onClick={commit} active><Check className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn title="取消" onClick={() => { setTitle(s.title); setEditing(false); }}><X className="h-3.5 w-3.5" /></IconBtn>
        </div>
      ) : (
        <>
          {s.pinned && <Pin className="h-3 w-3 shrink-0 text-info" />}
          {/* 运行中：六段环形横杠，比单一绿点更明确但仍保持侧栏行的紧凑密度。 */}
          {isRunning && (
            <span className="relative flex h-4 w-4 shrink-0 animate-spin" title="任务正在运行">
              {Array.from({ length: 6 }, (_, i) => (
                <span
                  key={i}
                  className="absolute left-1/2 top-1/2 h-[2px] w-[5px] rounded-full bg-success"
                  style={{ transform: `translate(-50%, -50%) rotate(${i * 60}deg) translateY(-5px)`, opacity: 0.32 + i * 0.11 }}
                />
              ))}
            </span>
          )}
          {/* v5.0（A3）：待处理徽标（审批/提问/计划挂起——后台会话的决策入口提示） */}
          {pendingCount > 0 && (
            <span
              className="flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-full bg-warn/20 px-1 text-[9px] font-semibold text-warn"
              title={`${pendingCount} 项待处理（审批/提问/计划）——切换到本会话处理`}
            >
              {pendingCount}
            </span>
          )}
          <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${active ? "font-medium" : ""}`}>{s.title}</span>
          <span className="shrink-0 text-xs leading-[18px] text-caption group-hover:hidden">
            {formatDuration(s.createdAt, s.updatedAt)}
          </span>
          {/* hover 操作：⋯ 下拉菜单（重命名/顶置/归档） */}
          <span className="relative hidden shrink-0 items-center group-hover:flex">
            <IconBtn
              title="操作"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
              active={menuOpen}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </IconBtn>
            {menuOpen && (
              <RowMenu
                onClose={() => setMenuOpen(false)}
                items={[
                  { label: "重命名", icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setEditing(true) },
                  { label: s.pinned ? "取消顶置" : "顶置", icon: s.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />, onClick: onPin },
                  { label: "归档", icon: <Archive className="h-3.5 w-3.5" />, onClick: onArchive },
                ]}
              />
            )}
          </span>
        </>
      )}
    </div>
  );
}

/** 区块头（项目/会话；主流 36px section header 风格；onClick 传入则整行可点） */
function SectionHeader({ icon, label, children, onClick }: {
  icon: React.ReactNode;
  label: string;
  children?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      // v2.14 批 15：区块头 sticky 吸顶（滚动时保持可见，内容从其下穿过）——侧栏单滚动容器 + 分区头跟随机制
      className={`sticky top-0 z-10 mb-0.5 mt-1 flex h-9 items-center gap-1.5 border-b border-line/70 bg-sidebar/95 px-2 text-xs font-semibold text-sub backdrop-blur-sm first:mt-0 ${
        onClick ? "cursor-pointer select-none rounded-lg transition-colors hover:bg-hover/60 hover:text-text" : ""
      }`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      <span className="ml-auto flex items-center gap-0.5">{children}</span>
    </div>
  );
}

interface SidebarProps {
  /** v3.0 UI 审查：类型收紧为 SettingsTab（此前 string 需在 App 侧强转） */
  onOpenSettings: (tab: SettingsTab) => void;
  /** v3：grid 布局扩展类（如 row-span-2——顶部区域不覆盖侧栏） */
  className?: string;
}

/**
 * 左侧栏（v3：重构——60px Logo 行 / 新建会话 38px r12 / 搜索胶囊 / 会话树 32px 行 /
 * 底部设置行；可折叠为 56px rail：Logo=展开、新建图标、设置图标）。
 */
export default function Sidebar({ onOpenSettings, className = "" }: SidebarProps) {
  const root = useStore((s) => s.root);
  const setRoot = useStore((s) => s.setRoot);
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const newSession = useStore((s) => s.newSession);
  const loadSession = useStore((s) => s.loadSession);
  const clearPendingRollback = useStore((s) => s.clearPendingRollback);
  const searchFocusTick = useStore((s) => s.searchFocusTick);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);
  const useWorktree = useStore((s) => s.useWorktree);
  const setUseWorktree = useStore((s) => s.setUseWorktree);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}); // 项目折叠
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({}); // 项目组内会话展开（显示更多）
  const [collapseAll, setCollapseAll] = useState(false); // 全部收起
  const [freeCollapsed, setFreeCollapsed] = useState(false); // 自由会话区折叠
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null); // 移除项目两段式确认
  // v3：行内 ⋯ 下拉菜单归属（project=项目行 / session=会话行内自管理）
  const [menuFor, setMenuFor] = useState<{ type: "project"; id: string } | null>(null);
  // v3：分组/排序（标题行下拉菜单；主流 workspace 菜单：分组方式 + 排序方式）
  const [groupMode, setGroupMode] = useState<"workspace" | "flat">("workspace");
  const [sortMode, setSortMode] = useState<"manual" | "recent">("manual");
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // v3：默认会话根目录（config.general.defaultRoot；会话区新建会话的默认 root）
  const [defaultRoot, setDefaultRoot] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  /** 会话列表（服务端已排除归档）+ 默认会话根目录 */
  useEffect(() => {
    fetchSessions();
    fetchConfig().then((cfg) => setDefaultRoot(cfg.general.defaultRoot ?? "")).catch(() => {});
  }, []);

  /** 项目数据：挂载 + 会话列表变化时刷新（项目 = 注册表 + 会话统计） */
  useEffect(() => {
    fetchProjects().then(setProjects).catch(() => {});
  }, [sessions]);

  /** Ctrl+K 聚焦搜索（store 信号） */
  useEffect(() => {
    if (searchFocusTick > 0) {
      setSearchOpen(true);
      // 展开动画一帧后再聚焦
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [searchFocusTick]);

  /** 切换会话（v3.1：多会话并行——运行中可切换；缓存命中秒切，无缓存拉事件重放） */
  const openSession = async (id: string, sessionRoot?: string) => {
    if (id === activeSessionId || busyId) return;
    setBusyId(id);
    try {
      const st = useStore.getState();
      // 会话缓存命中（含正在后台跑的会话）→ 秒切视图，不打断其流式
      if (st.sessionCache[id]) {
        clearPendingRollback();
        st.setActiveSessionId(id);
        st.setSessionRunning(id, st.runningIds.includes(id));
        useStore.setState({ messages: st.sessionCache[id] });
        if (sessionRoot && sessionRoot !== root) setRoot(sessionRoot);
        return;
      }
      const { events } = await fetchSessionEvents(id);
      clearPendingRollback();
      loadSession(events, id, true); // v2.13：forceView——切换路径先 loadSession 后 setActiveSessionId，需写视图全局字段
      setActiveSessionId(id);
      // v3.1：loadSession 在切换前执行（activeSessionId 尚未更新，只写了缓存）——
      // 切换后把视图 messages 同步到该会话缓存
      useStore.setState({ messages: useStore.getState().sessionCache[id] ?? [] });
      if (sessionRoot && sessionRoot !== root) setRoot(sessionRoot);
    } catch (e) {
      // v4.0 审计修复（L1）：加载失败静默 → 提示（原实现点会话无响应且无任何反馈）
      useStore.getState().addError(`会话加载失败：${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  /** 删除会话（仅归档视图内使用；侧栏行删除入口不暴露） */
  const removeSession = async (id: string) => {
    try {
      await deleteSession(id);
      await fetchSessions();
      if (activeSessionId === id) newSession();
    } catch (e) {
      // v4.0 审计修复（M7）：裸 rejection → 提示
      useStore.getState().addError(`会话删除失败：${(e as Error).message}`);
    }
  };

  /** 会话管理操作（重命名/顶置/归档）→ PATCH + 刷新 */
  const patchSession = async (id: string, body: { title?: string; pinned?: boolean; archived?: boolean }) => {
    try {
      await updateSessionApi(id, body);
      await fetchSessions();
      await fetchProjects().then(setProjects);
    } catch (e) {
      // v4.0 审计修复（M7）：裸 rejection → 提示（重命名失败时输入框已退出编辑态，必须告知）
      useStore.getState().addError(`会话更新失败：${(e as Error).message}`);
    }
  };

  /** 在当前项目下新建会话（root 切到项目 + 清空聊天区；v3.1 运行中可新建） */
  const newSessionInProject = (projectRoot: string) => {
    if (projectRoot !== root) setRoot(projectRoot);
    newSession();
  };

  /**
   * v3 新建自由会话：一律落在「默认会话根目录」（config.general.defaultRoot），
   * 该目录为只读容器（服务端工具层拦截写操作）；未配置时回落空 root（服务端用 cwd）。
   * v3.1 运行中可新建（多会话并行）。
   */
  const newFreeSession = () => {
    if (defaultRoot) setRoot(defaultRoot);
    else setRoot("");
    newSession();
  };

  /** 折叠/展开全部项目（区块头点击 + 按钮共用；切换语义） */
  const toggleAllProjects = () => {
    setCollapseAll(false);
    setCollapsed((prev) => {
      const allCollapsed = projects.length > 0 && projects.every((p) => prev[p.id]);
      const n: Record<string, boolean> = { ...prev };
      for (const p of projects) n[p.id] = !allCollapsed;
      return n;
    });
  };

  // ── 数据装配 ──
  const q = search.trim().toLowerCase();
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  const projectByRoot = useMemo(() => {
    const m = new Map<string, ProjectInfo>();
    for (const p of projects) m.set(norm(p.root), p);
    return m;
  }, [projects]);

  const freeSessions = sessions.filter((s) => !projectByRoot.has(norm(s.root)));
  const pinnedSessions = sessions.filter((s) => s.pinned);
  const runningIds = useStore((s) => s.runningIds);
  const approvals = useStore((s) => s.approvals);
  const visible = (list: SessionMeta[]) => (q ? list.filter((s) => s.title.toLowerCase().includes(q)) : list);
  /** v3：排序方式——最近更新按 updatedAt 降序；手动排序保持原顺序 */
  const sortSessions = (list: SessionMeta[]) =>
    sortMode === "recent" ? [...list].sort((a, b) => b.updatedAt - a.updatedAt) : list;
  const pinnedVisible = visible(sortSessions(pinnedSessions));
  const runningVisible = visible(sortSessions(sessions.filter((s) => runningIds.includes(s.id) || approvals.some((a) => a.sessionId === s.id))));
  const freeVisible = visible(sortSessions(freeSessions));
  /** v3：单列表（flat）模式——全部会话按排序方式单列展示（行内标注所属项目） */
  const flatVisible = visible(sortSessions(sessions));

  /* ── 折叠 rail（56px）：Logo=展开 / 新建 / 设置（v3.3 补：按钮加大）── */
  if (sidebarCollapsed) {
    return (
      <aside className={`infu-sidebar flex min-h-0 flex-col items-center gap-1 bg-sidebar/70 backdrop-blur-2xl py-3 select-none ${className}`}>
        <button
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-info transition-colors hover:bg-hover"
          onClick={() => setSidebarCollapsed(false)}
          title="展开侧栏"
        >
          {LOGO}
        </button>
        <button
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-text transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => newSession()}
          title="新建会话（Ctrl+N）"
        >
          <Plus className="h-5 w-5" />
        </button>
        <div className="min-h-0 flex-1" />
        <button
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-sub transition-colors hover:bg-hover hover:text-text"
          onClick={() => onOpenSettings("general")}
          title="设置"
        >
          <Cog className="h-5 w-5" />
        </button>
      </aside>
    );
  }

  return (
    <aside className={`infu-sidebar flex min-h-0 min-w-0 flex-col bg-sidebar/70 backdrop-blur-2xl select-none ${className}`}>
      {/* Logo 行（与聊天 header 同高）：点击 = 新建会话；右侧折叠按钮；
           v3.0 批 9 = 窗口拖拽区（no-drag 给按钮）
           窗口级顶部统一为 40px（与 Electron 原生控制区同高）
           v3.3 补：去掉底部 border-b 分隔细线（用户拍板：左侧栏最顶上不要细线） */}
      <div
        className="flex h-9 shrink-0 items-center justify-between bg-sidebar px-4"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <button
          className="flex min-w-0 cursor-pointer items-center gap-2 text-text transition-colors hover:text-info"
          onClick={() => newSession()}
          title="新建会话（Ctrl+N）"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <span className="text-info">{LOGO}</span>
          <span className="truncate text-[15px] font-semibold tracking-wide">InFu</span>
        </button>
        <button
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-sub transition-colors hover:bg-hover hover:text-text"
          onClick={() => setSidebarCollapsed(true)}
          title="折叠侧栏"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <PanelLeftClose className="h-5 w-5" />
        </button>
      </div>

      {/* 主操作区：新建会话在最上方（全宽），下方技能 + 搜索并排（v3 用户定稿） */}
      <div className="shrink-0 space-y-2 px-3 pb-2">
        <button
          className="flex h-[38px] w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-primary text-sm font-semibold text-primary-fg shadow-lv1 transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => newSession()}
          title="新建会话（Ctrl+N；若当前 root 属于某项目则会话隶属该项目，否则为自由会话）"
        >
          <Plus className="h-3.5 w-3.5" />
          新建会话
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            className="flex h-[34px] cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-line bg-elevated text-[13px] font-medium text-text transition-colors hover:border-info/30 hover:bg-hover"
            onClick={() => onOpenSettings("skills")}
            title="技能管理（设置 → Agent 能力 → 技能）"
          >
            <Puzzle className="h-3.5 w-3.5" />
            技能
          </button>
          <button
            className={`flex h-[34px] cursor-pointer items-center justify-center gap-1.5 rounded-xl border text-[13px] font-medium transition-colors ${
              searchOpen
                ? "border-info/50 bg-info-soft text-info"
                : "border-line bg-elevated text-text shadow-lv1 hover:bg-hover"
            }`}
            onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }}
            title="搜索会话（Ctrl+K）"
          >
            <Search className="h-3.5 w-3.5" />
            搜索
          </button>
        </div>
      </div>

      {/* 搜索展开输入（点击「搜索」按钮后出现；主流 搜索胶囊 30px） */}
      {searchOpen && (
        <div className="mx-3 mb-1.5 flex h-[30px] shrink-0 items-center gap-1.5 rounded-[10px] border border-info/40 bg-input px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-sub" />
          <input
            ref={searchRef}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-text placeholder:text-caption focus:outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (search) setSearch("");
                else { setSearchOpen(false); searchRef.current?.blur(); }
              }
            }}
            onBlur={() => { if (!search) setSearchOpen(false); }}
            placeholder="搜索会话…"
            spellCheck={false}
          />
          {search && (
            <button className="cursor-pointer rounded p-0.5 text-sub hover:text-text" onClick={() => setSearch("")} title="清除搜索（Esc）">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* 区标题行（主流 36px section header）：项目与会话 + 归档 + 分组/排序下拉 */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-y border-line/60 px-3">
        <span className="px-1 text-[11px] font-semibold tracking-[0.08em] text-caption">项目与会话</span>
        <span className="ml-auto flex items-center gap-1.5">
          <IconBtn title="归档回收站（Archived：恢复 / 删除归档会话）" onClick={() => setArchiveOpen(true)}>
            <Archive className="h-3.5 w-3.5" />
          </IconBtn>
          <span className="relative">
            <IconBtn
              title="分组与排序"
              onClick={() => setGroupMenuOpen(!groupMenuOpen)}
              active={groupMenuOpen}
            >
              <ListFilter className="h-3.5 w-3.5" />
            </IconBtn>
            {groupMenuOpen && (
              <div
                className="absolute right-0 top-6 z-50 min-w-[150px] rounded-xl border border-line bg-elevated p-1 shadow-lv3"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium text-caption">分组方式</div>
                {([
                  { id: "workspace", label: "按工作区" },
                  { id: "flat", label: "单列表" },
                ] as const).map((g) => (
                  <button
                    key={g.id}
                    className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] text-text transition-colors hover:bg-hover"
                    onClick={() => { setGroupMode(g.id); setGroupMenuOpen(false); }}
                  >
                    <span className="min-w-0 flex-1 truncate">{g.label}</span>
                    {groupMode === g.id && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
                  </button>
                ))}
                <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium text-caption">排序方式</div>
                {([
                  { id: "manual", label: "手动排序" },
                  { id: "recent", label: "最近更新" },
                ] as const).map((s) => (
                  <button
                    key={s.id}
                    className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] text-text transition-colors hover:bg-hover"
                    onClick={() => { setSortMode(s.id); setGroupMenuOpen(false); }}
                  >
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    {sortMode === s.id && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
                  </button>
                ))}
              </div>
            )}
          </span>
        </span>
      </div>

      {/* 主体滚动区 */}
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {/* ── v3 单列表模式（分组方式 = 单列表）：全部会话一列，行内标注所属项目 ── */}
        {groupMode === "flat" ? (
          <>
            <div className="mb-0.5 mt-1 flex h-9 items-center gap-1.5 px-2 text-xs font-semibold text-sub">
              <MessageSquare className="h-3.5 w-3.5" />
              <span>全部会话</span>
              <span className="ml-auto rounded-full bg-hover px-1.5 text-[11px] leading-[18px] text-sub">{flatVisible.length}</span>
            </div>
            <div className="space-y-0.5">
              {flatVisible.length === 0 && <div className="px-2 py-1 text-xs text-sub/60">暂无会话</div>}
              {flatVisible.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  onOpen={() => openSession(s.id, s.root)}
                  onRename={(t) => patchSession(s.id, { title: t })}
                  onPin={() => patchSession(s.id, { pinned: !s.pinned })}
                  onArchive={() => patchSession(s.id, { archived: true, pinned: false })}
                  busy={busyId === s.id}
                />
              ))}
            </div>
          </>
        ) : (
        <>
        {/* ── 运行中与待审批：多会话并行时的高频入口 ── */}
        {!collapseAll && runningVisible.length > 0 && (
          <>
            <SectionHeader icon={<GitBranch className="h-3.5 w-3.5" />} label="运行中" >
              <span className="rounded-full bg-info-soft px-1.5 text-[11px] leading-[18px] text-info">{runningVisible.length}</span>
            </SectionHeader>
            <div className="mb-1 space-y-0.5">
              {runningVisible.map((s) => (
                <SessionRow
                  key={`running-${s.id}`}
                  s={s}
                  onOpen={() => openSession(s.id, s.root)}
                  onRename={(t) => patchSession(s.id, { title: t })}
                  onPin={() => patchSession(s.id, { pinned: !s.pinned })}
                  onArchive={() => patchSession(s.id, { archived: true, pinned: false })}
                  busy={busyId === s.id}
                />
              ))}
            </div>
          </>
        )}

        {/* ── 已顶置（项目栏上方） ── */}
        {!collapseAll && pinnedVisible.length > 0 && (
          <>
            <SectionHeader icon={<Pin className="h-3.5 w-3.5" />} label="已顶置" />
            <div className="mb-1 space-y-0.5">
              {pinnedVisible.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  onOpen={() => openSession(s.id, s.root)}
                  onRename={(t) => patchSession(s.id, { title: t })}
                  onPin={() => patchSession(s.id, { pinned: !s.pinned })}
                  onArchive={() => patchSession(s.id, { archived: true, pinned: false })}
                  busy={busyId === s.id}
                />
              ))}
            </div>
          </>
        )}

        {/* ── 项目区（注册表 + 组内会话；区块头点击 = 折叠/展开全部项目；右侧新建项目大按钮） ── */}
        <SectionHeader
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          label="项目"
          onClick={toggleAllProjects}
        >
          <button
            className="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-line bg-elevated px-2.5 text-xs font-medium text-text shadow-lv1 transition-colors hover:bg-hover"
            onClick={(e) => { e.stopPropagation(); setCreateOpen(true); }}
            title="创建项目（注册本机文件夹为项目）"
          >
            <Plus className="h-3.5 w-3.5" />
            新建项目
          </button>
        </SectionHeader>

        {projects.length === 0 && (
          <div className="px-2 py-1 text-xs text-sub/60">暂无项目</div>
        )}

        {!collapseAll && projects.map((p) => {
          const isCurrent = norm(p.root) === norm(root);
          const isCollapsed = collapsed[p.id];
          const isExpanded = expandedIds[p.id];
          const ps = visible(p.recentSessions);
          const shown = isCollapsed ? [] : isExpanded ? ps : ps.slice(0, 5);
          const menuOpen = menuFor?.type === "project" && menuFor.id === p.id;
          return (
            <div key={p.id}>
              <div
                className={`infu-project-row group relative flex h-[34px] cursor-pointer items-center gap-1 rounded-lg px-2 transition-colors duration-150 ${
                  isCurrent ? "bg-hover text-text" : "text-text/85 hover:bg-hover/60 hover:text-text"
                }`}
                // v3：项目行点击 = 选中项目；再点一次 = 折叠/展开该项目（项目行即折叠按钮）
                onClick={() => {
                  if (p.root !== root) setRoot(p.root);
                  else setCollapsed((c) => ({ ...c, [p.id]: !isCollapsed }));
                }}
                title={`${p.root}\n${p.sessionCount} 个会话（点击选中；再点一次折叠/展开）`}
              >
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-sub transition-transform duration-150 ${!isCollapsed ? "rotate-90" : ""}`} />
                {isCurrent ? <FolderOpen className="h-4 w-4 shrink-0 text-info" /> : <Folder className="h-4 w-4 shrink-0 text-sub/70" />}
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">{p.name}</span>
                {p.sessionCount > 0 && (
                  <span className="shrink-0 rounded-full bg-hover px-1.5 text-[11px] leading-[18px] text-sub">{p.sessionCount}</span>
                )}
                <button
                  className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sub transition-colors hover:bg-hover hover:text-info"
                  onClick={(e) => { e.stopPropagation(); newSessionInProject(p.root); }}
                  title={`在 ${p.name} 中新建会话`}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                {/* 项目操作：⋯ 下拉菜单（折叠/移除）；确认移除两段式 */}
                <span className="relative flex shrink-0 items-center">
                  {confirmRemove === p.id ? (
                    // v3.0 批 12：移除确认改下拉面板（RowMenu 同款样式——与主题/其他下拉一致）
                    <div
                      className="absolute right-0 top-6 z-50 w-[190px] rounded-xl border border-line bg-elevated p-1 shadow-lv3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="px-2.5 pb-1 pt-1.5 text-[11px] leading-4 text-sub">
                        确定要移除项目
                        <span className="block truncate font-mono text-[10px] text-caption">{p.name}</span>
                        <span className="mt-0.5 block text-[10px] text-caption">会话保留为自由会话，文件夹不删</span>
                      </div>
                      <button
                        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] text-danger transition-colors hover:bg-danger-soft"
                        onClick={async () => {
                          try {
                            await removeProjectApi(p.id);
                            setConfirmRemove(null);
                            await fetchProjects().then(setProjects);
                            await fetchSessions();
                            // v3.0 批 12：移除的项目若正是当前 root → 清空（否则新建会话仍显示已删项目名）
                            // v4.0（L5）：Windows 反斜杠路径同样归一（原只去 `/`，尾反斜杠路径匹配失效）
                            const st = useStore.getState();
                            if (st.root && st.root.replace(/[\\/]+$/, "").toLowerCase() === p.root.replace(/[\\/]+$/, "").toLowerCase()) {
                              useStore.getState().setRoot("");
                            }
                          } catch (e) {
                            // v4.0 审计修复（M7）：裸 rejection → 提示
                            useStore.getState().addError(`项目移除失败：${(e as Error).message}`);
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        确认移除
                      </button>
                      <button
                        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] text-text transition-colors hover:bg-hover"
                        onClick={() => setConfirmRemove(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                        取消
                      </button>
                    </div>
                  ) : (
                    <span className="hidden items-center group-hover:flex">
                      <IconBtn
                        title="操作"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuFor(menuOpen ? null : { type: "project", id: p.id });
                        }}
                        active={menuOpen}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </IconBtn>
                      {menuOpen && (
                        <RowMenu
                          onClose={() => setMenuFor(null)}
                          items={[
                            { label: isCollapsed ? "展开项目" : "折叠项目", icon: <ChevronsDownUp className="h-3.5 w-3.5" />, onClick: () => setCollapsed((c) => ({ ...c, [p.id]: !isCollapsed })) },
                            { label: "移除项目", icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setConfirmRemove(p.id) },
                          ]}
                        />
                      )}
                    </span>
                  )}
                </span>
              </div>
              {/* 组内会话 */}
              {!isCollapsed && (
                <div className="ml-[13px] mt-0.5 space-y-0.5 border-l border-line pl-1.5">
                  {shown.length === 0 && <div className="px-2 py-0.5 text-xs text-caption">暂无会话</div>}
                  {shown.map((s) => (
                    <SessionRow
                      key={s.id}
                      s={s}
                      onOpen={() => openSession(s.id, s.root)}
                      onRename={(t) => patchSession(s.id, { title: t })}
                      onPin={() => patchSession(s.id, { pinned: !s.pinned })}
                      onArchive={() => patchSession(s.id, { archived: true, pinned: false })}
                      busy={busyId === s.id}
                    />
                  ))}
                  {ps.length > 5 && !isExpanded && (
                    <button
                      className="cursor-pointer rounded-lg px-2 py-0.5 text-xs text-sub transition-colors hover:text-info"
                      onClick={() => setExpandedIds((e) => ({ ...e, [p.id]: true }))}
                    >
                      显示更多（{ps.length - 5}）
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* ── 会话区（无项目隶属，类似一个"自由项目"；区块头点击 = 折叠/展开） ── */}
        <SectionHeader
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label="会话"
          onClick={() => { setCollapseAll(false); setFreeCollapsed(!freeCollapsed); }}
        >
          <button
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-sub transition-colors hover:bg-hover hover:text-info"
            onClick={(e) => { e.stopPropagation(); newFreeSession(); }}
            title="新建会话（自由会话，不隶属任何项目）"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </SectionHeader>
        {!collapseAll && !freeCollapsed && (
          <div className="space-y-0.5">
            {freeVisible.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                onOpen={() => openSession(s.id, s.root)}
                onRename={(t) => patchSession(s.id, { title: t })}
                onPin={() => patchSession(s.id, { pinned: !s.pinned })}
                onArchive={() => patchSession(s.id, { archived: true, pinned: false })}
                busy={busyId === s.id}
              />
            ))}
          </div>
        )}
        </>
        )}
      </div>

      {/* 底部（v3：不占整个底部——工作树开关 + 设置并排；v3.3 补 5：去掉 border-t 细线） */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-line/60 px-2 py-2">
        <button
          className={`flex h-[34px] shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-medium transition-colors ${
            useWorktree ? "border-info/40 bg-info-soft text-info" : "border-line bg-transparent text-sub hover:bg-hover hover:text-text"
          }`}
          onClick={() => setUseWorktree(!useWorktree)}
          title="开启后每个任务在独立工作树副本中执行，主代码零污染，完成后可合并或丢弃"
        >
          <GitBranch className="h-3.5 w-3.5" />
          {useWorktree ? "工作树开" : "工作树关"}
        </button>
        <button
          className="flex h-[34px] min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl px-2.5 text-[13px] text-text transition-colors hover:bg-hover"
          onClick={() => onOpenSettings("general")}
          title="设置（基础设置 / Agent 能力 / 数据与统计）"
        >
          <Cog className="h-4 w-4 shrink-0 text-sub" />
          设置
          <span className="ml-auto truncate text-[11px] text-caption">{sessions.length} 个会话</span>
        </button>
      </div>

      {/* 归档回收站 */}
      {archiveOpen && (
        <ArchiveModal
          onClose={() => setArchiveOpen(false)}
          onRestored={async (id) => { await patchSession(id, { archived: false }); }}
          onDeleted={async (id) => { await removeSession(id); }}
        />
      )}
      {/* 创建项目 */}
      {createOpen && (
        <CreateProjectModal
          currentRoot={root}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => { await fetchProjects().then(setProjects); }}
        />
      )}
    </aside>
  );
}
