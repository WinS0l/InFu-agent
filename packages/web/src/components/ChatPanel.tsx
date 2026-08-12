import { useEffect, useRef, useState } from "react";
import {
  Send, Bot, User, Sparkles, Square, GitBranch, GitMerge, Trash2, Loader2,
  FolderPlus, FlaskConical, SearchCode, Puzzle, ArrowLeft, Check,
  Workflow, Zap, MessageSquareText, RotateCcw,
} from "lucide-react";import { Streamdown } from "streamdown";
import type { TaskTemplate, PhaseId } from "@infu/shared";
import { renderTemplate } from "@infu/shared";
import { useStore } from "../store";
import type { ChatMode } from "../store";
import { sendChat, mergeWorktree, discardWorktree, fetchTemplates, rewindSession } from "../api";
import Timeline from "./Timeline";
import ReasoningBlock from "./ReasoningBlock";
import PlanCard from "./PlanCard";

/** 任务模式三档（对齐 Cursor/Copilot 模式切换；Shift+Tab 循环） */
const MODES: Array<{ id: ChatMode; label: string; icon: React.ElementType; title: string }> = [
  { id: "orchestrate", label: "编排", icon: Workflow, title: "分层编排：Planner 规划（需确认）→ 执行 → Reviewer 审查" },
  { id: "direct", label: "直接", icon: Zap, title: "直接执行：单 Agent 直跑，不做计划与审查" },
  { id: "ask", label: "方案", icon: MessageSquareText, title: "只出方案：模型不执行任何工具，仅输出方案建议" },
];
const MODE_CYCLE: ChatMode[] = ["orchestrate", "direct", "ask"];

/** 模板卡片图标（按模板 id） */
const TEMPLATE_ICON: Record<string, React.ElementType> = {
  "init-project": FolderPlus,
  "fix-tests": FlaskConical,
  analyze: SearchCode,
  "add-feature": Puzzle,
};

/** 编排阶段徽标 */
const PHASE_BADGE: Record<PhaseId, { label: string; cls: string }> = {
  planner: { label: "规划", cls: "border-warn/40 bg-warn/10 text-warn" },
  executor: { label: "执行", cls: "border-accent/40 bg-accent/10 text-accent" },
  reviewer: { label: "审查", cls: "border-[#38bdf8]/40 bg-[#38bdf8]/10 text-[#38bdf8]" },
};

/** 结构化文本块渲染（交付报告 / 审查意见共用） */
function StructuredBlock({ content, tone }: { content: string; tone: "accent" | "sky" }) {
  const headCls = tone === "accent" ? "text-accent" : "text-[#38bdf8]";
  return (
    <div className={`mt-3 rounded-lg border p-3 ${tone === "accent" ? "border-accent/30 bg-muted/40" : "border-[#38bdf8]/30 bg-[#38bdf8]/5"}`}>
      {content.split("\n").map((line, i) => {
        if (line.startsWith("## ")) {
          return (
            <div key={i} className={`mb-1 mt-2 text-sm font-semibold first:mt-0 ${headCls}`}>
              {line.slice(3)}
            </div>
          );
        }
        if (line.startsWith("### ")) {
          return (
            <div key={i} className="mb-1 mt-2 text-xs font-semibold text-text">
              {line.slice(4)}
            </div>
          );
        }
        if (line.startsWith("- ")) {
          return (
            <div key={i} className="pl-3 text-xs leading-relaxed text-text/85">
              • {line.slice(2)}
            </div>
          );
        }
        if (line.startsWith("**")) {
          return (
            <div key={i} className="mb-1 text-xs leading-relaxed text-text/90">
              {line.replace(/\*\*/g, "")}
            </div>
          );
        }
        return line.trim() ? (
          <div key={i} className="text-xs leading-relaxed text-sub">
            {line}
          </div>
        ) : (
          <div key={i} className="h-1" />
        );
      })}
    </div>
  );
}

