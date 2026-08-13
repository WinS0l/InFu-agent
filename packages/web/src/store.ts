import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentEvent, ModelConfig, PhaseId, SessionMeta, StoredEvent } from "@infu/shared";

/** 任务模式（三档选择器，对齐 Cursor/Copilot 的模式切换） */
export type ChatMode = "orchestrate" | "direct" | "ask";

/** 单条消息（含其触发的工具调用与交付报告） */
export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  tools: ToolEventState[];
  report?: string;
  /** 思考过程（reasoning 流式追加） */
  reasoning?: string;
  /** 所属编排阶段（planner/executor/reviewer，Timeline 与徽标分组） */
  phase?: PhaseId;
  /** 审查意见（Reviewer 最终输出，独立渲染块） */
  review?: string;
  /** v2.2 模型降级记录（主模型失败 → 备用模型；Timeline 上方徽标） */
  fallbacks?: Array<{ from: string; to: string; reason: string }>;
  /** v2.2 上下文压缩记录（历史超预算自动摘要；DB 无损） */
  compressed?: Array<{ before: number; after: number; summary: string }>;
  /** v2.1：该轮第一条事件的 seq（Rewind 回滚锚点；历史重放时标记） */
  seqStart?: number;
}

/** 工具事件状态（UI 呈现） */
export interface ToolEventState {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  risk: string;
  status: "running" | "ok" | "error";
  summary?: string;
  output?: string; // 完整输出（git_diff 等用于右侧面板）
  /** 所属阶段（Timeline 分组） */
  step: number;
  /** 所属编排阶段（阶段内 step 重新编号，分组需复合键） */
  phase?: PhaseId;
  /** 开始时间戳（思考耗时计算） */
  startedAt: number;
}

export interface ApprovalState {
  id: string;
  description: string;
  risk: string;
}

interface StoreState {
  models: ModelConfig[];
  modelId: string;
  root: string;
  messages: ChatMsg[];
  running: boolean;
  /** 审批队列（Agent 可能并发发起多个审批，逐个排队处理） */
  approvals: ApprovalState[];
  /** 当前阶段号（Timeline 分组） */
  currentStep: number;
  /** 各阶段开始时间戳（思考耗时计算，键 = 阶段:步骤 复合键） */
  stepStartTimes: Record<string, number>;
  /** 右侧面板：最近一次 git diff 输出 */
  diffContent: string;
  /** 右侧面板：本次任务的文件修改摘要 */
  fileChanges: string[];
  /** 当前任务来源模板 id（v2.2 动态步数启发式参考；null = 普通任务） */
  templateId: string | null;
  /** 各编排阶段使用的模型（v2.2 角色路由可视化：Timeline 阶段头展示） */
  phaseModels: Partial<Record<PhaseId, string>>;
  /** v2 思考级别（4 档 UI，按模型实际级别数自动映射；1-4，默认 2） */
  thinkingLevel: number;

