/**
 * v2.14 工具过程显示 — 彻底对齐 主流 ToolCallTree（per-tool 平铺）
 *
 * 结构变化（v2.8 步骤卡片 → per-tool 平铺）：
 *  - 每个工具调用 = 独立一行（图标槽 + 工具名 + 2×2 点分隔 + 关键参数摘要 + 状态）
 *  - 与文本/思考/用户气泡统一 16px 节奏平铺（主流 flow item 语义）
 *  - 运行中：图标 + 扫光带（无 spinner）；失败：图标变红点（StateDot）；成功无标记
 *  - 展开：IN/OUT r12 卡片（已有）+ delegate_task 子智能体条目
 *  - 摘要：优先关键键（command/path/query/pattern/topic…），其次 k=v 前几项
 */

import { useState } from "react";
import {
  FileText, FilePen, Scissors, Search, FolderOpen, Terminal,
  GitBranch, GitCompare, FlaskConical, Building2, Wrench, Loader2, Check, X,
  Brain, Bot, Globe, History, PlusCircle, GitCommitHorizontal, ListChecks, HelpCircle,
  BookOpen, Files, Database, List, Send, FileCheck, Users, Plug, PackagePlus,
  MessageSquare, OctagonX, FolderTree, MonitorCog, Clock3, Move, AppWindow,
} from "lucide-react";
import { useStore, type ToolEventState } from "../store";
import { CodeBlock } from "./ui";

/** 工具图标映射（主流 variant 图标同语义；新工具补齐 v2.14） */
const TOOL_ICON: Record<string, React.ElementType> = {
  read_file: FileText,
  read_files: Files,
  write_file: FilePen,
  edit_file: Scissors,
  search_code: Search,
  glob: Search,
  list_directory: FolderOpen,
  run_command: Terminal,
  run_test: FlaskConical,
  project_scan: Building2,
  git_status: GitBranch,
  git_diff: GitCompare,
  git_log: History,
  git_add: PlusCircle,
  git_commit: GitCommitHorizontal,
  git_branch: GitBranch,
  web_search: Globe,
  webfetch: Globe,
  memory_read: Brain,
  memory_write: Brain,
  todo_write: ListChecks,
  ask_user: HelpCircle,
  use_skill: BookOpen,
  delegate_task: Bot,
  mcp_register: Plug,
  plugin_add: PackagePlus,
  list_agents: Users,
  send_message: Send,
  interrupt_agent: OctagonX,
  report: FileCheck,
  agent_message: MessageSquare,
  job_list: List,
  job_output: FileText,
  job_kill: X,
  session_search: Database,
  session_trace: History,
  // v3.1 工具补齐：project_tree / file_ops / os_info / current_time
  project_tree: FolderTree,
  file_ops: Wrench,
  os_info: MonitorCog,
  current_time: Clock3,
  // v3.3 异步任务编排：wait_task（阻塞等待）；computer use 补齐：screen_drag / screen_windows
  wait_task: Clock3,
  screen_drag: Move,
  screen_windows: AppWindow,
};

/** 摘要关键键（主流 SUMMARY_KEYS 同语义：优先展示命令/路径/查询等核心参数） */
const SUMMARY_KEYS = ["command", "path", "query", "pattern", "topic", "name", "url", "message", "prompt", "agent_id", "job_id"];

