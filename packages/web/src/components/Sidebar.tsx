import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, Zap, Puzzle, FolderOpen, Folder, ChevronRight, Pin, PinOff, Archive, Pencil, Check, X, Trash2, ArchiveRestore, MessageSquare, MessageSquarePlus, ChevronsDownUp, ChevronsUpDown, ListCollapse } from "lucide-react";
import type { SessionMeta } from "@infu/shared";
import { useStore } from "../store";
import { fetchSessions, fetchSessionEvents, deleteSession, fetchProjects, updateSessionApi, removeProjectApi } from "../api";
import type { ProjectInfo } from "../api";
import ArchiveModal from "./ArchiveModal";
import CreateProjectModal from "./CreateProjectModal";

/** 会话状态徽标 */
const STATUS_BADGE: Record<SessionMeta["status"], { label: string; cls: string }> = {
  done: { label: "✓", cls: "text-accent" },
  running: { label: "●", cls: "text-accent animate-pulse" },
  error: { label: "✗", cls: "text-danger" },
  stopped: { label: "‖", cls: "text-warn" },
};

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

/** 会话行：标题 + 时长 + 状态徽标 + hover 三按钮（重命名/顶置/归档） */
function SessionRow({ s, projectName, onOpen, onRename, onPin, onArchive, busy }: {
  s: SessionMeta;
  projectName?: string;
  onOpen: () => void;
  onRename: (title: string) => void;
  onPin: () => void;
  onArchive: () => void;
  busy?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const { activeSessionId, running } = useStore();
  const active = s.id === activeSessionId;

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

  const badge = STATUS_BADGE[s.status];

  return (
    <div
      className={`group relative cursor-pointer rounded px-1.5 py-0.5 transition-colors duration-150 ${
        active ? "bg-accent/10" : "hover:bg-muted/60"
      } ${busy ? "opacity-60" : ""}`}
      onClick={() => !editing && onOpen()}
      title={`${s.title}\n${s.root}\n${s.promptCount} 轮 · ${s.toolCount} 工具 · ${fmtTime(s.createdAt)} 创建`}
    >
      {editing ? (
        <div className="flex items-center gap-1 py-0.5" onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            className="h-5 min-w-0 flex-1 rounded border border-accent/60 bg-muted px-1 text-[10px] text-text focus:outline-none"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setTitle(s.title); setEditing(false); } }}
            spellCheck={false}
          />
          <button className="cursor-pointer rounded p-0.5 text-accent hover:bg-muted" onClick={commit} title="保存">
            <Check className="h-3 w-3" />
          </button>
          <button className="cursor-pointer rounded p-0.5 text-sub hover:text-text" onClick={() => { setTitle(s.title); setEditing(false); }} title="取消">
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1">
            {s.pinned && <Pin className="h-2.5 w-2.5 shrink-0 text-accent" />}
            <span className={`min-w-0 flex-1 truncate text-[10px] ${active ? "text-accent" : "text-text/80"}`}>{s.title}</span>
            <span className={`shrink-0 text-[9px] ${badge.cls}`}>{badge.label}</span>
          </div>
          <div className="flex items-center gap-1 text-[9px] text-sub/60">
            <span>{formatDuration(s.createdAt, s.updatedAt)}</span>
            {projectName && <span className="truncate text-sub/40">· {projectName}</span>}
            {/* hover 操作：重命名 / 顶置 / 归档 */}
            <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
              <button
                className="cursor-pointer rounded p-0.5 text-sub/60 transition-colors hover:text-accent"
                onClick={(e) => { e.stopPropagation(); setEditing(true); }}
                title="重命名"
              >
                <Pencil className="h-2.5 w-2.5" />
              </button>
              <button
                className={`cursor-pointer rounded p-0.5 transition-colors ${s.pinned ? "text-accent" : "text-sub/60 hover:text-accent"}`}
                onClick={(e) => { e.stopPropagation(); onPin(); }}
                title={s.pinned ? "取消顶置" : "顶置（显示在项目栏上方）"}
              >
                {s.pinned ? <PinOff className="h-2.5 w-2.5" /> : <Pin className="h-2.5 w-2.5" />}
              </button>
              <button
                className="cursor-pointer rounded p-0.5 text-sub/60 transition-colors hover:text-accent"
                onClick={(e) => { e.stopPropagation(); onArchive(); }}
                title="归档（移入 Archive 回收站）"
              >
                <Archive className="h-2.5 w-2.5" />
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** 区块头（项目/会话） */
function SectionHeader({ icon, label, children }: { icon: React.ReactNode; label: string; children?: React.ReactNode }) {
  return (
    <div className="mb-1 mt-2 flex items-center gap-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-sub/60 first:mt-0">
      {icon}
      <span>{label}</span>
      <span className="ml-auto flex items-center gap-0.5">{children}</span>
    </div>
  );
}

interface SidebarProps {
  onOpenSettings: (tab: string) => void;
}

/** 左侧栏（v2.6.1 会话中枢）：顶部 新建会话/定时任务/技能 + 搜索；置顶区；项目区（注册表+组内会话）；自由会话区 */
export default function Sidebar({ onOpenSettings }: SidebarProps) {
  const {
    root, setRoot, running, sessions, activeSessionId, setActiveSessionId, newSession, loadSession,
    clearPendingRollback, searchFocusTick,
  } = useStore();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}); // 项目折叠
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({}); // 项目组内会话展开（显示更多）
  const [collapseAll, setCollapseAll] = useState(false); // 全部收起
  const [freeCollapsed, setFreeCollapsed] = useState(false); // 自由会话区折叠
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null); // 移除项目两段式确认
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  /** 会话列表（服务端已排除归档） */
  useEffect(() => {
    fetchSessions();
  }, []);

  /** 项目数据：挂载 + 会话列表变化时刷新（项目 = 注册表 + 会话统计） */
  useEffect(() => {
    fetchProjects().then(setProjects).catch(() => {});
  }, [sessions]);

  /** Ctrl+K 聚焦搜索（store 信号） */
  useEffect(() => {
    if (searchFocusTick > 0) searchRef.current?.focus();
  }, [searchFocusTick]);

  /** 切换会话：加载历史（重放事件流）；运行中禁止切换 */
  const openSession = async (id: string, sessionRoot?: string) => {
    if (running || id === activeSessionId || busyId) return;
    setBusyId(id);
    try {
      const { events } = await fetchSessionEvents(id);
      clearPendingRollback();
      loadSession(events);
      setActiveSessionId(id);
      if (sessionRoot && sessionRoot !== root) setRoot(sessionRoot);
    } catch {
      /* 加载失败静默 */
    } finally {
      setBusyId(null);
    }
  };

  /** 删除会话（仅归档视图内使用；侧栏行删除入口不暴露） */
  const removeSession = async (id: string) => {
    await deleteSession(id);
    await fetchSessions();
    if (activeSessionId === id) newSession();
  };

  /** 会话管理操作（重命名/顶置/归档）→ PATCH + 刷新 */
  const patchSession = async (id: string, body: { title?: string; pinned?: boolean; archived?: boolean }) => {
    await updateSessionApi(id, body);
    await fetchSessions();
    await fetchProjects().then(setProjects);
  };

  /** 在当前项目下新建会话（root 切到项目 + 清空聊天区） */
  const newSessionInProject = (projectRoot: string) => {
    if (running) return;
    if (projectRoot !== root) setRoot(projectRoot);
    newSession();
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
  const visible = (list: SessionMeta[]) => (q ? list.filter((s) => s.title.toLowerCase().includes(q)) : list);
  const pinnedVisible = visible(pinnedSessions);
  const freeVisible = visible(freeSessions);

  const currentProject = projectByRoot.get(norm(root)) ?? null;

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      {/* 顶部操作行（v2.6.1：新建会话主 CTA；定时任务[规划中]/技能并排；搜索常驻） */}
      <div className="shrink-0 space-y-1.5 border-b border-line p-2.5">
        <button
          className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-1.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => !running && newSession()}
          disabled={running}
          title="新建会话（Ctrl+N；若当前 root 属于某项目则会话隶属该项目，否则为自由会话）"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          新建会话
        </button>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            className="flex cursor-not-allowed items-center justify-center gap-1 rounded-md border border-line px-2 py-1.5 text-[11px] text-sub/50"
            title="定时任务 / 自动化（规划中，见设置→数据与统计）"
          >
            <Zap className="h-3.5 w-3.5" />
            定时任务
            <span className="rounded-full border border-warn/40 bg-warn/10 px-1.5 py-px text-[9px] text-warn">规划中</span>
          </button>
          <button
            className="flex cursor-pointer items-center justify-center gap-1 rounded-md border border-line px-2 py-1.5 text-[11px] text-text transition-colors hover:border-accent/40 hover:text-accent"
            onClick={() => onOpenSettings("skills")}
            title="技能管理（打开设置 → Agent 能力 → 技能）"
          >
            <Puzzle className="h-3.5 w-3.5" />
            技能
          </button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-sub/50" />
          <input
            ref={searchRef}
            className="h-7 w-full rounded-md border border-line bg-muted pl-7 pr-6 text-[11px] text-text placeholder:text-sub/50 focus:border-accent/60 focus:outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); searchRef.current?.blur(); } }}
            placeholder="搜索会话…"
            spellCheck={false}
          />
          {search && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-sub/60 transition-colors hover:text-text"
              onClick={() => setSearch("")}
              title="清除搜索（Esc）"
            >
              <span className="text-[10px]">✕</span>
            </button>
          )}
        </div>
      </div>

      {/* 归档 + 全部收起（置顶区上方，用户定稿） */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <button
          className="flex cursor-pointer items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-sub/70 transition-colors hover:border-accent/40 hover:text-accent"
          onClick={() => setArchiveOpen(true)}
          title="归档回收站（Archived：恢复 / 删除归档会话）"
        >
          <Archive className="h-3 w-3" />
          Archive
        </button>
        <button
          className="flex cursor-pointer items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-sub/70 transition-colors hover:border-accent/40 hover:text-accent"
          onClick={() => setCollapseAll(!collapseAll)}
          title={collapseAll ? "展开全部项目与会话" : "全部收起（项目和会话全部折叠）"}
        >
          {collapseAll ? <ChevronsUpDown className="h-3 w-3" /> : <ListCollapse className="h-3 w-3" />}
          {collapseAll ? "全部展开" : "全部收起"}
        </button>
      </div>

      {/* 主体滚动区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {/* ── 已顶置（项目栏上方） ── */}
        {!collapseAll && pinnedVisible.length > 0 && (
          <>
            <SectionHeader icon={<Pin className="h-3 w-3" />} label="已顶置" />
            <div className="mb-1 space-y-0.5">
              {pinnedVisible.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  projectName={projectByRoot.get(norm(s.root))?.name}
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

        {/* ── 项目区（注册表 + 组内会话） ── */}
        <SectionHeader icon={<FolderOpen className="h-3 w-3" />} label="项目">
          <button
            className="cursor-pointer rounded border border-line p-0.5 text-sub/60 transition-colors hover:border-accent/40 hover:text-accent"
            onClick={() => setCollapsed({})}
            title="折叠全部项目"
          >
            <ChevronsDownUp className="h-3 w-3" />
          </button>
          <button
            className="cursor-pointer rounded border border-line p-0.5 text-sub/60 transition-colors hover:border-accent/40 hover:text-accent"
            onClick={() => setCreateOpen(true)}
            title="创建项目（注册本机文件夹为项目）"
          >
            <Plus className="h-3 w-3" />
          </button>
        </SectionHeader>

        {projects.length === 0 && (
          <div className="rounded-md border border-dashed border-line px-2 py-2 text-[10px] leading-relaxed text-sub/50">
            暂无项目。
            <br />
            点击区块头 ＋ 创建项目（浏览文件夹 / 输入路径注册）。
          </div>
        )}

        {!collapseAll && projects.map((p) => {
          const isCurrent = norm(p.root) === norm(root);
          const isCollapsed = collapsed[p.id];
          const isExpanded = expandedIds[p.id];
          const ps = visible(p.recentSessions);
          const shown = isCollapsed ? [] : isExpanded ? ps : ps.slice(0, 5);
          return (
            <div key={p.id}>
              <div
                className={`group flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 transition-colors duration-150 ${
                  isCurrent ? "bg-accent/10 text-accent" : "text-text/85 hover:bg-muted/60 hover:text-text"
                }`}
                // v2.6.2 修复：项目行点击 = 选中该项目（切换 root，顶部「新建会话」即在项目下新建）；
                // 折叠/展开由右侧 [⏷] 按钮独立控制
                onClick={() => { if (p.root !== root) setRoot(p.root); }}
                title={`${p.root}\n${p.sessionCount} 个会话（点击选中；⏷ 折叠/展开）`}
              >
                <ChevronRight className={`h-3 w-3 shrink-0 transition-transform duration-150 ${!isCollapsed ? "rotate-90" : ""}`} />
                {isCurrent ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-sub/70" />}
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{p.name}</span>
                {p.sessionCount > 0 && <span className="shrink-0 rounded-full bg-muted px-1.5 text-[9px] text-sub">{p.sessionCount}</span>}
                {/* 项目操作（常驻）：移除 / 新建会话 / 折叠（用户定稿结构） */}
                <span className="flex shrink-0 items-center gap-0.5">
                  {confirmRemove === p.id ? (
                    <>
                      <span className="text-[9px] text-danger">确认移除？</span>
                      <button
                        className="cursor-pointer rounded p-0.5 text-danger hover:bg-danger/10"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await removeProjectApi(p.id);
                          setConfirmRemove(null);
                          await fetchProjects().then(setProjects);
                          await fetchSessions();
                        }}
                        title="确认移除项目（会话保留为自由会话，文件夹不删）"
                      >
                        <Check className="h-3 w-3" />
                      </button>
                      <button
                        className="cursor-pointer rounded p-0.5 text-sub hover:text-text"
                        onClick={(e) => { e.stopPropagation(); setConfirmRemove(null); }}
                        title="取消"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="cursor-pointer rounded p-0.5 text-sub/60 transition-colors hover:text-danger"
                        onClick={(e) => { e.stopPropagation(); setConfirmRemove(p.id); }}
                        title="移除项目（只删注册）"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                      <button
                        className="cursor-pointer rounded p-0.5 text-sub/60 transition-colors hover:text-accent"
                        onClick={(e) => { e.stopPropagation(); newSessionInProject(p.root); }}
                        title="在此项目新建会话"
                      >
                        <MessageSquarePlus className="h-3 w-3" />
                      </button>
                      <button
                        className="cursor-pointer rounded p-0.5 text-sub/60 transition-colors hover:text-accent"
                        onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [p.id]: !isCollapsed })); }}
                        title={isCollapsed ? "展开项目" : "折叠项目"}
                      >
                        <ChevronsDownUp className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </span>
              </div>
              {/* 组内会话 */}
              {!isCollapsed && (
                <div className="ml-3 mt-0.5 space-y-0.5 border-l border-line pl-2">
                  {shown.length === 0 && <div className="px-1 py-0.5 text-[10px] text-sub/50">暂无会话</div>}
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
                      className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-sub/60 transition-colors hover:text-accent"
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

        {/* ── 自由会话区（无项目隶属；区块头常驻——用户定稿：空态也显示） ── */}
        <SectionHeader icon={<MessageSquare className="h-3 w-3" />} label="会话">
          <button
            className="cursor-pointer rounded border border-line p-0.5 text-sub/60 transition-colors hover:border-accent/40 hover:text-accent"
            onClick={() => setFreeCollapsed(!freeCollapsed)}
            title={freeCollapsed ? "展开全部自由会话" : "折叠全部自由会话"}
          >
            <ChevronsDownUp className="h-3 w-3" />
          </button>
          <button
            className="cursor-pointer rounded border border-line p-0.5 text-sub/60 transition-colors hover:border-accent/40 hover:text-accent"
            onClick={() => !running && newSession()}
            title="新建自由会话（无项目隶属）"
          >
            <MessageSquarePlus className="h-3 w-3" />
          </button>
        </SectionHeader>
        {!collapseAll && !freeCollapsed && (
          <div className="space-y-0.5">
            {freeVisible.length === 0 && (
              <div className="rounded-md border border-dashed border-line px-2 py-2 text-[10px] leading-relaxed text-sub/50">
                暂无自由会话。
                <br />
                点击区块头 ＋ 或顶部「新建会话」开始。
              </div>
            )}
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

        {sessions.length === 0 && (
          <div className="rounded-md border border-dashed border-line px-2 py-3 text-center text-[10px] leading-relaxed text-sub/50">
            点击顶部「新建会话」开始第一个任务。
          </div>
        )}
      </div>

      {/* 底部：当前项目信息 */}

      {/* 底部：当前项目信息 */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-1.5 text-[9px] text-sub/50">
        <MessageSquare className="h-3 w-3" />
        {sessions.length} 个未归档会话
        {currentProject && <span className="ml-auto truncate font-mono" title={root}>{currentProject.name}</span>}
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