  setModels: (models: ModelConfig[]) => void;
  setModelId: (id: string) => void;
  setRoot: (root: string) => void;
  setTemplateId: (id: string | null) => void;
  setThinkingLevel: (level: number) => void;
  /** v2.1 会话：列表 + 当前会话 */
  sessions: SessionMeta[];
  activeSessionId: string | null;
  setSessions: (s: SessionMeta[]) => void;
  setActiveSessionId: (id: string | null) => void;
  /** 新建会话：清空聊天区并脱离当前会话（下一轮任务由服务端新建） */
  newSession: () => void;
  /** 加载历史会话（事件流重放为消息；跳过 plan/审批交互事件） */
  loadSession: (events: StoredEvent[]) => void;
  /**
   * v2.1 Rewind 待定态（微信撤回式）：点「回滚到此」后不立即删除，
   * 消息进入待回滚状态；编辑发送 = 提交回滚（截断+重发），取消 = 恢复原样。
   */
  pendingRollback: { seq: number; count: number; fillText: string } | null;
  setPendingRollback: (p: { seq: number; count: number; fillText: string }) => void;
  clearPendingRollback: () => void;
  addUserMsg: (text: string) => void;
  ensureAssistant: () => ChatMsg;
  appendText: (text: string) => void;
  appendReasoning: (text: string) => void;
  /** v2.2 模型降级记录（徽标展示） */
  appendFallback: (from: string, to: string, reason: string) => void;
  /** v2.2 上下文压缩记录（提示条展示） */
  appendCompressed: (before: number, after: number, summary: string) => void;
  /** 阶段开始：若当前 assistant 消息已有内容则开新消息（每轮 = 一条消息，对齐主流 Agent turn 语义） */
  beginStep: (n: number) => void;
  startTool: (ev: Extract<AgentEvent, { type: "tool-start" }>) => void;
  finishTool: (ev: Extract<AgentEvent, { type: "tool-result" }>) => void;
  setRunning: (r: boolean) => void;
  abortController: AbortController | null;
  setAbortController: (c: AbortController | null) => void;
  abortRun: () => void;
  /** 任务工作树模式（每任务独立 git worktree） */
  useWorktree: boolean;
  setUseWorktree: (v: boolean) => void;
  worktree: { name: string; path: string } | null;
  worktreeNote: string;
  setWorktree: (wt: { name: string; path: string } | null) => void;
  addWorktreeNote: (note: string) => void;
  clearWorktree: () => void;
  /** 分层编排（M4）：开启 = Planner→Executor→Reviewer 三层 */
  orchestrate: boolean;
  setOrchestrate: (v: boolean) => void;
  /** 任务模式（三档：分层编排 / 直接执行 / 只出方案） */
  mode: ChatMode;
  setMode: (m: ChatMode) => void;
  /** 当前编排阶段（phase-start 事件更新，新消息按此打标） */
  currentPhase: PhaseId | null;
  setPhase: (ev: Extract<AgentEvent, { type: "phase-start" }>) => void;
  setReview: (content: string) => void;
  /** 待确认的执行计划（计划卡片，POST /api/plan/:id 决策） */
  plan: { id: string; content: string } | null;
  setPlan: (p: { id: string; content: string } | null) => void;
  clearPlan: () => void;
  requestApproval: (ev: Extract<AgentEvent, { type: "approval-required" }>) => void;
  resolveApproval: (approved: boolean) => void;
  setReport: (content: string) => void;
  finishAssistant: () => void;
  addError: (msg: string) => void;
  reset: () => void;
}

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

