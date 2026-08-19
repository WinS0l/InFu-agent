import { create } from "zustand";
import { persist } from "zustand/middleware";
import { apiFetch } from "./api";
import type { AgentEvent, ApprovalMode, AttachmentMeta, ModelConfig, PhaseId, SessionMeta, StoredEvent } from "@infu/shared";

/** 单条消息（含其触发的工具调用与交付报告） */
export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  /** v3：消息时间戳（用户消息 hover 操作行时间显示；历史重放用事件 ts） */
  ts?: number;
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
  /** v3.3 后台任务完成通知（task-notification 事件；EventRow 通知行——对齐 ZCode） */
  taskNotes?: Array<{
    taskType: "subagent" | "job";
    taskId: string;
    name: string;
    status: "completed" | "failed" | "stopped" | "killed";
    summary: string;
  }>;
  /** v2.1：该轮第一条事件的 seq（Rewind 回滚锚点；历史重放时标记） */
  seqStart?: number;
  /** v3.1：用户消息附加的文件/文件夹/图片（attachments 事件挂载；渲染附件行） */
  attachments?: AttachmentMeta[];
  /** v3.1：turn 结束时间戳（finishAssistant 记录；turn 尾操作行「· 运行 Xs」） */
  endedAt?: number;
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
  /** 本次写工具成功操作的结构化行级增删（服务端计算，非文本正则猜测） */
  diff?: { added: number; removed: number };
  /** 所属阶段（Timeline 分组） */
  step: number;
  /** 所属编排阶段（阶段内 step 重新编号，分组需复合键） */
  phase?: PhaseId;
  /** 开始时间戳（思考耗时计算） */
  startedAt: number;
  /** v2.5：模型工具调用 id（subagent-start 的 parentCallId 关联委派条目锚点） */
  callId?: string;
  /** v2.5：所属子智能体 id（delegate_task 条目挂载；主对话流点击打开右侧栏详情） */
  subagentId?: string;
}

/**
 * 子智能体消息（右侧栏弹窗消息流；与父 Agent 消息同构：思考/文本/工具过程）
 */
export interface SubagentMsg {
  id: string;
  text: string;
  reasoning?: string;
  tools: ToolEventState[];
  step: number;
}

/**
 * 子智能体完整线程（v2.5 返工：对齐主流——子 Agent 独立会话视图，
 * 右侧栏弹窗展示完整消息流；主对话流只显示派出条目，点击打开）
 */
export interface SubagentThread {
  id: string;
  name: string;
  model?: string;
  prompt: string;
  status: "running" | "done" | "error";
  ok?: boolean;
  steps: number;
  toolCount: number;
  /** 最终摘要（subagent-done 携带） */
  summary: string;
  /** 只读委派（免审批）标记：主对话流徽标展示用（只读 → 绿色「只读」，写能力 → [high]） */
  readOnly?: boolean;
  messages: SubagentMsg[];
}

export interface ApprovalState {
  id: string;
  description: string;
  risk: string;
  /** v3.5 修复：审批所属会话（bypass/批量决策按会话归属——多会话并行时不再错会话） */
  sessionId?: string;
}

/** v2.6 收尾：Agent 执行中提问（ask_user 工具）弹窗状态；v2.10 支持多选/描述/结构化选项 */
export interface AskOption {
  label: string;
  desc?: string;
  recommended?: boolean;
}
export interface AskState {
  id: string;
  question: string;
  description?: string;
  multiSelect?: boolean;
  options?: Array<string | AskOption>;
}

/** v2.9 右侧栏标签页（浏览器式）类型 */
export type RightTabKind = "review" | "browser" | "subagent" | "subagents" | "computeruse" | "trace";
/** v2.9 右侧栏标签页：review=审查 / browser=浏览器（占位）/ subagent=子 Agent 详情 / subagents=子 Agent 列表 */
export interface RightTab {
  id: string;
  kind: RightTabKind;
  label: string;
  subagentId?: string;
}

/** v3.1 排队发送：会话运行中预输入的下一条消息（队列项） */
export interface QueueItem {
  id: string;
  text: string;
  ts: number;
}

/** 设置弹窗 Tab（SettingsModal 导航；类型放 store 防 SettingsModal→store 循环 import） */
export type SettingsTab =
  | "general" | "appearance" | "model" | "browser"
  | "memory" | "plugins" | "skills" | "subagent" | "mcp" | "commands" | "hooks"
  | "datadir" | "index" | "audit" | "stats" | "schedule";

