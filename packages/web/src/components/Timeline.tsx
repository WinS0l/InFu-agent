import { useState } from "react";
import {
  FileText, FilePen, Scissors, Search, FolderOpen, Terminal,
  GitBranch, GitCompare, FlaskConical, Building2, Wrench, Loader2, Check, X,
  Brain, ChevronDown, ChevronRight,
} from "lucide-react";
import { useStore, stepKey } from "../store";
import type { ToolEventState } from "../store";
import type { PhaseId } from "@infu/shared";

/** 编排阶段标签（Timeline 分组头） */
const PHASE_LABEL: Record<PhaseId, { label: string; cls: string }> = {
  planner: { label: "规划阶段", cls: "text-warn" },
  executor: { label: "执行阶段", cls: "text-accent" },
  reviewer: { label: "审查阶段", cls: "text-[#38bdf8]" },
};

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

/** 从工具结果提取 diff 统计（+N -M） */
function diffStats(summary?: string): string {
  if (!summary) return "";
  const m = summary.match(/[+-]\d+/g);
  return m ? m.join(" ") : "";
}

/** 阶段标题自动概括（按操作优先级） */
function summarizeStep(tools: ToolEventState[]): { title: string; icon: React.ElementType } {
  const edit = tools.filter((t) => t.tool === "edit_file" || t.tool === "write_file");
  if (edit.length) {
    const file = String(edit[0].args.path ?? "文件");
    const stats = edit.map((t) => diffStats(t.summary)).filter(Boolean).join(" · ");
    const isNew = edit[0].tool === "write_file";
    return { title: `${isNew ? "新建" : "编辑"} ${file}${stats ? `（${stats}）` : ""}`, icon: edit[0].tool === "write_file" ? FilePen : Scissors };
  }
  if (tools.some((t) => t.tool === "run_test")) return { title: "运行测试", icon: FlaskConical };
  if (tools.some((t) => t.tool === "run_command")) {
    const cmd = String(tools.find((t) => t.tool === "run_command")?.args.command ?? "").slice(0, 40);
    return { title: `执行命令：${cmd}`, icon: Terminal };
  }
  if (tools.some((t) => t.tool === "search_code")) {
    const n = tools.filter((t) => t.tool === "search_code").length;
    return { title: `搜索定位代码${n > 1 ? `（${n} 次）` : ""}`, icon: Search };
  }
  if (tools.some((t) => t.tool === "git_diff" || t.tool === "git_status")) return { title: "查看 Git 改动", icon: GitCompare };
  if (tools.some((t) => t.tool === "project_scan")) return { title: "分析项目结构", icon: Building2 };
  if (tools.some((t) => t.tool === "list_directory")) return { title: "浏览目录结构", icon: FolderOpen };
  if (tools.some((t) => t.tool === "read_file")) {
    const file = String(tools.find((t) => t.tool === "read_file")?.args.path ?? "文件");
    return { title: `读取 ${file}`, icon: FileText };
  }
  return { title: "执行操作", icon: Wrench };
}