/** 阶段+步骤复合键（各阶段 step 独立编号，防止时间戳/分组冲突） */
export function stepKey(phase: PhaseId | null | undefined, step: number): string {
  return `${phase ?? "agent"}:${step}`;
}

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
  models: [],
  modelId: "",
  root: "E:\\InFu(test)",
  messages: [],
  running: false,
  approvals: [],
  sessions: [],
  activeSessionId: null,
  pendingRollback: null,
  useWorktree: true,
  worktree: null,
  worktreeNote: "",
  orchestrate: true,
  currentPhase: null,
  mode: "orchestrate",
  plan: null,
  currentStep: 1,
  stepStartTimes: {},
  diffContent: "",
  fileChanges: [],
  templateId: null,
  phaseModels: {},
  thinkingLevel: 2,

  setModels: (models) => {
    const cur = get().modelId;
    set({
      models,
      modelId: models.some((m) => m.id === cur) ? cur : (models[0]?.id ?? ""),
    });
  },
  setModelId: (id) => set({ modelId: id }),
  setTemplateId: (id) => set({ templateId: id }),
  setThinkingLevel: (level) => set({ thinkingLevel: Math.max(1, Math.min(4, Math.round(level)))}),
  setRoot: (root) => set({ root }),
  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setPendingRollback: (p) => set({ pendingRollback: p }),
  clearPendingRollback: () => set({ pendingRollback: null }),
  newSession: () =>
    set({
      messages: [],
      activeSessionId: null,
      pendingRollback: null,
      running: false,
      approvals: [],
      diffContent: "",
      fileChanges: [],
      currentStep: 1,
      stepStartTimes: {},
      currentPhase: null,
      phaseModels: {},
      plan: null,
    }),

  /** 历史会话重放：事件流 → 消息（复用消息结构，右侧 Diff/文件改动一并恢复） */
  loadSession: (events) => {
    const msgs: ChatMsg[] = [];
    const fileChanges: string[] = [];
    let diffContent = "";
    let cur: ChatMsg | null = null; // 当前 assistant 轮次（每个 step-start 一条）
    let phase: PhaseId | undefined;
    const phaseModels: Partial<Record<PhaseId, string>> = {}; // v2.2 阶段模型记录
    let currentStep = 1;
    for (const { seq, ts, event } of events) {
      switch (event.type) {
        case "user-message":
          // seqStart 记 user-message 事件 seq（回滚锚点：编辑重发 = 替换这条用户消息）
          msgs.push({ id: nextId(), role: "user", text: event.text, tools: [], seqStart: seq });
          cur = null;
          break;
        case "phase-start":
          phase = event.phase;
          if (event.model) phaseModels[event.phase] = event.model;
          cur = null;
          break;
        case "step-start": {
          // 检查点锚点：该轮第一条事件的 seq（Rewind 用）
          cur = { id: nextId(), role: "assistant", text: "", tools: [], phase, seqStart: seq };
          msgs.push(cur);
          currentStep = event.step;
          break;
        }
        case "text":
          if (!cur) { cur = { id: nextId(), role: "assistant", text: "", tools: [], phase }; msgs.push(cur); }
          cur.text += event.text;
          break;
        case "reasoning":
          if (!cur) { cur = { id: nextId(), role: "assistant", text: "", tools: [], phase }; msgs.push(cur); }
          cur.reasoning = (cur.reasoning ?? "") + event.text;
          break;
        case "tool-start": {
          if (!cur) { cur = { id: nextId(), role: "assistant", text: "", tools: [], phase }; msgs.push(cur); }
          cur.tools.push({
            id: `${cur.id}-t${cur.tools.length}-${event.tool}`,
            tool: event.tool,
            args: event.args,
            risk: event.risk,
            status: "running",
            step: currentStep,
            phase,
            startedAt: ts, // 历史时间戳（耗时展示）
          });
          break;
        }
        case "tool-result": {
          if (cur) {
            const t = cur.tools.find((x) => x.status === "running" && x.tool === event.tool);
            if (t) { t.status = event.ok ? "ok" : "error"; t.summary = event.summary; t.output = event.summary; }
          }
          // 恢复右侧面板（与 finishTool 同规则）
          if (event.tool === "git_diff" || /^diff --git/m.test(event.summary)) diffContent = event.summary;
          if (event.tool === "write_file" || event.tool === "edit_file") fileChanges.push(event.summary);
          break;
        }
        case "report":
          if (cur) cur.report = event.content;
          break;
        case "review":
          if (cur) cur.review = event.content;
          break;
        case "done":
          if (cur) { cur.streaming = false; cur.seqStart = cur.seqStart ?? seq; }
          break;
        case "model-fallback":
          // 降级记录附加到当前轮次（徽标展示）；无当前轮则忽略
          if (cur) {
            cur.fallbacks = [...(cur.fallbacks ?? []), { from: event.from, to: event.to, reason: event.reason }];
          }
          break;
        case "context-compressed":
          // 压缩记录附加到当前轮次（提示条展示）；无当前轮则忽略
          if (cur) {
            cur.compressed = [...(cur.compressed ?? []), { before: event.before, after: event.after, summary: event.summary }];
          }
          break;
        case "error":
          msgs.push({ id: nextId(), role: "assistant", text: `⚠️ ${event.message}`, tools: [] });
          cur = null;
          break;
        // 跳过：plan（历史计划已决策，不显示确认卡片）、approval-*、session（非流事件）
      }
    }
    // 收尾：清掉 running 状态工具、streaming 标记
    for (const m of msgs) {
      m.streaming = false;
      for (const t of m.tools) if (t.status === "running") t.status = "error";
    }
    set({
      messages: msgs,
      fileChanges,
      diffContent,
      currentStep,
      stepStartTimes: {},
      currentPhase: null,
      phaseModels,
      plan: null,
      pendingRollback: null,
      running: false,
      approvals: [],
    });
  },

  addUserMsg: (text) =>
    set((s) => ({
      messages: [...s.messages, { id: nextId(), role: "user", text, tools: [] }],
      running: true,
      diffContent: "",
      fileChanges: [],
    })),

  ensureAssistant: () => {
    const s = get();
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === "assistant") return last;
    const msg: ChatMsg = { id: nextId(), role: "assistant", text: "", streaming: true, tools: [] };
    set((st) => ({ messages: [...st.messages, msg] }));
    return msg;
  },

  appendText: (text) =>
    set((s) => {
      // 审查阶段：文本不流式进消息（最终内容由 review 事件独立渲染，避免重复）
      if (s.currentPhase === "reviewer") return s;
      return {
        messages: s.messages.map((m, i) =>
          i === s.messages.length - 1 && m.role === "assistant"
            ? { ...m, text: m.text + text }
            : m
        ),
      };
    }),

  appendReasoning: (text) =>
    set((s) => ({
      messages: s.messages.map((m, i) =>
        i === s.messages.length - 1 && m.role === "assistant"
          ? { ...m, reasoning: (m.reasoning ?? "") + text }
          : m
      ),
    })),

  /** v2.2 模型降级记录：附加到当前 assistant 轮次（徽标展示与审计） */
  appendFallback: (from, to, reason) => {
    const msg = get().ensureAssistant();
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msg.id
          ? { ...m, fallbacks: [...(m.fallbacks ?? []), { from, to, reason }] }
          : m
      ),
    }));
  },

  /** v2.2 上下文压缩记录：附加到当前 assistant 轮次（提示条展示） */
  appendCompressed: (before, after, summary) => {
    const msg = get().ensureAssistant();
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msg.id
          ? { ...m, compressed: [...(m.compressed ?? []), { before, after, summary }] }
          : m
      ),
    }));
  },

  beginStep: (n) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      // 当前最后一条 assistant 消息已有内容（文本/思考/工具）→ 开新消息（新轮次），
      // 并把上一轮消息的 streaming 置 false（结束其闪烁光标）
      const hasContent =
        last?.role === "assistant" &&
        (!!last.text || !!last.reasoning || last.tools.length > 0);
      if (hasContent) {
        msgs[msgs.length - 1] = { ...last, streaming: false };
        msgs.push({ id: nextId(), role: "assistant", text: "", streaming: true, tools: [], phase: s.currentPhase ?? undefined });
      }
      return {
        messages: msgs,
        currentStep: n,
        stepStartTimes: { ...s.stepStartTimes, [stepKey(s.currentPhase, n)]: Date.now() },
      };
    }),

  /** 编排阶段切换：结束上一条消息，开启带阶段标记的新消息 */
  setPhase: (ev) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      const hasContent =
        last?.role === "assistant" &&
        (!!last.text || !!last.reasoning || last.tools.length > 0);
      if (hasContent) msgs[msgs.length - 1] = { ...last, streaming: false };
      msgs.push({ id: nextId(), role: "assistant", text: "", streaming: true, tools: [], phase: ev.phase });
      return {
        messages: msgs,
        currentPhase: ev.phase,
        // v2.2 角色路由可视化：记录该阶段使用的模型（旧会话无 model 字段则忽略）
        phaseModels: ev.model ? { ...s.phaseModels, [ev.phase]: ev.model } : s.phaseModels,
      };
    }),

  setReview: (content) =>
    set((s) => ({
      messages: s.messages.map((m, i) =>
        i === s.messages.length - 1 && m.role === "assistant"
          ? { ...m, review: content }
          : m
      ),
    })),

  startTool: (ev) => {
    const msg = get().ensureAssistant();
    const toolState: ToolEventState = {
      id: `${msg.id}-t${msg.tools.length}-${ev.tool}`,
      tool: ev.tool,
      args: ev.args,
      risk: ev.risk,
      status: "running",
      step: get().currentStep,
      phase: get().currentPhase ?? undefined,
      startedAt: Date.now(),
    };
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msg.id ? { ...m, tools: [...m.tools, toolState] } : m
      ),
    }));
  },

  finishTool: (ev) => {
    const s = get();
    const msg = s.messages[s.messages.length - 1];
    if (!msg || msg.role !== "assistant") return;
    // 收集 diff 输出 → 右侧面板
    if (ev.tool === "git_diff" || /^diff --git/m.test(ev.summary)) {
      set({ diffContent: ev.summary });
    }
    if (ev.tool === "write_file" || ev.tool === "edit_file") {
      set((st) => ({ fileChanges: [...st.fileChanges, ev.summary] }));
    }
    set((st) => ({
      messages: st.messages.map((m) =>
        m.id === msg.id
          ? {
              ...m,
              tools: m.tools.map((t) =>
                t.tool === ev.tool && t.status === "running"
                  ? { ...t, status: ev.ok ? "ok" : "error", summary: ev.summary, output: ev.summary }
                  : t
              ),
            }
          : m
      ),
    }));
  },

  setRunning: (r) => set({ running: r }),
  abortController: null as AbortController | null,
  setAbortController: (c) => set({ abortController: c }),
  abortRun: () => {
    get().abortController?.abort();
    set({ abortController: null });
  },

  setUseWorktree: (v) => set({ useWorktree: v }),
  setOrchestrate: (v) => set({ orchestrate: v }),
  setMode: (m) => set({ mode: m }),
  setPlan: (p) => set({ plan: p }),
  clearPlan: () => set({ plan: null }),
  setWorktree: (wt) => set({ worktree: wt, worktreeNote: "" }),
  addWorktreeNote: (note) => set({ worktreeNote: note }),
  clearWorktree: () => set({ worktree: null, worktreeNote: "" }),

  requestApproval: (ev) =>
    set((s) => ({
      approvals: [...s.approvals, { id: ev.id, description: ev.description, risk: ev.risk }],
    })),

  resolveApproval: (approved) => {
    const a = get().approvals[0];
    if (!a) return;
    // 从队列移除当前审批（弹窗自动显示下一个）
    set((s) => ({ approvals: s.approvals.slice(1) }));
    fetch(`/api/approvals/${a.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved }),
    }).catch(() => {});
  },

  setReport: (content) =>
    set((s) => ({
      messages: s.messages.map((m, i) =>
        i === s.messages.length - 1 && m.role === "assistant"
          ? { ...m, report: content }
          : m
      ),
    })),

  finishAssistant: () =>
    set((s) => ({
      messages: s.messages.map((m, i) =>
        i === s.messages.length - 1 && m.role === "assistant"
          ? { ...m, streaming: false }
          : m
      ),
      running: false,
    })),

  addError: (msg) => {
    get().finishAssistant();
    set((s) => ({
      messages: [
        ...s.messages,
        { id: nextId(), role: "assistant", text: `⚠️ ${msg}`, tools: [] },
      ],
    }));
  },

  reset: () =>
    set({
      messages: [],
      running: false,
      approvals: [],
      diffContent: "",
      fileChanges: [],
      currentStep: 1,
      stepStartTimes: {},
      currentPhase: null,
      plan: null,
    }),
  }),
  {
    name: "infu-chat", // localStorage 持久化（设置项；消息已由 v2.1 服务端会话库托管）
    partialize: (s) => ({
      root: s.root,
      modelId: s.modelId,
      useWorktree: s.useWorktree,
      orchestrate: s.orchestrate,
      mode: s.mode,
      activeSessionId: s.activeSessionId,
    }),
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as Partial<StoreState>;
      // 丢弃持久化的旧 messages（v1 数据由 maybeMigrateV1 单独导入为会话）
      const { messages: _oldMsgs, ...rest } = p;
      return { ...current, ...rest };
    },
  }
));