/** 中间栏：对话 + 工具过程 + 输入框 */
export default function ChatPanel() {
  const { messages, running, abortRun, worktree, worktreeNote, root, clearWorktree, mode, setMode, plan, useWorktree, setUseWorktree, activeSessionId } = useStore();
  const [input, setInput] = useState("");
  const [wtBusy, setWtBusy] = useState(false);
  const [wtMsg, setWtMsg] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  // 模板任务（小白引导）：空态欢迎面板
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [selectedTpl, setSelectedTpl] = useState<TaskTemplate | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  // Rewind（微信撤回式）：点「回滚到此」进入待定态——消息不立即删除，
  // 编辑后发送 = 提交回滚（截断+重发），点「取消回滚」= 恢复原样
  const { pendingRollback, setPendingRollback, clearPendingRollback } = useStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /** 进入回滚待定态：锚点 = 被点轮次对应的最后一条用户消息（编辑重发 = 替换它），
   *  该用户消息及之后全部进入待回滚；输入框填充该消息原文 */
  const askRewind = (seq: number) => {
    if (!activeSessionId || running || pendingRollback) return;
    const idx = messages.findIndex((m) => m.role === "assistant" && (m.seqStart ?? Infinity) >= seq);
    // 回滚锚点：该轮之前最后一条用户消息（user-message 事件 seq）；无则退回该轮 step-start
    let anchorIdx = idx >= 0 ? idx : messages.length;
    let anchorSeq = seq;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].seqStart != null) {
        anchorIdx = i;
        anchorSeq = messages[i].seqStart!;
        break;
      }
    }
    const count = messages.length - anchorIdx;
    const fillText = messages[anchorIdx]?.role === "user" ? messages[anchorIdx].text : "";
    setPendingRollback({ seq: anchorSeq, count, fillText });
    setInput(fillText);
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    });
  };

  /** 取消回滚：恢复原样（消息不变、输入框清空） */
  const cancelRollback = () => {
    clearPendingRollback();
    setInput("");
  };

  /** 提交任务；待定态下先提交回滚（截断服务端事件）再发送新消息 */
  const submit = async () => {
    const text = input.trim();
    if (!text || running) return;
    if (pendingRollback && activeSessionId) {
      try {
        await rewindSession(activeSessionId, pendingRollback.seq);
        clearPendingRollback();
      } catch (e) {
        useStore.getState().addError(`回滚提交失败: ${(e as Error).message}`);
        return; // 回滚失败不发送
      }
    }
    setInput("");
    sendChat(text);
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 加载模板列表（服务未就绪时静默失败，面板显示基础入口）
  useEffect(() => {
    fetchTemplates().then(setTemplates).catch(() => {});
  }, []);

  /** 模板一键开跑：无字段直接发；有字段先进内联表单 */
  const pickTemplate = (tpl: TaskTemplate) => {
    if (tpl.fields?.length) {
      setSelectedTpl(tpl);
      setFieldValues(Object.fromEntries(tpl.fields.map((f) => [f.name, f.default ?? ""])));
    } else {
      sendChat(renderTemplate(tpl, {}));
    }
  };

  const submitTemplate = () => {
    if (!selectedTpl || running) return;
    // 必填字段校验：占位符未填则拦截
    const missing = selectedTpl.fields?.some((f) => !(fieldValues[f.name] ?? "").trim());
    if (missing) return;
    sendChat(renderTemplate(selectedTpl, fieldValues));
    setSelectedTpl(null);
  };

  const doMerge = async () => {
    if (!worktree) return;
    setWtBusy(true);
    setWtMsg("");
    try {
      const r = await mergeWorktree(root, worktree.name);
      setWtMsg(r.message || "已合并");
      clearWorktree();
    } catch (e) {
      setWtMsg((e as Error).message);
    } finally {
      setWtBusy(false);
    }
  };

  const doDiscard = async () => {
    if (!worktree) return;
    setWtBusy(true);
    setWtMsg("");
    try {
      const r = await discardWorktree(root, worktree.name);
      setWtMsg(r.message || "已丢弃");
      clearWorktree();
    } catch (e) {
      setWtMsg((e as Error).message);
    } finally {
      setWtBusy(false);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {/* 消息区 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 回滚待定态：被回滚消息顶部标记条 */}
        {pendingRollback && (
          <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-xs text-warn">
            <RotateCcw className="h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              待回滚 {pendingRollback.count} 条消息——编辑后发送将替换，或取消回滚
            </span>
            <button
              className="shrink-0 cursor-pointer rounded border border-line bg-muted px-2 py-0.5 text-[11px] text-text transition-colors hover:border-warn/60 hover:text-warn"
              onClick={cancelRollback}
            >
              取消回滚
            </button>
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-panel-2 text-accent">
              <Sparkles className="h-7 w-7" />
            </div>
            <div>
              <div className="text-lg font-semibold">InFu 软件工程智能体</div>
              <div className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-sub">
                用自然语言描述你的开发任务，InFu 会规划方案、修改代码并验证测试。新手可以直接用下面的模板一键开跑：
              </div>
            </div>

            {/* 模板任务卡片（小白引导） */}
            {selectedTpl ? (
              <div className="w-full max-w-md rounded-xl border border-accent/30 bg-panel p-4 text-left">
                <div className="mb-3 flex items-center gap-2">
                  <button
                    className="flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-sub transition-colors hover:border-accent hover:text-accent"
                    onClick={() => setSelectedTpl(null)}
                    title="返回模板列表"
                  >
                    <ArrowLeft className="h-3 w-3" />
                    返回
                  </button>
                  <span className="text-sm font-semibold text-text">{selectedTpl.name}</span>
                </div>
                <div className="space-y-3">
                  {selectedTpl.fields?.map((f) => (
                    <label key={f.name} className="block">
                      <span className="mb-1 block text-xs text-sub">{f.label}</span>
                      <input
                        className="h-9 w-full rounded-md border border-line bg-muted px-2 text-sm text-text placeholder:text-sub/60 focus:border-accent/60 focus:outline-none"
                        placeholder={f.placeholder}
                        value={fieldValues[f.name] ?? ""}
                        onChange={(e) => setFieldValues((v) => ({ ...v, [f.name]: e.target.value }))}
                        autoFocus
                      />
                    </label>
                  ))}
                </div>
                <button
                  className="mt-4 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-accent/90 py-2 text-sm font-medium text-ink transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={submitTemplate}
                  disabled={running || selectedTpl.fields?.some((f) => !(fieldValues[f.name] ?? "").trim())}
                >
                  <Check className="h-4 w-4" />
                  开始任务
                </button>
              </div>
            ) : (
              <div className="grid w-full max-w-2xl grid-cols-2 gap-2.5">
                {templates.map((tpl) => {
                  const Icon = TEMPLATE_ICON[tpl.id] ?? Sparkles;
                  return (
                    <button
                      key={tpl.id}
                      className="group flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border border-line bg-panel p-3.5 text-left transition-colors duration-150 hover:border-accent/60 hover:bg-panel-2"
                      onClick={() => pickTemplate(tpl)}
                      title={tpl.description}
                    >
                      <span className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-accent" strokeWidth={2} />
                        <span className="text-sm font-semibold text-text group-hover:text-accent">
                          {tpl.name}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-[11px] leading-relaxed text-sub">
                        {tpl.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {messages.map((m, idx) => {
          // 待回滚范围：锚点消息（用户消息或该轮）起的所有消息（变灰 + 标记）
          const rmIdx = pendingRollback
            ? messages.findIndex((x) => (x.seqStart ?? Infinity) >= pendingRollback.seq)
            : -1;
          const pending = rmIdx >= 0 && idx >= rmIdx;
          return (
          <div key={m.id} className={`group border-b border-line/40 px-4 py-3 transition-opacity duration-200 ${pending ? "opacity-40" : ""}`}>
            {pending && (
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-warn">
                <RotateCcw className="h-2.5 w-2.5" />
                待回滚
              </div>
            )}
            <div className="mb-1.5 flex items-center gap-2">
              {m.role === "user" ? (
                <>
                  <User className="h-4 w-4 text-sub" />
                  <span className="text-xs font-semibold text-text">你</span>
                </>
              ) : (
                <>
                  <Bot className="h-4 w-4 text-accent" />
                  <span className="text-xs font-semibold text-text">Infu</span>
                  {m.phase && (
                    <span className={`rounded-full border px-1.5 py-px text-[10px] font-medium ${PHASE_BADGE[m.phase].cls}`}>
                      {PHASE_BADGE[m.phase].label}
                    </span>
                  )}
                  {/* v2.1 Rewind：回滚到该轮检查点（悬停出现；进入待定态，编辑发送后替换） */}
                  {m.seqStart != null && !running && !pendingRollback && (
                    <button
                      className="ml-auto hidden items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-sub transition-colors duration-150 hover:border-warn/60 hover:text-warn group-hover:flex"
                      onClick={() => askRewind(m.seqStart!)}
                      title="回滚到该轮：消息进入待回滚状态，编辑发送后替换，可取消"
                    >
                      <RotateCcw className="h-2.5 w-2.5" />
                      回滚到此
                    </button>
                  )}
                </>
              )}
            </div>

            {m.role === "user" ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-text">{m.text}</div>
            ) : (
              <>
                {/* 思考过程（折叠） */}
                {m.reasoning && <ReasoningBlock text={m.reasoning} />}
                {/* Timeline 执行记录（阶段分组） */}
                {m.tools.length > 0 && <Timeline tools={m.tools} />}
                {/* 回答文本（流式 Markdown 块渲染：代码骨架→完整块） */}
                {m.text && (
                  <div className={`text-sm leading-relaxed ${m.streaming ? "stream-cursor" : ""}`}>
                    <Streamdown
                      children={m.text}
                      mode="streaming"
                      parseIncompleteMarkdown
                      className="infu-md"
                    />
                  </div>
                )}
                {/* 审查意见（Reviewer 最终输出） */}
                {m.review && <StructuredBlock content={m.review} tone="sky" />}
                {/* 交付报告（结构化） */}
                {m.report && <StructuredBlock content={m.report} tone="accent" />}
                {m.streaming && !m.text && m.tools.length === 0 && (
                  <div className="flex items-center gap-2 text-xs text-sub">
                    <Bot className="h-3.5 w-3.5 animate-pulse" />
                    正在思考…
                  </div>
                )}
              </>
            )}
          </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* 任务工作树操作条（任务在独立副本中执行完后显示） */}
      {(worktree || worktreeNote) && (
        <div className="shrink-0 border-t border-accent/25 bg-accent/5 px-4 py-2">
          {worktree ? (
            <div className="flex items-center gap-2 text-xs">
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-text/85">
                任务在独立工作树中执行：<span className="font-mono text-accent">{worktree.name}</span>
                <span className="ml-1 text-sub">（主代码未被改动）</span>
              </span>
              {wtMsg && <span className="max-w-40 truncate text-warn">{wtMsg}</span>}
              <button
                className="flex cursor-pointer items-center gap-1 rounded-md border border-accent/50 bg-accent/15 px-2.5 py-1 font-medium text-accent transition-colors duration-150 hover:bg-accent/25 disabled:opacity-50"
                onClick={doMerge}
                disabled={wtBusy}
                title="把任务改动合并回主分支"
              >
                {wtBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3 w-3" />}
                合并到主分支
              </button>
              <button
                className="flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1 text-sub transition-colors duration-150 hover:border-danger/60 hover:text-danger disabled:opacity-50"
                onClick={doDiscard}
                disabled={wtBusy}
                title="丢弃任务改动（主代码不受影响）"
              >
                <Trash2 className="h-3 w-3" />
                丢弃
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-warn">
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              {worktreeNote || "任务工作树已清理"}
            </div>
          )}
        </div>
      )}

      {/* 计划卡片（Planner 输出 → 可编辑 → 批准/拒绝后执行；按 id 重挂载保证编辑态同步） */}
      <PlanCard key={plan?.id ?? "none"} />

      {/* 输入区 */}
      <div className="shrink-0 border-t border-line bg-panel p-3">
        {/* 任务模式三档（Shift+Tab 循环切换） */}
        <div className="mb-2 flex items-center gap-1">
          {MODES.map((m) => {
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                className={`flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors duration-150 ${
                  active
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-transparent text-sub hover:border-line hover:text-text"
                }`}
                onClick={() => setMode(m.id)}
                title={m.title}
              >
                <m.icon className="h-3 w-3" strokeWidth={2} />
                {m.label}
              </button>
            );
          })}
          <span className="ml-auto text-[10px] text-sub/50">Shift+Tab 切换模式</span>
        </div>
        <div className="flex items-end gap-2 rounded-lg border border-line bg-muted p-2 transition-colors focus-within:border-accent/60">
          <textarea
            ref={inputRef}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-1 text-sm text-text placeholder:text-sub/60 focus:outline-none"
            placeholder={
              mode === "orchestrate"
                ? "描述任务：Planner 先出计划，确认后执行并审查"
                : mode === "direct"
                  ? "描述任务：直接执行，不做计划与审查"
                  : "描述问题：只输出方案建议，不执行任何工具"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && e.shiftKey) {
                e.preventDefault();
                setMode(MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
          />
          <button
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md bg-accent/90 text-ink transition-all duration-150 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            onClick={running ? abortRun : submit}
            disabled={!running && !input.trim()}
            title={running ? "停止任务" : "发送 (Enter)"}
          >
            {running ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
        {/* 底部：快捷键提示（左） + 任务工作树开关（右，每任务独立 git worktree 副本） */}
        <div className="mt-1 flex items-center gap-2 px-1">
          <span className="text-[10px] text-sub/60">
            Enter 发送 · Shift+Enter 换行 · 运行中点击方块停止任务
          </span>
          <button
            className={`ml-auto flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors duration-150 ${
              useWorktree
                ? "border-accent/50 bg-accent/10 text-accent"
                : "border-line bg-muted text-sub hover:text-text"
            }`}
            onClick={() => setUseWorktree(!useWorktree)}
            title="开启后每个任务在独立工作树副本中执行，主代码零污染，完成后可合并或丢弃"
          >
            <GitBranch className="h-3 w-3" />
            {useWorktree ? "工作树开" : "工作树关"}
          </button>
        </div>
      </div>
    </main>
  );
}