/** Timeline 阶段卡片（单阶段；工具子项默认折叠） */
function StepCard({ step, tools }: { step: number; tools: ToolEventState[] }) {
  const stepStart = useStore((s) => s.stepStartTimes[stepKey(tools[0]?.phase, step)]);
  const [open, setOpen] = useState(tools.some((t) => t.status === "running"));
  const { title, icon: TitleIcon } = summarizeStep(tools);
  // 思考耗时：阶段开始 → 第一个工具开始
  const thoughtMs = tools.length ? tools[0].startedAt - (stepStart ?? tools[0].startedAt) : 0;
  const thought = thoughtMs > 0 ? Math.max(1, Math.round(thoughtMs / 1000)) : 0;
  const hasError = tools.some((t) => t.status === "error");
  const allDone = tools.every((t) => t.status !== "running");

  return (
    <div className={`my-2 rounded-lg border bg-muted/40 ${hasError ? "border-danger/40" : "border-line"}`}>
      {/* 阶段头：标题 + 思考耗时 + 折叠（点击整行切换） */}
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-b border-line/60 px-3 py-2 text-left transition-colors hover:bg-muted/60"
        onClick={() => setOpen(!open)}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
          {step}
        </span>
        <TitleIcon className="h-3.5 w-3.5 shrink-0 text-text" strokeWidth={2} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-text">{title}</span>
        {/* 折叠态显示工具概要 */}
        {!open && (
          <span className="shrink-0 truncate text-[10px] text-sub">
            {tools.length} 个工具 · {tools.map((t) => t.tool).join(", ")}
          </span>
        )}
        {thought > 0 && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-sub">
            <Brain className="h-3 w-3" />
            思考 {thought}s
          </span>
        )}
        <span className="shrink-0 text-sub">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>
      {/* 工具子项（展开时显示） */}
      {open && (
        <div className="px-2 py-1">
          {tools.map((t) => {
            const Icon = TOOL_ICON[t.tool] ?? Wrench;
            const running = t.status === "running";
            return (
              <div key={t.id} className="flex items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-muted/60">
                <Icon className="h-3.5 w-3.5 shrink-0 text-sub" strokeWidth={2} />
                <span className="w-24 shrink-0 font-mono text-text/90">{t.tool}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-sub">{fmtArgs(t.args)}</span>
                {diffStats(t.summary) && (
                  <span className="shrink-0 font-mono text-accent">{diffStats(t.summary)}</span>
                )}
                <span className={`shrink-0 font-mono ${RISK_COLOR[t.risk] ?? "text-sub"}`}>[{t.risk}]</span>
                <span className="shrink-0">
                  {running ? (
                    <span className="flex items-center gap-1 text-accent">
                      <Loader2 className="h-3 w-3 animate-spin" />
                    </span>
                  ) : t.status === "ok" ? (
                    <Check className="h-3.5 w-3.5 text-accent" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-danger" />
                  )}
                </span>
              </div>
            );
          })}
          {allDone && (
            <button
              className="mt-1 w-full cursor-pointer rounded px-2 py-1 text-left text-[10px] text-sub/60 transition-colors hover:text-sub"
              onClick={() => setOpen(false)}
            >
              收起
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Timeline 执行记录（按阶段分组展示工具过程） */
export default function Timeline({ tools }: { tools: ToolEventState[] }) {
  // v2.2 角色路由可视化：各阶段实际使用的模型（phase-start 事件记录）
  const phaseModels = useStore((s) => s.phaseModels);
  // 按 阶段+step 复合键分组（各阶段 step 独立编号）
  const groups = new Map<string, ToolEventState[]>();
  const order: string[] = [];
  for (const t of tools) {
    const key = stepKey(t.phase, t.step);
    if (!groups.has(key)) order.push(key);
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }
  if (!order.length) return null;

  // 阶段标签：与上一组阶段不同时显示分组头
  let lastPhase: PhaseId | undefined;
  const steps = order.map((key) => {
    const ts = groups.get(key)!;
    const phase = ts[0].phase;
    const showHeader = phase !== lastPhase;
    lastPhase = phase;
    return { key, step: ts[0].step, phase, tools: ts, showHeader };
  });

  return (
    <div className="mb-2">
      {/* 时间轴竖线 */}
      <div className="relative space-y-1 pl-1">
        {steps.map(({ key, step, phase, tools: ts, showHeader }) => (
          <div key={key}>
            {showHeader && phase && (
              <div className={`mb-1 mt-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${PHASE_LABEL[phase]?.cls ?? "text-sub"}`}>
                {PHASE_LABEL[phase]?.label ?? phase}
                {/* v2.2 阶段模型（角色路由后） */}
                {phaseModels[phase] && (
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal text-sub">
                    {phaseModels[phase]}
                  </span>
                )}
                <span className="h-px flex-1 bg-line/50" />
              </div>
            )}
            <StepCard step={step} tools={ts} />
          </div>
        ))}
      </div>
    </div>
  );
}