interface StoreState {
  models: ModelConfig[];
  modelId: string;
  root: string;
  messages: ChatMsg[];
  /** v3.1：全局运行中会话集合（多会话并行：每会话独立运行态；running 是当前视图会话的派生值） */
  runningIds: string[];
  running: boolean;
  /** v3.3 补 9：screen_capture 截图事件标记（tool-result 到达时 +1；ComputerUsePane
   *  依赖它做「有截图才刷新」——无轮询，Agent 实际截屏才拉一次截图列表） */
  screenShotTick: number;
  bumpScreenShots: () => void;
  /** v3.3 补 16：Agent 打开浏览器的待建 tab（URL 或 null）——右侧栏折叠时 open-request
   *  事件先由 App 顶层响应（展开侧栏），BrowserPanel 那时才挂载、事件订阅已错过；
   *  改为 store 状态记录，BrowserPanel 挂载/变化时消费建 tab（恢复 v3.6 误删的 tick 机制） */
  pendingBrowserOpen: string | null;
  setPendingBrowserOpen: (url: string | null) => void;
  /** v3.1：每会话消息缓存（多会话并行：流式事件写对应缓存；切换会话秒切，不丢流式状态） */
  sessionCache: Record<string, ChatMsg[]>;
  /** 会话原始事件账本：供右栏追踪检查器查看，不取代面向用户的聊天 Timeline。 */
  traceBySession: Record<string, StoredEvent[]>;
  appendTrace: (event: AgentEvent, sessionId?: string | null) => void;
  /** v3.1：SSE 事件路由目标会话（api.ts 每连接设置；null = 当前视图会话） */
  eventTarget: string | null;
  /** v3.1：每会话编排阶段/步数（流式事件写缓存时用，防跨会话污染视图 currentStep/currentPhase） */
  sessionPhase: Record<string, PhaseId | null>;
  sessionStep: Record<string, number>;
  setEventTarget: (id: string | null) => void;
  setSessionRunning: (sid: string, r: boolean) => void;
  /** v3.2：断网/瞬时故障重试信息（按会话；运行状态行倒计时显示；done/error 清空） */
  retryBySession: Record<string, { attempt: number; maxAttempts: number; delayMs: number; message: string }>;
  setRetry: (sid: string, r: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void;
  clearRetry: (sid: string) => void;
  /** v3.2：会话级全权放行（审批弹窗「本会话全部放行」；开启后该会话审批不再弹窗） */
  bypassBySession: Record<string, boolean>;
  setBypassFor: (sid: string, enabled: boolean) => void;
  /** v3.1 排队发送：每会话待发队列（会话运行中输入 → 入队；done 后自动消费队首） */
  queuesBySession: Record<string, QueueItem[]>;
  enqueue: (text: string) => void;
  removeQueueItem: (sid: string, id: string) => void;
  updateQueueItem: (sid: string, id: string, text: string) => void;
  reorderQueue: (sid: string, from: number, to: number) => void;
  /** 取队首（消费；返回 null 表示队列空） */
  shiftQueue: (sid: string) => QueueItem | null;
  /** v2.13：队列项插回队首（发送失败恢复；按 id 去重防重复插入） */
  unshiftQueue: (sid: string, item: QueueItem) => void;
  /** v3.1：attachments 事件 → 挂到消息流最后一条用户消息（实时流本地已 addUserMsg） */
  handleAttachments: (ev: Extract<AgentEvent, { type: "attachments" }>) => void;
  /** v2.10：任务清单（todo_write 事件驱动；Todo 面板展示） */
  todos: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>;
  setTodos: (items: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>) => void;
  /** v2.13：任务清单按会话存（后台会话 todo-write 不再覆盖视图会话的 Todo 面板） */
  todosBySession: Record<string, Array<{ text: string; status: "pending" | "in_progress" | "completed" }>>;
  /** 审批队列（Agent 可能并发发起多个审批，逐个排队处理） */
  approvals: ApprovalState[];
  /** v2.6 收尾：Agent 提问（ask_user 工具；null = 无提问） */
  askQuestion: AskState | null;
  /** v4.0 审计修复（M3）：提问按会话存储（多会话并行时后到的问题不再覆盖先到的——后台
   *  会话的提问挂起等待，切回该会话即可见）；askQuestion = 当前视图会话的提问（派生视图） */
  askBySession: Record<string, AskState | null>;
  /** 当前阶段号（Timeline 分组） */
  currentStep: number;
  /** 各阶段开始时间戳（思考耗时计算，键 = 阶段:步骤 复合键） */
  stepStartTimes: Record<string, number>;
  /** 右侧面板：最近一次 git diff 输出 */
  diffContent: string;
  /** 右侧面板：本次任务的文件修改摘要 */
  fileChanges: string[];
  /** 各编排阶段使用的模型（v2.2 角色路由可视化：Timeline 阶段头展示） */
  phaseModels: Partial<Record<PhaseId, string>>;
  /** v2 思考级别（4 档 UI，按模型实际级别数自动映射；1-4，默认 2） */
  thinkingLevel: number;
  /** v3.5 审批档位（全局；composer 下拉与设置「命令」Tab 共用同一数据源——双向联动） */
  approvalMode: ApprovalMode;
  setApprovalMode: (mode: ApprovalMode) => void;
  /** v3.5 常规设置：对话流显示开关（config.general.showThinking/showTodos；默认开） */
  uiShowThinking: boolean;
  uiShowTodos: boolean;
  setUiFlags: (f: { showThinking?: boolean; showTodos?: boolean }) => void;
  /** v2.4 外观（来自 /api/config appearance 节；设置弹窗保存后即时应用） */
  fontSize: "xs" | "sm" | "base";
  streamCursor: boolean;
  setAppearance: (a: { fontSize?: "xs" | "sm" | "base"; streamCursor?: boolean; theme?: "light" | "dark" | "system" }) => void;
  /** v3 UI 打磨：主题（深色默认；设置→外观切换，双主题 token 全站翻转） */
  theme: "light" | "dark" | "system";
  setTheme: (t: "light" | "dark" | "system") => void;
  // ── v3 三栏布局（：侧栏可折叠 rail、右详情栏可开合，均支持拖拽宽度）──
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  browserMenuOpen: boolean;
  setBrowserMenuOpen: (v: boolean) => void;
  detailsOpen: boolean;
  detailsWidth: number;
  setSidebarCollapsed: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setDetailsOpen: (v: boolean) => void;
  setDetailsWidth: (w: number) => void;
  /** v3：Web 交互式终端（仅聊天列内显示；开关按钮在输入框左上方） */
  terminalOpen: boolean;
  setTerminalOpen: (v: boolean) => void;
  /** v3：顶部推拉视图（对话/代码）——代码模式终端按钮/面板隐藏 */
  viewMode: "chat" | "code";
  setViewMode: (v: "chat" | "code") => void;

  setModels: (models: ModelConfig[]) => void;
  setModelId: (id: string) => void;
  setRoot: (root: string) => void;
  setThinkingLevel: (level: number) => void;
  /** v2.1 会话：列表 + 当前会话 */
  sessions: SessionMeta[];
  activeSessionId: string | null;
  setSessions: (s: SessionMeta[]) => void;
  setActiveSessionId: (id: string | null) => void;
  /** 加载历史会话（事件流重放为消息；跳过 plan/审批交互事件；v3.1 写入对应会话缓存） */
  loadSession: (events: StoredEvent[], sessionId?: string, forceView?: boolean) => void;
  // ── v2.6.1 侧栏会话中枢（UI 状态）──
  /** 搜索框聚焦信号（Ctrl+K 递增触发 Sidebar 聚焦） */
  searchFocusTick: number;
  focusSearch: () => void;
  /** 设置弹窗初始 Tab（技能/定时任务按钮定位用；v3.0 UI 审查：从 string 收紧为字面量联合） */
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  /** 新建会话：清空聊天区并脱离当前会话（下一轮任务由服务端新建） */
  newSession: () => void;
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
  /** v3.3 后台任务完成通知（EventRow 通知行） */
  appendTaskNotification: (note: {
    taskType: "subagent" | "job";
    taskId: string;
    name: string;
    status: "completed" | "failed" | "stopped" | "killed";
    summary: string;
  }) => void;
  /** 阶段开始：若当前 assistant 消息已有内容则开新消息（每轮 = 一条消息，对齐主流 Agent turn 语义） */
  beginStep: (n: number) => void;
  startTool: (ev: Extract<AgentEvent, { type: "tool-start" }>) => void;
  finishTool: (ev: Extract<AgentEvent, { type: "tool-result" }>) => void;
  setRunning: (r: boolean) => void;
  // v2.13：abortController 单例 → 按会话 Map（并行会话互相踩，stop 失效/停错对象）
  abortControllers: Record<string, AbortController>;
  setAbortController: (c: AbortController | null) => void;
  clearAbortController: (sid: string) => void;
  abortRun: (sid?: string) => void;
  /** 任务工作树模式（每任务独立 git worktree） */
  useWorktree: boolean;
  setUseWorktree: (v: boolean) => void;
  worktree: { name: string; path: string } | null;
  worktreeNote: string;
  setWorktree: (wt: { name: string; path: string } | null) => void;
  addWorktreeNote: (note: string) => void;
  clearWorktree: () => void;
  // v5.0（C1）：会话级临时联网（null = 未开启；composer 🌐 药丸展示/控制）
  egressUntil: number | null;
  /** 本次开启的时长（分钟）——下拉菜单高亮当前档位 */
  egressMinutes: number | null;
  setEgress: (v: { until: number; minutes: number } | null) => void;
  /** 当前编排阶段（phase-start 事件更新，新消息按此打标；默认单一循环无阶段） */
  currentPhase: PhaseId | null;
  setPhase: (ev: Extract<AgentEvent, { type: "phase-start" }>) => void;
  setReview: (content: string) => void;
  /** 待确认的执行计划（计划卡片，POST /api/plan/:id 决策） */
  plan: { id: string; content: string } | null;
  setPlan: (p: { id: string; content: string } | null) => void;
  /** v2.13：计划按会话存（后台会话挂起等确认时，其他会话收尾不能清掉它的计划卡） */
  plansBySession: Record<string, { id: string; content: string } | null>;
  clearPlanFor: (sid: string) => void;
  clearPlan: () => void;
  requestApproval: (ev: Extract<AgentEvent, { type: "approval-required" }>, sessionId?: string) => void;
  resolveApproval: (approved: boolean) => void;
  resolveAllApprovals: (approved: boolean) => void;
  setAskQuestion: (q: AskState | null, sessionId?: string | null) => void;
  resolveAskQuestion: (answer: string | null) => void;
  // ── v2.5 子智能体（主对话流条目 + 右侧栏详情弹窗）──
  startSubagent: (ev: Extract<AgentEvent, { type: "subagent-start" }>) => void;
  updateSubagent: (ev: AgentEvent) => void;
  finishSubagent: (ev: Extract<AgentEvent, { type: "subagent-done" }>) => void;
  /** 子智能体线程（右侧栏弹窗数据：与父 Agent 同构的消息流） */
  subagentThreads: Record<string, SubagentThread>;
  /** 当前打开的详情弹窗（subagentId；null = 关闭） */
  /** v2.9 右侧栏标签页（浏览器式） */
  rightTabs: RightTab[];
  activeRightTab: string | null;
  openRightTab: (tab: { id?: string; kind: RightTabKind; label: string; subagentId?: string }) => void;
  closeRightTab: (id: string) => void;
  setActiveRightTab: (id: string) => void;
  setReport: (content: string) => void;
  /** v3：LLM usage（done 事件携带的缓存命中统计 → StatsLine；v2.12 四桶：uncached=miss/output=completion/cacheRead=hit） */
  usage: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number };
  /** v2.13：usage 按会话存（切换会话后 StatsLine 显示该会话自己的数字） */
  usageBySession: Record<string, { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number }>;
  setUsageFor: (sid: string, u: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number }) => void;
  finishAssistant: () => void;
  /** v2.13：按显式会话收尾（sendChat finally/catch 用本连接 connSid——修复跨会话清 running/写错会话） */
  finishAssistantFor: (sid: string) => void;
  addError: (msg: string) => void;
  /** v2.13：按显式会话追加错误消息（同上） */
  addErrorFor: (sid: string, msg: string) => void;
  /** v2.13：agent-waiting/resumed → 子 Agent 线程追加等待/恢复提示（前端状态不失真） */
  agentWaiting: (ev: Extract<AgentEvent, { type: "agent-waiting" }>) => void;
  agentResumed: (ev: Extract<AgentEvent, { type: "agent-resumed" }>) => void;
  /** v2.14：工具行文件链接 → 打开代码界面定位文件（外部触发；CodeView 消费后清空） */
  codeViewFile: string | null;
  setCodeViewFile: (path: string | null) => void;
  /** v2.13：仅写会话缓存的重放（后台会话重放不污染视图全局字段；被新 run 接管时跳过由调用方判断） */
  loadSessionCache: (events: { seq: number; ts: number; event: AgentEvent }[], sessionId: string) => void;
  reset: () => void;
}

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