/** 工具参数摘要：关键键优先，其次 k=v 前 3 项（主流 ToolRow 摘要语义） */
function fmtArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== "");
  for (const key of SUMMARY_KEYS) {
    const hit = entries.find(([k]) => k === key);
    if (hit) {
      const s = typeof hit[1] === "string" ? hit[1] : JSON.stringify(hit[1]);
      return s.length > 80 ? s.slice(0, 80) + "…" : s;
    }
  }
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 32 ? s.slice(0, 32) + "…" : s}`;
    })
    .join("  ");
}

/** v2.5 委派风险徽标：只读委派（免审批）绿色；写能力委派红色 [high]；历史会话（无 readOnly 数据）中性显示 */
function DelegateRiskBadge({ subagentId }: { subagentId?: string }) {
  const thread = useStore((s) => (subagentId ? s.subagentThreads[subagentId] : undefined));
  if (thread?.readOnly) {
    return <span className="shrink-0 font-mono text-success">[只读·免审批]</span>;
  }
  if (thread && !thread.readOnly) {
    return <span className="shrink-0 font-mono text-danger">[high]</span>;
  }
  return <span className="shrink-0 font-mono text-sub">[委派]</span>;
}

/** v2.5 子智能体条目（主对话流一行：名称 + 状态；点击在右侧栏打开完整消息流详情 tab） */
function SubagentEntry({ subagentId }: { subagentId: string }) {
  const thread = useStore((s) => s.subagentThreads[subagentId]);
  if (!thread) return null;
  const running = thread.status === "running";
  return (
    <button
      className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-info/25 bg-info-soft/50 px-2.5 py-1.5 text-left transition-colors hover:border-info/50 hover:bg-info-soft"
      onClick={() => {
        useStore.getState().openRightTab({ id: `subagent:${thread.id}`, kind: "subagent", label: thread.name, subagentId: thread.id });
        // v3.0 UI 审查：右侧栏折叠（56px rail）时点击也要展开——否则无任何反馈
        useStore.getState().setDetailsOpen(true);
      }}
      title="点击在右侧栏查看子智能体完整运行过程"
    >
      <Bot className="h-3.5 w-3.5 shrink-0 text-info" strokeWidth={2} />
      <span className="shrink-0 text-[13px] font-medium text-info">子智能体 · {thread.name}</span>
      {thread.model && <span className="shrink-0 font-mono text-[11px] text-sub">{thread.model}</span>}
      <span className="min-w-0 flex-1 truncate text-[12px] text-sub/80">{thread.prompt}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-[12px]">
        {running ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin text-ongoing" />
            <span className="text-ongoing">运行中</span>
          </>
        ) : thread.ok ? (
          <>
            <Check className="h-3.5 w-3.5 text-success" />
            <span className="text-success">完成（{thread.steps} 步 / {thread.toolCount} 次工具）</span>
          </>
        ) : (
          <>
            <X className="h-3.5 w-3.5 text-danger" />
            <span className="text-danger">异常</span>
          </>
        )}
      </span>
      <span className="shrink-0 text-[12px] text-sub">查看详情 →</span>
    </button>
  );
}

/** 工具行（主流 ToolRow：24px 单行 = 图标槽 + 标题 + 2×2 点 + 摘要 + 状态；展开 IN/OUT 卡片）
 *  v2.14：per-tool 平铺（去掉步骤卡片嵌套）；运行中 = 图标 + 扫光；失败 = 红点；成功无标记；
 *  文件工具摘要 = 可点击路径链接（打开代码界面定位，主流 fileLink 同语义） */
const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file", "read_files"]);
function ToolRow({ t }: { t: ToolEventState }) {
  const [open, setOpen] = useState(t.status === "running");
  const Icon = TOOL_ICON[t.tool] ?? Wrench;
  const running = t.status === "running";
  const failed = t.status === "error";
  const stats = t.diff;
  // v2.14：文件工具摘要 = 路径链接（打开代码界面定位）
  const argPath =
    FILE_TOOLS.has(t.tool)
      ? String((t.args as Record<string, unknown>)?.path ?? "")
        || (Array.isArray((t.args as Record<string, unknown>)?.paths) ? String((t.args as { paths?: unknown[] }).paths?.[0] ?? "") : "")
      : "";
  const openFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    const st = useStore.getState();
    st.setCodeViewFile(argPath);
    st.setViewMode("code");
  };
  return (
    <div>
      <button
        className={`group/row flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-lg px-1 text-left transition-colors ${
          running ? "glare-sweep" : ""
        } ${failed ? "hover:bg-danger-soft/50" : ""}`}
        onClick={() => setOpen(!open)}
        data-state={running ? "running" : failed ? "error" : "ok"}
      >
        {failed ? (
          /* 主流 StateDot：失败 = 红色圆点替换图标 */
          <span className="h-2 w-2 shrink-0 rounded-full bg-danger" />
        ) : (
          <Icon className={`h-3.5 w-3.5 shrink-0 transition-all duration-150 group-hover/row:-translate-y-px group-hover/row:text-info ${running ? "text-ongoing" : "text-sub"}`} strokeWidth={2} />
        )}
        <span className="shrink-0 font-mono text-[14px] leading-6 text-text/90 transition-all duration-150 group-hover/row:-translate-y-px group-hover/row:text-text">{t.tool}</span>
        <span className="dot-sep mx-2 shrink-0" />
        {/* v3.2 对齐 主流 errorSummary：失败时用错误首行顶替参数摘要（错误色），不再展示原参数 */}
        {failed && t.summary ? (
          <span className="min-w-0 flex-1 truncate text-left font-mono text-[13px] leading-6 text-danger">
            {t.summary.split("\n")[0]}
          </span>
        ) : argPath ? (
          /* v2.14：文件路径链接（span 而非 button——工具行本身是 button，嵌套 button 非法 HTML 触发 hydration 警告） */
          <span
            className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[13px] leading-6 text-info underline decoration-info/30 underline-offset-3 transition-colors hover:decoration-info"
            onClick={openFile}
            title={`在代码界面打开 ${argPath}`}
          >
            {argPath}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] leading-6 text-sub transition-all duration-150 group-hover/row:-translate-y-px group-hover/row:text-text">{fmtArgs(t.args)}</span>
        )}
        {stats && (
          <span className="shrink-0 font-mono text-[12px]">
            {stats.added > 0 && <span className="text-success">+{stats.added}</span>}
            {stats.added > 0 && stats.removed > 0 && <span className="text-sub/40"> </span>}
            {stats.removed > 0 && <span className="text-danger">-{stats.removed}</span>}
          </span>
        )}
        {t.tool === "delegate_task" && <DelegateRiskBadge subagentId={t.subagentId} />}
        {running && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-ongoing" />}
      </button>
      {open && (
        <div className="ml-[22px] mt-1 space-y-1.5">
          {t.subagentId && <SubagentEntry subagentId={t.subagentId} />}
          <CodeBlock label="IN" text={JSON.stringify(t.args, null, 2)} maxHeight={150} />
          {t.summary && (
            <CodeBlock label={failed ? "OUT（错误）" : "OUT"} text={t.summary} maxHeight={224} />
          )}
        </div>
      )}
    </div>
  );
}

/** Timeline 执行记录（v2.14：per-tool 平铺——与 主流 ToolCallTree 同构，无步骤卡片分组） */
export default function Timeline({ tools }: { tools: ToolEventState[] }) {
  if (!tools.length) return null;
  return (
    <div className="space-y-0.5">
      {tools.map((t) => (
        <ToolRow key={t.id} t={t} />
      ))}
    </div>
  );
}
