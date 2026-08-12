import {
  FileText, FilePen, Scissors, Search, FolderOpen, Terminal,
  GitBranch, GitCompare, FlaskConical, Building2, Wrench, Loader2, Check, X,
} from "lucide-react";
import type { ToolEventState } from "../store";

const RISK_COLOR: Record<string, string> = {
  low: "text-sub",
  medium: "text-warn",
  high: "text-danger",
};

const TOOL_ICON: Record<string, React.ElementType> = {
  read_file: FileText,
  write_file: FilePen,
  edit_file: Scissors,
  search_code: Search,
  list_directory: FolderOpen,
  run_command: Terminal,
  git_status: GitBranch,
  git_diff: GitCompare,
  run_test: FlaskConical,
  project_scan: Building2,
};

function fmtArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 40 ? s.slice(0, 40) + "…" : s}`;
    });
  return entries.join("  ");
}

/** 工具调用卡片（中间对话流内展示） */
export default function ToolCard({ tool }: { tool: ToolEventState }) {
  const running = tool.status === "running";
  const Icon = TOOL_ICON[tool.tool] ?? Wrench;
  return (
    <div
      className={`my-1 rounded-md border bg-muted/60 text-[11px] ${
        running
          ? "tool-running border-accent/40"
          : tool.status === "ok"
            ? "border-line"
            : "border-danger/40"
      }`}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-sub" strokeWidth={2} />
        <span className="font-mono font-semibold text-text">{tool.tool}</span>
        <span className={`font-mono ${RISK_COLOR[tool.risk] ?? "text-sub"}`}>[{tool.risk}]</span>
        <span className="min-w-0 flex-1 truncate font-mono text-sub">{fmtArgs(tool.args)}</span>
        <span className="shrink-0">
          {running ? (
            <span className="flex items-center gap-1 text-accent">
              <Loader2 className="h-3 w-3 animate-spin" />
              执行中
            </span>
          ) : tool.status === "ok" ? (
            <Check className="h-3.5 w-3.5 text-accent" />
          ) : (
            <X className="h-3.5 w-3.5 text-danger" />
          )}
        </span>
      </div>
      {tool.summary && tool.status !== "running" && (
        <div className="max-h-24 overflow-y-auto border-t border-line/60 px-2 py-1 font-mono text-[10px] leading-relaxed text-sub">
          {tool.summary}
        </div>
      )}
    </div>
  );
}