/** 阶段+步骤复合键（各阶段 step 独立编号，防止时间戳/分组冲突） */
export function stepKey(phase: PhaseId | null | undefined, step: number): string {
  return `${phase ?? "agent"}:${step}`;
}

/**
 * v3.1 多会话并行：事件/消息写入的目标会话。
 * SSE 事件流用 eventTarget（api.ts 按连接设置）；用户操作（输入/重放）用 activeSessionId。
 */
function targetId(s: StoreState): string | null {
  return s.eventTarget ?? s.activeSessionId;
}

/**
 * v3.1 消息补丁（核心路由）：把 fn 应用到目标会话的消息数组。
 * - 目标 = 当前视图会话 → 同步更新 sessionCache 与 messages（组件渲染的视图）
 * - 目标 = 其他会话（并行流式）→ 只更新 sessionCache，不打扰当前视图
 * - 无目标（新会话首帧前）→ 直接改 messages（后续 session 事件建立缓存时以它为底）
 */
function patchMsgs(s: StoreState, fn: (msgs: ChatMsg[]) => ChatMsg[]): Partial<StoreState> {
  const sid = targetId(s);
  if (!sid) return { messages: fn(s.messages) };
  const base = s.sessionCache[sid] ?? (sid === s.activeSessionId ? s.messages : []);
  const next = fn(base);
  const sessionCache = { ...s.sessionCache, [sid]: next };
  if (sid === s.activeSessionId) return { sessionCache, messages: next };
  return { sessionCache };
}

/** v3.1 运行状态补丁：更新 runningIds；目标为视图会话时同步派生值 running */
function patchRunning(s: StoreState, sid: string | null, r: boolean): Partial<StoreState> {
  if (!sid) return { running: r };
  const set = new Set(s.runningIds);
  if (r) set.add(sid);
  else set.delete(sid);
  const runningIds = [...set];
  const out: Partial<StoreState> = { runningIds };
  if (sid === s.activeSessionId) out.running = r;
  return out;
}

/** v3.1 视图会话消息（渲染用）：缓存优先，缺省回退 messages */
function viewMsgs(s: StoreState, sid: string | null): ChatMsg[] {
  return sid && s.sessionCache[sid] ? s.sessionCache[sid] : s.messages;
}

/**
 * v2.5 子智能体定位：在消息树中按条件找到最近命中的工具卡片并应用更新（不可变更新）。
 * 委派卡片唯一性：一个 subagent 只挂在它自己的 delegate 卡片上，故只改最近一个命中。
 */
function mapTool(
  msgs: ChatMsg[],
  find: (t: ToolEventState) => boolean,
  fn: (t: ToolEventState) => ToolEventState
): ChatMsg[] | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const idx = msgs[i].tools.findIndex(find);
    if (idx >= 0) {
      const next = [...msgs];
      const tools = [...msgs[i].tools];
      tools[idx] = fn(msgs[i].tools[idx]);
      next[i] = { ...msgs[i], tools };
      return next;
    }
  }
  return null;
}

/** 新建子智能体线程（subagent-start 初始化） */
function newSubagentThread(ev: { id: string; name: string; model?: string; prompt: string; readOnly?: boolean }): SubagentThread {
  return {
    id: ev.id,
    name: ev.name,
    model: ev.model,
    prompt: ev.prompt,
    status: "running",
    steps: 0,
    toolCount: 0,
    summary: "",
    readOnly: ev.readOnly,
    messages: [],
  };
}

/**
 * subagent-start 事件路由：优先按 parentCallId 关联委派工具条目（挂 subagentId，
 * 主对话流点击打开详情），缺失时回退到「最近一个运行中的 delegate_task 条目」。
 */
function attachSubagentId(msgs: ChatMsg[], ev: Extract<AgentEvent, { type: "subagent-start" }>): ChatMsg[] {
  const byCall = ev.parentCallId
    ? mapTool(msgs, (t) => t.callId === ev.parentCallId, (t) => ({ ...t, subagentId: ev.id }))
    : null;
  if (byCall) return byCall;
  return (
    mapTool(msgs, (t) => t.tool === "delegate_task" && t.status === "running", (t) => ({ ...t, subagentId: ev.id })) ??
    msgs
  );
}

/**
 * 子智能体内部过程事件路由（带 subagentId）：收集进线程消息流（右侧栏详情的数据源；
 * 与父 Agent 消息同构——思考/文本/工具过程）。主对话流不再内嵌展示。
 * v3.6 审计修复：原实现原地改 thread.messages（push/`+=`）——thread 对象引用不变，
 * 按 subagentThreads[id] 订阅的组件不重渲染（此前靠 RightRail 全量订阅兜底，脆弱）；
 * 改为不可变更新：返回新线程对象（消息数组/消息对象全部重建）。
 */
function routeSubagentEvent(thread: SubagentThread, ev: AgentEvent): SubagentThread | null {
  if (!ev || !("subagentId" in ev) || !ev.subagentId) return null;
  const id = ev.subagentId;
  const msgs = thread.messages;
  const cur = msgs[msgs.length - 1];
  let next = msgs; // 仅在有变更时替换为新区块
  switch (ev.type) {
    case "step-start": {
      if (cur && (cur.text || cur.reasoning || cur.tools.length)) {
        next = [...msgs, { id: `${id}-s${ev.step}`, text: "", tools: [], step: ev.step }];
      }
      break;
    }
    case "text": {
      if (!cur || cur.tools.length > 0) {
        next = [...msgs, { id: `${id}-s${(cur?.step ?? 0) + 1}`, text: ev.text, tools: [], step: cur?.step ?? 1 }];
      } else {
        next = msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, text: m.text + ev.text } : m));
      }
      break;
    }
    case "reasoning": {
      if (!cur) {
        next = [...msgs, { id: `${id}-s1`, text: "", tools: [], reasoning: ev.text, step: 1 }];
      } else {
        next = msgs.map((m, i) =>
          i === msgs.length - 1 ? { ...m, reasoning: (m.reasoning ?? "") + ev.text } : m
        );
      }
      break;
    }
    case "tool-start": {
      const base = cur ?? { id: `${id}-s1`, text: "", tools: [], step: 1 };
      const last = { ...base, tools: [...base.tools] };
      last.tools.push({
        id: `${id}-t${last.tools.length}-${ev.tool}`,
        tool: ev.tool,
        args: ev.args,
        risk: ev.risk,
        status: "running",
        step: last.step,
        startedAt: Date.now(),
      });
      next = cur ? msgs.map((m, i) => (i === msgs.length - 1 ? last : m)) : [...msgs, last];
      break;
    }
    case "tool-result": {
      const last = msgs[msgs.length - 1];
      const idx = last?.tools.findIndex((it) => it.tool === ev.tool && it.status === "running");
      if (last && idx !== undefined && idx >= 0) {
        const status: ToolEventState["status"] = ev.ok ? "ok" : "error";
        const tools = last.tools.map((t, i) => (i === idx ? { ...t, status, summary: ev.summary, diff: ev.diff } : t));
        next = msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, tools } : m));
      }
      break;
    }
    default:
      return null; // approval-*/model-fallback/context-compressed 等不进入消息流
  }
  if (next === msgs) return null;
  return { ...thread, messages: next };
}

/** v2.5 重放辅助：子智能体过程事件 → 线程（会话历史重建） */

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
  models: [],
  modelId: "",
  root: "", // v2.6.2：初始为空——由设置 defaultRoot 或侧栏项目选择填充（不再指向测试占位目录）
  screenShotTick: 0, // v3.3 补 9：截图事件标记（screen_capture tool-result 到达 +1）
  pendingBrowserOpen: null, // v3.3 补 16：Agent 开浏览器待建 tab
  messages: [],
  runningIds: [],
  running: false,
  sessionCache: {},
   traceBySession: {},
   appendTrace: (event, sessionId) =>
     set((s) => {
       const sid = sessionId ?? targetId(s);
       if (!sid || event.type === "session") return {};
       const previous = s.traceBySession[sid] ?? [];
       const next: StoredEvent = { seq: previous.at(-1)?.seq != null ? previous.at(-1)!.seq + 1 : 0, ts: Date.now(), event };
       return { traceBySession: { ...s.traceBySession, [sid]: [...previous, next] } };
     }),
  eventTarget: null,
  sessionPhase: {},
  sessionStep: {},
  plansBySession: {},
  usageBySession: {},
  abortControllers: {},
  setEventTarget: (id) => set({ eventTarget: id }),
  setSessionRunning: (sid, r) => set((s) => patchRunning(s, sid, r)),
  retryBySession: {},
  setRetry: (sid, r) => set((s) => ({ retryBySession: { ...s.retryBySession, [sid]: r } })),
  clearRetry: (sid) =>
    set((s) => {
      if (!s.retryBySession[sid]) return {};
      const retryBySession = { ...s.retryBySession };
      delete retryBySession[sid];
      return { retryBySession };
    }),
  bypassBySession: {},
  setBypassFor: (sid, enabled) => set((s) => ({ bypassBySession: { ...s.bypassBySession, [sid]: enabled } })),
  queuesBySession: {},
  enqueue: (text) =>
    set((s) => {
      const sid = s.activeSessionId ?? null;
      if (!sid) return {};
      const item: QueueItem = { id: `q${++msgSeq}`, text, ts: Date.now() };
      return { queuesBySession: { ...s.queuesBySession, [sid]: [...(s.queuesBySession[sid] ?? []), item] } };
    }),
  removeQueueItem: (sid, id) =>
    set((s) => ({
      queuesBySession: {
        ...s.queuesBySession,
        [sid]: (s.queuesBySession[sid] ?? []).filter((x) => x.id !== id),
      },
    })),
  updateQueueItem: (sid, id, text) =>
    set((s) => ({
      queuesBySession: {
        ...s.queuesBySession,
        [sid]: (s.queuesBySession[sid] ?? []).map((x) => (x.id === id ? { ...x, text } : x)),
      },
    })),
  reorderQueue: (sid, from, to) =>
    set((s) => {
      const q = [...(s.queuesBySession[sid] ?? [])];
      if (from < 0 || from >= q.length || to < 0 || to >= q.length || from === to) return {};
      const [item] = q.splice(from, 1);
      q.splice(to, 0, item);
      return { queuesBySession: { ...s.queuesBySession, [sid]: q } };
    }),
  shiftQueue: (sid) => {
    const s = get();
    const q = s.queuesBySession[sid];
    if (!q || !q.length) return null;
    const [item, ...rest] = q;
    set({ queuesBySession: { ...s.queuesBySession, [sid]: rest } });
    return item;
  },
  /** v2.13：队列项插回队首（发送失败恢复；成功消费的项不重复） */
  unshiftQueue: (sid, item) =>
    set((s) => {
      const q = s.queuesBySession[sid] ?? [];
      if (q.some((x) => x.id === item.id)) return {};
      return { queuesBySession: { ...s.queuesBySession, [sid]: [item, ...q] } };
    }),
  handleAttachments: (ev) =>
    set((s) =>
      patchMsgs(s, (m) => {
        // 挂到最后一条用户消息（实时流：本地 addUserMsg 已加；找不到则附加到末尾）
        const idx = [...m].reverse().findIndex((x) => x.role === "user");
        if (idx >= 0) {
          const i = m.length - 1 - idx;
          return m.map((x, n) => (n === i ? { ...x, attachments: [...(x.attachments ?? []), ...ev.items] } : x));
        }
        return [...m, { id: nextId(), role: "user", text: "", tools: [], attachments: ev.items, ts: Date.now() }];
      })
    ),
  approvals: [],
  askQuestion: null,
  askBySession: {},
  sessions: [],
  activeSessionId: null,
  pendingRollback: null,
  useWorktree: true,
  worktree: null,
  egressUntil: null,
  egressMinutes: null,
  worktreeNote: "",
  currentPhase: null,
  plan: null,
  subagentThreads: {},
  rightTabs: [],
  activeRightTab: null,
  todos: [],
  todosBySession: {},
  setTodos: (items) =>
    set((s) => {
      const sid = targetId(s) ?? s.activeSessionId ?? "";
      const todosBySession = { ...s.todosBySession, [sid]: items };
      const out: Partial<StoreState> = { todosBySession };
      if (!sid || sid === s.activeSessionId) out.todos = items;
      return out;
    }),
  currentStep: 1,
  stepStartTimes: {},
  diffContent: "",
  fileChanges: [],
  phaseModels: {},
  thinkingLevel: 2,
  uiShowThinking: true,
  uiShowTodos: true,
  setUiFlags: (f) => set((s) => ({ uiShowThinking: f.showThinking ?? s.uiShowThinking, uiShowTodos: f.showTodos ?? s.uiShowTodos })),
  fontSize: "sm",
  streamCursor: true,
  theme: "dark",
  sidebarCollapsed: false,
  sidebarWidth: 280,
  // v3.0 批 3：右侧栏「新建 tab」菜单打开标记（浏览器面板据此让位视图，防原生层覆盖）
  browserMenuOpen: false,
  detailsOpen: true,
  detailsWidth: 360,
  terminalOpen: false,
  setTerminalOpen: (v) => set({ terminalOpen: v }),
  viewMode: "chat",
  setViewMode: (v) => set({ viewMode: v }),

  setAppearance: (a) =>
    set((s) => ({
      fontSize: a.fontSize ?? s.fontSize,
      streamCursor: a.streamCursor ?? s.streamCursor,
      theme: a.theme ?? s.theme,
    })),
  setTheme: (t) => set({ theme: t }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(264, Math.min(420, w)) }),
  setBrowserMenuOpen: (v) => set({ browserMenuOpen: v }),
  setDetailsOpen: (v) => set({ detailsOpen: v }),
  setDetailsWidth: (w) => set({ detailsWidth: Math.max(300, Math.min(520, w)) }),

  setModels: (models) => {
    const cur = get().modelId;
    set({
      models,
      modelId: models.some((m) => m.id === cur) ? cur : (models[0]?.id ?? ""),
    });
  },
  setModelId: (id) => set({ modelId: id }),
  setThinkingLevel: (level) => set({ thinkingLevel: Math.max(1, Math.min(4, Math.round(level)))}),
  approvalMode: "smart",
  setApprovalMode: (mode) => set({ approvalMode: mode }),
  setRoot: (root) => set({ root }),
  setSessions: (sessions) => set({ sessions }),
  // ── v2.6.1 UI 状态（侧栏会话中枢）──
  searchFocusTick: 0,
  focusSearch: () => set((s) => ({ searchFocusTick: s.searchFocusTick + 1 })),
  settingsTab: "general",
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  setActiveSessionId: (id) =>
    set((s) => {
      const out: Partial<StoreState> = { activeSessionId: id };
      // v2.13：切换会话 → 视图派生字段跟随该会话（todos/usage/plan 按会话存储后回填）
      // v4.0：askQuestion 同款回填（按会话存储后，切回有挂起提问的会话即可见）
      if (id) {
        // `running` is a view-local projection of runningIds. Without this refill,
        // switching from a running uncached session leaves the next session's composer stuck.
        out.running = s.runningIds.includes(id);
        out.todos = s.todosBySession[id] ?? [];
        out.usage = s.usageBySession[id] ?? { cacheHit: 0, cacheMiss: 0, promptTokens: 0, completionTokens: 0 };
        out.plan = s.plansBySession[id] ?? null;
        out.askQuestion = s.askBySession[id] ?? null;
      }
      return out;
    }),
  setPendingRollback: (p) => set({ pendingRollback: p }),
  clearPendingRollback: () => set({ pendingRollback: null }),
  newSession: () =>
    set({
      messages: [],
      activeSessionId: null,
      pendingRollback: null,
      running: false,
      approvals: [],
      askQuestion: null,
      diffContent: "",
      fileChanges: [],
      currentStep: 1,
      stepStartTimes: {},
      currentPhase: null,
      phaseModels: {},
      plan: null,
      subagentThreads: {},
      rightTabs: [],
      activeRightTab: null,
      todos: [],
      // v3.1：runningIds/sessionCache 不动——其他会话的后台任务继续跑、缓存保留
    }),

  /** 历史会话重放：事件流 → 消息（复用消息结构，右侧 Diff/文件改动一并恢复）。
   *  v3.1：写入 sessionId 对应缓存；sessionId === activeSessionId 或未传时同步视图 messages */
  loadSession: (events, sessionId, forceView = false) => {
    let msgs: ChatMsg[] = [];
    const fileChanges: string[] = [];
    let diffContent = "";
    let shotTick = 0; // v3.3 补 9：重放路径的 screen_capture 事件计数
    let cur: ChatMsg | null = null; // 当前 assistant 轮次（每个 step-start 一条）
    let phase: PhaseId | undefined;
    const phaseModels: Partial<Record<PhaseId, string>> = {}; // v2.2 阶段模型记录
    let currentStep = 1;
    let todos: Array<{ text: string; status: "pending" | "in_progress" | "completed" }> = []; // v2.10 任务清单
    let usage: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number } | null = null; // v2.13 usage 重放恢复
    // v2.5：子智能体线程重建（右侧栏详情数据源；主对话流只挂条目 id）
    const subagentThreads: Record<string, SubagentThread> = {};
    for (const { seq, ts, event } of events) {
      // v2.5：子智能体内部事件（带 subagentId）→ 收集进线程消息流，不进入主消息流
    // v3.6：适配 routeSubagentEvent 新签名（不可变单线程更新）
    if (event && "subagentId" in event && event.subagentId) {
      const t = subagentThreads[event.subagentId];
      if (t) {
        const next = routeSubagentEvent(t, event);
        if (next) subagentThreads[event.subagentId] = next;
      }
      continue;
    }
      switch (event.type) {
        case "user-message":
          // seqStart 记 user-message 事件 seq（回滚锚点：编辑重发 = 替换这条用户消息）
          msgs.push({ id: nextId(), role: "user", text: event.text, tools: [], seqStart: seq, ts });
          cur = null;
          break;
        case "todo-write": {
          // v2.10：任务清单恢复（Todo 面板）
          todos = event.items;
          break;
        }
        case "attachments": {
          // v3.1：附件挂到最后一条用户消息（重放展示附件行；图片字节不落库只显名称）
          const lastUser = [...msgs].reverse().find((x) => x.role === "user");
          if (lastUser) lastUser.attachments = [...(lastUser.attachments ?? []), ...event.items];
          break;
        }
        case "phase-start":
          phase = event.phase;
          if (event.model) phaseModels[event.phase] = event.model;
          cur = null;
          break;
        case "step-start": {
          // 检查点锚点：该轮第一条事件的 seq（Rewind 用）
          cur = { id: nextId(), role: "assistant", text: "", tools: [], phase, seqStart: seq, ts };
          msgs.push(cur);
          currentStep = event.step;
          break;
        }
        case "text":
          // v2.14 批 3：工具调用之后的文本独立成消息（中间文本穿插工具之间）
          if (!cur || cur.tools.length > 0) { cur = { id: nextId(), role: "assistant", text: "", tools: [], phase, ts }; msgs.push(cur); }
          cur.text += event.text;
          break;
        case "reasoning":
          if (!cur) { cur = { id: nextId(), role: "assistant", text: "", tools: [], phase, ts }; msgs.push(cur); }
          cur.reasoning = (cur.reasoning ?? "") + event.text;
          break;
        case "tool-start": {
          if (!cur) { cur = { id: nextId(), role: "assistant", text: "", tools: [], phase, ts }; msgs.push(cur); }
          cur.tools.push({
            id: `${cur.id}-t${cur.tools.length}-${event.tool}`,
            tool: event.tool,
            args: event.args,
            risk: event.risk,
            status: "running",
            step: currentStep,
            phase,
            startedAt: ts, // 历史时间戳（耗时展示）
            callId: event.callId,
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
          // v3.3 补 9：重放路径同样触发截图事件标记（历史回放后截图区仍能刷新）
          if (event.tool === "screen_capture") shotTick++;
          break;
        }
        case "subagent-start": {
          // 委派条目关联。注意：必须**原地**挂 subagentId——不可变替换（mapTool）会让
          // 重放循环的 cur 指向旧消息对象，tool-result 更新旧对象而渲染的是新对象
          // → 委派工具保持 running → 收尾误标 error（✗ 红框 bug）
          const target =
            (event.parentCallId ? cur?.tools.find((x) => x.callId === event.parentCallId) : undefined) ??
            cur?.tools.find((x) => x.tool === "delegate_task" && x.status === "running");
          if (target) target.subagentId = event.id;
          subagentThreads[event.id] = newSubagentThread(event);
          break;
        }
        case "subagent-done": {
          const t = subagentThreads[event.id];
          if (t) {
            t.status = event.ok ? "done" : "error";
            t.ok = event.ok;
            t.steps = event.steps;
            t.toolCount = event.toolCount;
            t.summary = event.text;
          }
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
          // v2.13：usage 重放恢复（per-session StatsLine）
          {
            const u = (event as unknown as { usage?: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number } }).usage;
            if (u) usage = u;
          }
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
        case "task-notification":
          // v3.3 后台任务完成通知：附加到当前轮次（EventRow 通知行；无当前轮则忽略——
          // 任务已结束的后台通知只进上下文（后端注入）与落库，不再补渲染）
          if (cur) {
            cur.taskNotes = [...(cur.taskNotes ?? []), {
              taskType: event.taskType,
              taskId: event.taskId,
              name: event.name,
              status: event.status,
              summary: event.summary,
            }];
          }
          break;
        case "error":
          msgs.push({ id: nextId(), role: "assistant", text: `⚠️ ${event.message}`, tools: [], ts });
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
    const sid = sessionId ?? undefined;
    // v2.13：非视图会话重放只写缓存 + per-session 字段（todos/usage），
    // 不污染视图全局（fileChanges/diffContent/rightTabs/approvals 等）；forceView
    // 用于 Sidebar 切换路径（loadSession 时 activeSessionId 尚未切换）
    const isView = forceView || !sid || sid === get().activeSessionId;
    const out: Partial<StoreState> = {};
    if (isView) {
      out.fileChanges = fileChanges;
      out.diffContent = diffContent;
      // v3.3 补 9：重放含 screen_capture → 累加截图事件标记（ComputerUsePane 刷新）
      if (shotTick > 0) out.screenShotTick = get().screenShotTick + shotTick;
      out.currentStep = currentStep;
      out.stepStartTimes = {};
      out.currentPhase = null;
      out.phaseModels = phaseModels;
      out.plan = null;
      out.pendingRollback = null;
      out.approvals = [];
      out.subagentThreads = subagentThreads;
      out.rightTabs = [];
      out.activeRightTab = null;
      out.todos = todos;
    }
    // per-session 字段总是写（切换会话回填用）
    out.todosBySession = { ...get().todosBySession, [sid ?? ""]: todos };
    if (usage) out.usageBySession = { ...get().usageBySession, [sid ?? ""]: usage };
    if (sid) {
      out.sessionCache = { ...get().sessionCache, [sid]: msgs };
      out.traceBySession = { ...get().traceBySession, [sid]: events };
      out.sessionPhase = { ...get().sessionPhase, [sid]: null };
      out.sessionStep = { ...get().sessionStep, [sid]: currentStep };
      // runningIds 不在此清理：调用方负责（done 已由 finishAssistant 移除；重放不改变运行集合，
      // 避免误删「done 后立即消费队列」新任务的运行标记）
      if (sid === get().activeSessionId) {
        out.messages = msgs;
        out.running = false;
      }
    } else {
      out.messages = msgs;
      out.running = false;
    }
    set(out);
  },

  /** v2.13：仅写会话缓存与 per-session 字段的重放（后台会话收尾重放用——
   *  不写视图全局字段；被新 run 接管的跳过判断由调用方（api.ts finally）负责） */
  loadSessionCache: (events, sessionId) => {
    let msgs: ChatMsg[] = [];
    let cur: ChatMsg | null = null;
    let phase: PhaseId | undefined;
    let currentStep = 1;
    let todos: Array<{ text: string; status: "pending" | "in_progress" | "completed" }> = [];
    let usage: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number } | null = null;
    for (const { seq, ts, event } of events) {
      switch (event.type) {
        case "user-message":
          msgs.push({ id: nextId(), role: "user", text: event.text, tools: [], seqStart: seq, ts });
          cur = null;
          break;
        case "phase-start":
          phase = event.phase;
          cur = null;
          break;
        case "step-start":
          cur = { id: nextId(), role: "assistant", text: "", tools: [], phase, seqStart: seq, ts };
          msgs.push(cur);
          currentStep = event.step;
          break;
        case "text":
          // v2.14 批 3：工具调用之后的文本独立成消息（中间文本穿插工具之间）
          if (!cur || cur.tools.length > 0) { cur = { id: nextId(), role: "assistant", text: "", tools: [], phase, ts }; msgs.push(cur); }
          cur.text += event.text;
          break;
        case "reasoning":
          if (!cur) { cur = { id: nextId(), role: "assistant", text: "", tools: [], phase, ts }; msgs.push(cur); }
          cur.reasoning = (cur.reasoning ?? "") + event.text;
          break;
        case "tool-start": {
          if (!cur) { cur = { id: nextId(), role: "assistant", text: "", tools: [], phase, ts }; msgs.push(cur); }
          cur.tools.push({
            id: `${cur.id}-t${cur.tools.length}-${event.tool}`,
            tool: event.tool,
            args: event.args,
            risk: event.risk,
            status: "running",
            step: currentStep,
            phase,
            startedAt: ts,
            callId: event.callId,
          });
          break;
        }
        case "tool-result": {
          if (cur) {
            const t = cur.tools.find((x) => x.status === "running" && x.tool === event.tool);
            if (t) { t.status = event.ok ? "ok" : "error"; t.summary = event.summary; t.output = event.summary; }
          }
          break;
        }
        case "todo-write":
          todos = event.items;
          break;
        case "done":
          if (cur) { cur.streaming = false; cur.seqStart = cur.seqStart ?? seq; }
          {
            const u = (event as unknown as { usage?: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number } }).usage;
            if (u) usage = u;
          }
          break;
        case "error":
          msgs.push({ id: nextId(), role: "assistant", text: `⚠️ ${event.message}`, tools: [], ts });
          cur = null;
          break;
        default:
          break;
      }
    }
    for (const m of msgs) {
      m.streaming = false;
      for (const t of m.tools) if (t.status === "running") t.status = "error";
    }
    const out: Partial<StoreState> = {
      sessionCache: { ...get().sessionCache, [sessionId]: msgs },
      todosBySession: { ...get().todosBySession, [sessionId]: todos },
    };
    if (usage) out.usageBySession = { ...get().usageBySession, [sessionId]: usage };
    if (sessionId === get().activeSessionId) {
      out.messages = msgs;
      out.todos = todos;
      if (usage) out.usage = usage;
    }
    set(out);
  },

  addUserMsg: (text) =>
    set((s) => {
      // v3.1：目标 = eventTarget（SSE 连接会话，含后台队列消费）?? 当前视图会话
      const sid = targetId(s);
      return {
        ...patchMsgs(s, (m) => [...m, { id: nextId(), role: "user", text, tools: [], ts: Date.now() }]),
        ...patchRunning(s, sid, true),
        diffContent: "",
        fileChanges: [],
      };
    }),

  ensureAssistant: () => {
    const s = get();
    const sid = targetId(s);
    const msgs = viewMsgs(s, sid);
    const last = msgs[msgs.length - 1];
    if (last && last.role === "assistant") return last;
    const msg: ChatMsg = { id: nextId(), role: "assistant", text: "", streaming: true, tools: [], ts: Date.now() };
    set((st) => patchMsgs(st, (m) => [...m, msg]));
    return msg;
  },

  appendText: (text) =>
    set((s) => {
      const sid = targetId(s);
      // 审查阶段：文本不流式进消息（最终内容由 review 事件独立渲染，避免重复）
      const ph = sid && s.sessionPhase[sid] !== undefined ? s.sessionPhase[sid] : s.currentPhase;
      return patchMsgs(s, (m) => {
        if (ph === "reviewer") return m;
        const last = m[m.length - 1];
        // v2.14 批 3：已有工具调用之后的文本 → 开新消息（AI 中间文本独立成块，
        // 对齐 主流：每段文本穿插在工具调用之间，不合并到最后一条）
        if (last?.role === "assistant" && last.tools.length > 0) {
          return [...m, { id: nextId(), role: "assistant", text, tools: [], ts: Date.now(), phase: last.phase }];
        }
        return m.map((x, i) =>
          i === m.length - 1 && x.role === "assistant" ? { ...x, text: x.text + text } : x
        );
      });
    }),

  appendReasoning: (text) =>
    set((s) =>
      patchMsgs(s, (m) =>
        m.map((x, i) =>
          i === m.length - 1 && x.role === "assistant"
            ? { ...x, reasoning: (x.reasoning ?? "") + text }
            : x
        )
      )
    ),

  /** v2.2 模型降级记录：附加到当前 assistant 轮次（徽标展示与审计） */
  appendFallback: (from, to, reason) => {
    const msg = get().ensureAssistant();
    set((s) =>
      patchMsgs(s, (m) =>
        m.map((x) =>
          x.id === msg.id ? { ...x, fallbacks: [...(x.fallbacks ?? []), { from, to, reason }] } : x
        )
      )
    );
  },

  /** v2.2 上下文压缩记录：附加到当前 assistant 轮次（提示条展示） */
  appendCompressed: (before, after, summary) => {
    const msg = get().ensureAssistant();
    set((s) =>
      patchMsgs(s, (m) =>
        m.map((x) =>
          x.id === msg.id ? { ...x, compressed: [...(x.compressed ?? []), { before, after, summary }] } : x
        )
      )
    );
  },

  /** v3.3 后台任务完成通知：附加到当前 assistant 轮次（EventRow 通知行） */
  appendTaskNotification: (note) => {
    const msg = get().ensureAssistant();
    set((s) =>
      patchMsgs(s, (m) =>
        m.map((x) =>
          x.id === msg.id ? { ...x, taskNotes: [...(x.taskNotes ?? []), note] } : x
        )
      )
    );
  },

  beginStep: (n) =>
    set((s) => {
      const sid = targetId(s);
      const out = patchMsgs(s, (m) => {
        const msgs = [...m];
        const last = msgs[msgs.length - 1];
        // 当前最后一条 assistant 消息已有内容（文本/思考/工具）→ 开新消息（新轮次），
        // 并把上一轮消息的 streaming 置 false（结束其闪烁光标）
        const hasContent =
          last?.role === "assistant" &&
          (!!last.text || !!last.reasoning || last.tools.length > 0);
        if (hasContent) {
          msgs[msgs.length - 1] = { ...last, streaming: false };
          msgs.push({ id: nextId(), role: "assistant", text: "", streaming: true, tools: [], phase: (sid && s.sessionPhase[sid] !== undefined ? s.sessionPhase[sid] : s.currentPhase) ?? undefined, ts: Date.now() });
        }
        return msgs;
      });
      const sessionStep = sid ? { ...s.sessionStep, [sid]: n } : s.sessionStep;
      const stepStartTimes = {
        ...s.stepStartTimes,
        [stepKey(sid && s.sessionPhase[sid] !== undefined ? s.sessionPhase[sid] : s.currentPhase, n)]: Date.now(),
      };
      if (sid && sid !== s.activeSessionId) return { ...out, sessionStep };
      return { ...out, currentStep: n, sessionStep, stepStartTimes };
    }),

  /** 编排阶段切换：结束上一条消息，开启带阶段标记的新消息 */
  setPhase: (ev) =>
    set((s) => {
      const sid = targetId(s);
      const out = patchMsgs(s, (m) => {
        const msgs = [...m];
        const last = msgs[msgs.length - 1];
        // v2.14 批 17：最后一条 assistant 为空（ensureAssistant 预建）→ 复用打阶段标记，
        // 不再新开——否则发送后出现「两个正在思考」（预建空消息 + phase-start 新消息都渲染）
        const isEmpty =
          last?.role === "assistant" && !last.text && !last.reasoning && last.tools.length === 0;
        if (isEmpty) {
          msgs[msgs.length - 1] = { ...last, phase: ev.phase };
          return msgs;
        }
        const hasContent =
          last?.role === "assistant" &&
          (!!last.text || !!last.reasoning || last.tools.length > 0);
        if (hasContent) msgs[msgs.length - 1] = { ...last, streaming: false };
        msgs.push({ id: nextId(), role: "assistant", text: "", streaming: true, tools: [], phase: ev.phase, ts: Date.now() });
        return msgs;
      });
      const sessionPhase = sid ? { ...s.sessionPhase, [sid]: ev.phase } : s.sessionPhase;
      if (sid && sid !== s.activeSessionId) return { ...out, sessionPhase };
      return {
        ...out,
        sessionPhase,
        currentPhase: ev.phase,
        // v2.2 角色路由可视化：记录该阶段使用的模型（旧会话无 model 字段则忽略）
        phaseModels: ev.model ? { ...s.phaseModels, [ev.phase]: ev.model } : s.phaseModels,
      };
    }),

  setReview: (content) =>
    set((s) =>
      patchMsgs(s, (m) =>
        m.map((x, i) =>
          i === m.length - 1 && x.role === "assistant" ? { ...x, review: content } : x
        )
      )
    ),

  startTool: (ev) => {
    const msg = get().ensureAssistant();
    const s = get();
    const sid = targetId(s);
    const toolState: ToolEventState = {
      id: `${msg.id}-t${msg.tools.length}-${ev.tool}`,
      tool: ev.tool,
      args: ev.args,
      risk: ev.risk,
      status: "running",
      step: sid && s.sessionStep[sid] !== undefined ? s.sessionStep[sid] : s.currentStep,
      phase: (sid && s.sessionPhase[sid] !== undefined ? s.sessionPhase[sid] : s.currentPhase) ?? undefined,
      startedAt: Date.now(),
      callId: ev.callId,
    };
    set((st) =>
      patchMsgs(st, (m) => m.map((x) => (x.id === msg.id ? { ...x, tools: [...x.tools, toolState] } : x)))
    );
  },

  finishTool: (ev) => {
    const s = get();
    const sid = targetId(s);
    const msgs = viewMsgs(s, sid);
    // v3.6 审计修复：原只匹配**最后一条**消息——中间文本消息（appendText 在末条含工具时
    // 新建消息）/ 并行工具场景下 tool-result 到达时匹配不到 → 工具行卡「运行中」直到任务
    // 结束重放（队列连发时重放被跳过可能永久错）；改为从后往前找包含该 tool 且仍 running 的消息
    const msg = [...msgs].reverse().find(
      (m) => m.role === "assistant" && m.tools.some((t) => t.tool === ev.tool && t.status === "running")
    );
    if (!msg) return;
    // v3.3 补 9：screen_capture 完成 → 截图事件标记（ComputerUsePane 事件驱动刷新，无轮询）
    if (ev.tool === "screen_capture") get().bumpScreenShots();
    // 收集 diff 输出 → 右侧面板（仅视图会话）
    if (sid === s.activeSessionId || !sid) {
      if (ev.tool === "git_diff" || /^diff --git/m.test(ev.summary)) {
        set({ diffContent: ev.summary });
      }
      if (ev.tool === "write_file" || ev.tool === "edit_file") {
        set((st) => ({ fileChanges: [...st.fileChanges, ev.summary] }));
      }
    }
    set((st) =>
      patchMsgs(st, (m) =>
        m.map((x) =>
          x.id === msg.id
            ? {
                ...x,
                tools: x.tools.map((t) =>
                  t.tool === ev.tool && t.status === "running"
                    ? { ...t, status: ev.ok ? "ok" : "error", summary: ev.summary, output: ev.summary, diff: ev.diff }
                    : t
                ),
              }
            : x
        )
      )
    );
  },

  setRunning: (r) => set((s) => patchRunning(s, s.activeSessionId, r)),
  // v3.3 补 9：截图事件标记 +1（screen_capture tool-result 到达时调用；ComputerUsePane 事件驱动刷新）
  bumpScreenShots: () => set((s) => ({ screenShotTick: s.screenShotTick + 1 })),
  // v3.3 补 16：Agent open-request → 记录待建 tab（BrowserPanel 消费后清空）
  setPendingBrowserOpen: (url) => set({ pendingBrowserOpen: url }),
  // v2.13：abortController 按会话存（并行会话互相踩——stop 失效/停错对象修复）
  setAbortController: (c) =>
    set((s) => {
      const sid = targetId(s) ?? s.activeSessionId ?? "";
      if (!sid) return {};
      const abortControllers = { ...s.abortControllers };
      if (c) abortControllers[sid] = c;
      else delete abortControllers[sid];
      return { abortControllers };
    }),
  clearAbortController: (sid) =>
    set((s) => {
      if (!sid || !s.abortControllers[sid]) return {};
      const abortControllers = { ...s.abortControllers };
      delete abortControllers[sid];
      return { abortControllers };
    }),
  abortRun: (sid) => {
    const st = useStore.getState();
    const target = sid ?? st.activeSessionId ?? "";
    st.abortControllers[target]?.abort();
    if (target && st.abortControllers[target]) {
      const abortControllers = { ...st.abortControllers };
      delete abortControllers[target];
      useStore.setState({ abortControllers });
    }
  },

  setUseWorktree: (v) => set({ useWorktree: v }),
  setPlan: (p) =>
    set((s) => {
      const sid = targetId(s) ?? s.activeSessionId ?? "";
      const plansBySession = { ...s.plansBySession, [sid]: p };
      const out: Partial<StoreState> = { plansBySession };
      if (!sid || sid === s.activeSessionId) out.plan = p;
      return out;
    }),
  clearPlan: () =>
    set((s) => {
      // v4.0 审计修复（M1）：清视图同时清该会话的 plansBySession 残留——原实现只清
      // 视图 plan，已决策/已取消的计划卡在切换会话后会从 plansBySession 复活
      const sid = s.activeSessionId ?? "";
      const plansBySession = { ...s.plansBySession };
      if (sid in plansBySession) delete plansBySession[sid];
      return { plan: null, plansBySession };
    }),
  clearPlanFor: (sid) =>
    set((s) => {
      if (!sid || !(sid in s.plansBySession)) return {};
      const plansBySession = { ...s.plansBySession };
      delete plansBySession[sid];
      const out: Partial<StoreState> = { plansBySession };
      if (sid === s.activeSessionId) out.plan = null;
      return out;
    }),
  setWorktree: (wt) => set({ worktree: wt, worktreeNote: "" }),
  setEgress: (v) => set(v ? { egressUntil: v.until, egressMinutes: v.minutes } : { egressUntil: null, egressMinutes: null }),
  addWorktreeNote: (note) => set({ worktreeNote: note }),
  clearWorktree: () => set({ worktree: null, worktreeNote: "" }),

  requestApproval: (ev, sessionId) =>
    set((s) => ({
      approvals: [...s.approvals, { id: ev.id, description: ev.description, risk: ev.risk, sessionId }],
    })),

  resolveApproval: (approved) => {
    // v3.5 审计修复：只处理**当前会话**的审批（多会话并行时全局队列混入其他会话
    // 的审批——弹窗处理/全部允许会误伤后台会话的挂起审批）
    const sid = get().activeSessionId ?? "";
    const a = get().approvals.find((x) => !sid || x.sessionId === sid);
    if (!a) return;
    // 从队列移除当前审批（弹窗自动显示下一个）
    set((s) => ({ approvals: s.approvals.filter((x) => x.id !== a.id) }));
    // v3.6 审计修复：原 .catch(() => {}) 静默——请求失败时服务端 pendingApprovals 挂起
    // 等待、任务永久悬挂且用户无感知；失败重新入队 + 错误提示（用户可重试）
    apiFetch(`/api/approvals/${a.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved }),
    }).catch(() => {
      get().addErrorFor(a.sessionId ?? sid, "审批提交失败（网络错误），已恢复审批弹窗——请重新点击允许/拒绝");
      set((s) => ({ approvals: [...s.approvals, a] }));
    });
  },

  /** v3.1 审批流优化：批量决策（并行工具调用堆积多个审批时一键全允/全拒） */
  resolveAllApprovals: (approved) => {
    const sid = get().activeSessionId ?? "";
    const list = get().approvals.filter((x) => !sid || x.sessionId === sid);
    if (!list.length) return;
    set((s) => ({ approvals: s.approvals.filter((x) => !list.some((l) => l.id === x.id)) }));
    for (const a of list) {
      apiFetch(`/api/approvals/${a.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved }),
      }).catch(() => {
        // v3.6：失败项重新入队 + 提示（其余项继续，不整体回滚）
        get().addErrorFor(a.sessionId ?? sid, "批量审批部分提交失败（网络错误），已恢复对应审批弹窗");
        set((s) => ({ approvals: s.approvals.some((x) => x.id === a.id) ? s.approvals : [...s.approvals, a] }));
      });
    }
  },

  setAskQuestion: (q, sessionId) =>
    set((s) => {
      // v4.0 审计修复（M3）：按会话存储——后台会话的提问不覆盖当前视图提问；
      // 视图字段只跟随当前会话（切换会话时由 setActiveSessionId 回填）
      const sid = sessionId ?? s.activeSessionId ?? "";
      const askBySession = { ...s.askBySession, [sid]: q };
      const out: Partial<StoreState> = { askBySession };
      if (!sid || sid === s.activeSessionId) out.askQuestion = q;
      return out;
    }),
  resolveAskQuestion: (answer) => {
    const q = get().askQuestion;
    if (!q) return;
    const sid = get().activeSessionId ?? "";
    set({ askQuestion: null, askBySession: { ...get().askBySession, [sid]: null } });
    // v3.6 审计修复：原 .catch(() => {}) 静默——请求失败时服务端 pendingQuestions
    // 挂起、Agent 永久等待且用户无感知；失败恢复弹窗 + 提示（用户可重试）
    apiFetch(`/api/ask/${q.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    }).catch(() => {
      // v4.0：错误路由到提问所属会话（原全局 addError 在 eventTarget 陈旧时写错会话）
      get().addErrorFor(sid, "提问提交失败（网络错误），已恢复提问弹窗——请重新回答");
      set({ askQuestion: q, askBySession: { ...get().askBySession, [sid]: q } });
    });
  },

  /** v2.5：subagent-start → 主对话流委派条目挂 subagentId + 初始化线程（右侧栏详情数据源） */
  /** v2.5：subagent-start → 主对话流委派条目挂 subagentId + 初始化线程（右侧栏详情数据源）。
   *  v2.9：自动打开右侧栏子 Agent tab（label = Agent 名）+ 激活（实时跟随） */
  startSubagent: (ev) =>
    set((s) => {
      const out = patchMsgs(s, (m) => attachSubagentId(m, ev));
      const tab: RightTab = { id: `subagent:${ev.id}`, kind: "subagent", label: ev.name, subagentId: ev.id };
      const exists = s.rightTabs.some((t) => t.id === tab.id);
      const subagentThreads = { ...s.subagentThreads, [ev.id]: newSubagentThread(ev) };
      // v2.13：后台会话的子 Agent 不污染视图右侧栏（不加 tab 不抢 activeRightTab；
      // 线程数据仍记录——用户切到该会话后手动打开 tab 可见）
      const isViewConn = !s.eventTarget || s.eventTarget === s.activeSessionId;
      if (!isViewConn) return { ...out, subagentThreads };
      return {
        ...out,
        subagentThreads,
        rightTabs: exists ? s.rightTabs : [...s.rightTabs, tab],
        activeRightTab: tab.id, // 实时跟随：新子 Agent 启动即切换显示
      };
    }),

  /** v2.5：带 subagentId 的子智能体内部事件 → 收集进线程消息流（不进入主消息流）
   *  v3.6：不可变更新（routeSubagentEvent 返回新线程对象——按线程订阅的组件正确重渲染） */
  updateSubagent: (ev) => {
    const s = useStore.getState();
    if (!ev || !("subagentId" in ev) || !ev.subagentId) return;
    const t = s.subagentThreads[ev.subagentId];
    if (!t) return;
    const next = routeSubagentEvent(t, ev);
    if (next) useStore.setState({ subagentThreads: { ...s.subagentThreads, [ev.subagentId]: next } });
  },

  /** v2.5：subagent-done → 线程状态与最终摘要 */
  finishSubagent: (ev) =>
    set((s) => {
      const t = s.subagentThreads[ev.id];
      if (!t) return {};
      return {
        subagentThreads: {
          ...s.subagentThreads,
          [ev.id]: {
            ...t,
            status: ev.ok ? "done" : "error",
            ok: ev.ok,
            steps: ev.steps,
            toolCount: ev.toolCount,
            summary: ev.text,
          },
        },
      };
    }),

  /** v2.5：打开/关闭右侧栏子智能体详情弹窗 */
  /** v2.9：打开右侧栏 tab（已存在则激活；subagent-start 自动调用） */
  openRightTab: (tab) =>
    set((s) => {
      const id = tab.id ?? `${tab.kind}:${tab.subagentId ?? Date.now()}`;
      const exists = s.rightTabs.some((t) => t.id === id);
      if (exists) return { activeRightTab: id };
      return { rightTabs: [...s.rightTabs, { id, kind: tab.kind, label: tab.label, subagentId: tab.subagentId }], activeRightTab: id };
    }),
  closeRightTab: (id) =>
    set((s) => {
      const idx = s.rightTabs.findIndex((t) => t.id === id);
      if (idx < 0) return {};
      const rightTabs = s.rightTabs.filter((t) => t.id !== id);
      let activeRightTab = s.activeRightTab;
      if (activeRightTab === id) {
        // 激活相邻 tab（优先右侧；无则左侧；无则 null）
        activeRightTab = rightTabs[Math.min(idx, rightTabs.length - 1)]?.id ?? null;
      }
      return { rightTabs, activeRightTab };
    }),
  setActiveRightTab: (id) => set({ activeRightTab: id }),

  setReport: (content) =>
    set((s) =>
      patchMsgs(s, (m) =>
        m.map((x, i) =>
          i === m.length - 1 && x.role === "assistant" ? { ...x, report: content } : x
        )
      )
    ),

  usage: { cacheHit: 0, cacheMiss: 0, promptTokens: 0, completionTokens: 0 },
  // v3.6：setUsage（直接写 usage）删除——仅 setUsageFor 按会话写入（api.ts 消费）
  setUsageFor: (sid, u) =>
    set((s) => {
      const usageBySession = { ...s.usageBySession, [sid]: u };
      const out: Partial<StoreState> = { usageBySession };
      if (sid === s.activeSessionId) out.usage = u;
      return out;
    }),

  finishAssistant: () =>
    set((s) => {
      const sid = targetId(s);
      return {
        ...patchMsgs(s, (m) =>
          m.map((x, i) =>
            i === m.length - 1 && x.role === "assistant"
              ? { ...x, streaming: false, endedAt: x.endedAt ?? Date.now() }
              : x
          )
        ),
        ...patchRunning(s, sid, false),
      };
    }),

  // v2.13：按显式会话收尾（sendChat finally/catch 用本连接 connSid——
  // 修复多会话并行时 finally 读全局 eventTarget 跨会话清 running/写错会话）
  finishAssistantFor: (sid) =>
    set((s) => {
      if (!sid) return {};
      const base = s.sessionCache[sid] ?? (sid === s.activeSessionId ? s.messages : []);
      const msgs = base.map((x, i) =>
        i === base.length - 1 && x.role === "assistant"
          ? { ...x, streaming: false, endedAt: x.endedAt ?? Date.now() }
          : x
      );
      const sessionCache = { ...s.sessionCache, [sid]: msgs };
      const out: Partial<StoreState> = { ...patchRunning(s, sid, false), sessionCache };
      if (sid === s.activeSessionId) out.messages = msgs;
      // v3.2：收尾清重试信息
      if (s.retryBySession[sid]) {
        const retryBySession = { ...s.retryBySession };
        delete retryBySession[sid];
        out.retryBySession = retryBySession;
      }
      return out;
    }),

  addError: (msg) => {
    get().finishAssistant();
    set((s) =>
      patchMsgs(s, (m) => [
        ...m,
        { id: nextId(), role: "assistant", text: `⚠️ ${msg}`, tools: [], ts: Date.now() },
      ])
    );
  },

  // v2.13：按显式会话追加错误（sendChat catch 用本连接 connSid——错误行不写错会话）
  addErrorFor: (sid, msg) => {
    if (!sid) return;
    get().finishAssistantFor(sid);
    set((s) => {
      const base = s.sessionCache[sid] ?? (sid === s.activeSessionId ? s.messages : []);
      const msgs = [
        ...base,
        { id: nextId(), role: "assistant" as const, text: `⚠️ ${msg}`, tools: [], ts: Date.now() },
      ];
      const sessionCache = { ...s.sessionCache, [sid]: msgs };
      const out: Partial<StoreState> = { sessionCache };
      if (sid === s.activeSessionId) out.messages = msgs;
      return out;
    });
  },

  agentWaiting: (ev) =>
    set((s) => {
      const t = s.subagentThreads[ev.id];
      if (!t) return {};
      const msg: SubagentMsg = { id: nextId(), text: `⏸ 子智能体等待父级消息：${ev.message}`, tools: [], step: t.messages.length + 1 };
      return { subagentThreads: { ...s.subagentThreads, [ev.id]: { ...t, messages: [...t.messages, msg] } } };
    }),

  agentResumed: (ev) =>
    set((s) => {
      const t = s.subagentThreads[ev.id];
      if (!t) return {};
      const msg: SubagentMsg = { id: nextId(), text: "▶ 父级已回复，任务继续", tools: [], step: t.messages.length + 1 };
      return { subagentThreads: { ...s.subagentThreads, [ev.id]: { ...t, messages: [...t.messages, msg] } } };
    }),

  codeViewFile: null,
  setCodeViewFile: (path) => set({ codeViewFile: path }),

  reset: () =>
    set({
      messages: [],
      runningIds: [],
      running: false,
      approvals: [],
      askQuestion: null,
      askBySession: {},
      diffContent: "",
      fileChanges: [],
      currentStep: 1,
      stepStartTimes: {},
      currentPhase: null,
      plan: null,
      plansBySession: {},
      subagentThreads: {},
      rightTabs: [],
      activeRightTab: null,
      todos: [],
      todosBySession: {},
      usage: { cacheHit: 0, cacheMiss: 0, promptTokens: 0, completionTokens: 0 },
      usageBySession: {},
      traceBySession: {},
      abortControllers: {},
    }),
  }),
  {
    name: "infu-chat", // localStorage 持久化（设置项；消息已由 v2.1 服务端会话库托管）
    partialize: (s) => ({
      root: s.root,
      modelId: s.modelId,
      useWorktree: s.useWorktree,
      activeSessionId: s.activeSessionId,
      fontSize: s.fontSize,
      streamCursor: s.streamCursor,
      theme: s.theme,
      // v2.9：工作树状态持久化（刷新不丢——未操作前按钮不消失）
      worktree: s.worktree,
      worktreeNote: s.worktreeNote,
      // 折叠是临时 UI 状态，不持久化（刷新后恢复展开，避免"侧栏消失了"的误判）
      sidebarWidth: s.sidebarWidth,
      detailsOpen: s.detailsOpen,
      detailsWidth: s.detailsWidth,
    }),
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as Partial<StoreState>;
      // 丢弃持久化的旧 messages（v1 数据由 maybeMigrateV1 单独导入为会话）
      const { messages: _oldMsgs, ...rest } = p;
      // 折叠状态永不从持久化恢复（旧版本可能存了 true；刷新后一律展开）
      const { sidebarCollapsed: _oldCollapsed, ...rest2 } = rest;
      // v2.6：白名单合并——只保留当前 state 存在的键（防旧版本遗留字段
      // 如 orchestrate/mode 混入导致潜在运行时异常；旧脏数据刷新即清理）
      const clean: Record<string, unknown> = {};
      for (const k of Object.keys(current) as Array<keyof StoreState>) {
        if (k in rest2) clean[k as string] = (rest2 as Record<string, unknown>)[k as string];
      }
      return { ...current, ...clean };
    },
  }
));
