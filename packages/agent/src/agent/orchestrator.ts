/**
 * InFu 分层编排（M4）— Planner（规划）→ Executor（执行）→ Reviewer（审查）
 *
 * PRD 数据流（docs/TECHNICAL-SELECTION.md 六节）：
 *   用户输入 → Planner：只读分析 + 任务拆解 → 输出执行计划
 *   → （可选）用户确认计划
 *   → Executor：全工具按计划执行（审批/沙箱/审计照旧）
 *   → Reviewer：只读审查改动质量/测试/风险 → 输出审查意见
 *   → 汇总交付报告（执行报告 + 审查小节）
 *
 * 安全：Planner/Reviewer 只注入只读工具（写工具不进循环 = 架构级只读保证），
 * 计划确认复用现有审批机制（用户确认后才开始改代码）。
 */

import type { AgentEvent, PhaseId, RiskLevel, ScopeRule, ToolDef } from "@infu/shared";
import { runAgent, withImages, DEFAULT_SYSTEM_PROMPT, type RunResult } from "./loop.js";
import { TOOLS, getReadOnlyTools, getReviewerTools } from "../tools/index.js";
import { withMcpTools } from "../mcp/index.js";
import { resolveMaxSteps } from "./steps.js";
import { interpretPlanFeedback } from "./plan-feedback.js";
import { sedimentTask } from "../memory/index.js";
import { loadConfig } from "../providers/registry.js";
import type { ModelCandidate } from "../providers/gateway.js";
import type { ChatMessageLike } from "../providers/chat.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** 运行时模型配置（与 loop 的 modelConfig 同构） */
export interface ModelConfigRuntime {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey: string;
  contextWindow?: number;
  thinkingLevels?: number;
}

/** Planner 角色提示词：只读分析 + 拆解步骤，绝不修改 */
/** Planner 角色提示词：先判断消息类型（寒暄/闲聊直接简短回复，不扫描不规划）；开发任务才做只读分析 + 拆解步骤 */
export const PLANNER_SYSTEM_PROMPT = `你是 Infu 的规划员（Planner），负责为开发任务制定执行计划。
工作方式：
1. 先用只读工具了解项目（project_scan / list_directory / read_file / search_code / git_status / git_diff）。不要修改任何文件、不要运行有副作用的命令。
2. 把任务拆解为清晰的执行步骤，输出一份可执行的计划：
   - 任务理解（一句话）
   - 执行步骤（编号列表，每步说明要做什么、涉及哪些文件/命令）
   - 验证方式（如何确认任务完成，如运行测试）
3. 计划要具体、可执行，供 Executor 按步骤落地。
4. 只输出计划本身，不要执行任何修改操作。
5. 最后单独输出一行「【建议步数】N」（N 为 1-60 的整数，表示执行阶段建议的最大工具轮次；简单任务给 5-10，复杂任务给 20-40）。`;

/** Executor 角色提示词：沿用默认 + 按计划执行（若附带计划）/ 自主规划（无计划时） */
export const EXECUTOR_SYSTEM_PROMPT =
  DEFAULT_SYSTEM_PROMPT +
  `\n\n若任务附带【执行计划】小节：严格按计划执行；若发现计划有误（如文件不存在、方案不可行），先说明偏差原因再调整执行。\n若无执行计划：自主分析项目、拆解步骤并执行（复杂任务可先用 todo_write 建立任务清单跟踪进度）。`;

/** Reviewer 角色提示词：只读审查，禁止一切写操作 */
export const REVIEWER_SYSTEM_PROMPT = `你是 InFu 的审查员（Reviewer），负责审查任务执行结果的质量。
工作方式：
1. 你只有只读工具（read_file / search_code / list_directory / project_scan / git_status / git_diff / run_test），绝对禁止修改任何文件、禁止运行有副作用的命令。
2. 用 git_diff 检查改动是否符合任务要求、是否引入问题；用 run_test 验证测试是否通过（如适用）。
3. 输出审查意见：
   - 结论（通过 / 需修改，给出理由）
   - 问题清单（按严重程度列出，引用具体文件）
   - 遗漏风险（边界情况、测试未覆盖等）
   - 建议（若结论为"需修改"，给出具体建议）
4. 意见要具体、可执行，基于工具返回的事实，不要臆测。`;

export interface OrchestratedRunOptions {
  /** 模型配置（provider/model/baseURL/apiKey） */
  modelConfig: ModelConfigRuntime;
  /** 备用模型链（v2.2 降级：主模型重试耗尽后依次切换；本任务内保持） */
  fallbackModelConfigs?: ModelConfigRuntime[];
  /** 按角色指定模型（v2.2 轻量模型选择：planner/executor/reviewer 各自独立主模型 + 降级链） */
  roleModelConfigs?: Partial<Record<PhaseId, { modelConfig: ModelConfigRuntime; fallbackModelConfigs?: ModelConfigRuntime[] }>>;
  /** 初始对话消息（v2.2 断点恢复/继续会话的消息级重建；各阶段注入） */
  initialMessages?: ChatMessageLike[];
  prompt: string;
  /** v3.1 附件：文件/文件夹路径引用文本（注入所有阶段——规划/审查也知道附件存在） */
  attachmentText?: string;
  /** v3.1 附件：图片 base64 列表（仅 Executor 阶段走视觉；Planner/Reviewer 只读分析不看图） */
  attachmentImages?: string[];
  /** v3.1 附件只读白名单（用户附加文件/文件夹绝对路径；read_file/read_files 放行） */
  extraReadDirs?: string[];
  /** v2.9：当前会话 id（per-session 子 Agent 上限计数；子智能体继承） */
  sessionId?: string;
  /** 模板任务 id（v2.2 动态步数启发式参考，可选） */
  templateId?: string;
  /** 思考级别（v2 模型管理：4 档 UI，按模型实际级别数自动映射；1-4，缺省 2） */
  thinkingLevel?: number;
  /** 角色独立思考级别（v2.3 角色路由面板：角色级优先于全局 thinkingLevel） */
  roleThinking?: Partial<Record<PhaseId, number>>;
  /** 项目根目录（工具操作边界） */
  root: string;
  /** 项目归属根目录（worktree 执行时保存项目记忆、历史并清理 worktree） */
  projectRoot?: string;
  emit: (event: AgentEvent) => void;
  requestApproval: (description: string, risk: RiskLevel) => Promise<boolean>;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  /** Planner 计划是否需用户确认后执行（默认 true） */
  planApproval?: boolean;
  /**
   * v2.6 主流 Agent 式流程开关（默认 false）：
   * false = 单一 Agent 循环直接执行（模型自主：寒暄直接回复、复杂任务自主探索/规划/执行；
   *         不弹计划确认、不强制 Reviewer——主流默认行为）；
   * true  = 显式启用分层编排 Planner→(确认)→Executor→Reviewer（CLI --orchestrate / API orchestrate）。
   */
  orchestrate?: boolean;
  /**
   * 计划确认钩子（v2.3 三态：execute/revise/abort）。
   * 返回 null = 用户取消（中止任务）；否则返回用户提交的内容：
   *  plan 为编辑后的计划文本（可空 = 用原计划），feedback 为用户自由文本回复
   * （如"批准执行" / "先不做" / "改成只改 README"——由编排层调模型判断意图）。
   */
  confirmPlan?: (planText: string) => Promise<{ plan?: string; feedback: string } | null>;
  // ── v2.3 扩展机制 ──
  /**
   * Executor 阶段额外工具（MCP 动态注入，v2.3 批 1）。
   * 只作用于 Executor——Planner/Reviewer 保持架构级只读，不注入任何额外工具。
   */
  executorTools?: ToolDef[];
  /**
   * 阶段级精确续跑（v2.2 遗留）：已确认过计划的会话续跑时跳过 Planner（不重新规划）。
   * 由调用方从事件流推断（inferResumePhase）；resumePlanText 为上次确认的计划。
   */
  startPhase?: "executor";
  resumePlanText?: string;
  // ── v2.3 批 2 ──
  /** 插件钩子（只作用于 Executor 阶段——插件工具只在 Executor 注入，钩子与之同生命周期） */
  hooks?: import("./loop.js").AgentRunOptions["hooks"];
  /** skill 发现层提示段（追加到 Executor system；Planner/Reviewer 保持简洁，v1 不注入） */
  skillsPrompt?: string;
  /** v2.5：子智能体发现层提示段（可用 agent 角色 name+description；追加到 Executor system） */
  agentsPrompt?: string;
  // ── v2.6 记忆系统 ──
  /** 项目指令段（INFU.md 全量；注入所有阶段 system——规则是权威约束，规划/审查也须遵守） */
  infuPrompt?: string;
  /** 记忆引导段（追加到 Executor system：memory_read/write 用法） */
  memoryPrompt?: string;
  /** 路径作用域规则（INFU.md「路径作用域」节；入 ToolContext 供文件工具校验） */
  scopeRules?: ScopeRule[];
  /** v2.6 收尾：向用户提问（ask_user 工具通道；CLI/Web 接线；未提供时工具返回不可用） */
  askUser?: (
    question: string,
    options?: Array<string | { label: string; desc?: string; recommended?: boolean }>
  ) => Promise<string | null>;
  /** v6.0（S4）：任务级 Token 预算（跨 Planner/Executor/Reviewer 各阶段累计扣减；0/缺省=不限制） */
  taskTokenBudget?: number;
}

/** 编排运行结果（含各阶段产出） */
export interface OrchestratedResult extends RunResult {
  planText: string;
  reviewText: string;
}

const ABORTED_MSG = "任务已停止（用户中止）";

/**
 * 分层编排入口：Planner →（确认）→ Executor → Reviewer → 汇总报告。
 * 任一段被中止（abortSignal）立即返回，不再进入下一阶段。
 */
export async function runOrchestratedTask(opts: OrchestratedRunOptions): Promise<OrchestratedResult> {
  const {
    modelConfig, fallbackModelConfigs, roleModelConfigs, initialMessages, prompt, root, projectRoot = root, emit, requestApproval,
    maxSteps, abortSignal, planApproval = true, orchestrate = false,
    confirmPlan, templateId, thinkingLevel, roleThinking, executorTools, startPhase, resumePlanText,
    hooks, skillsPrompt, agentsPrompt, infuPrompt, memoryPrompt, scopeRules, askUser,
    attachmentText, attachmentImages, extraReadDirs, sessionId, taskTokenBudget = 0,
  } = opts;

  /** v3.1 附件引用块（各阶段纯文本注入；planner/reviewer 无需图片 parts） */
  const attachText = (base: string) => (attachmentText ? `${base}\n\n${attachmentText}` : base);
  /** v3.1 Executor 输入：文本（含附件引用）+ 图片视觉 parts */
  const execPromptInput = (text: string) => withImages(text, attachmentImages ?? []);

  let planText = resumePlanText ?? "";
  let reviewText = "";
  // 批准计划时用户附带的指示（v2.3：如"不要动 xxx 文件"）——注入执行阶段 prompt
  let userInstruction = "";

  // v3：LLM usage 聚合（各阶段 runAgent 汇总 → done 携带缓存命中统计；v2.12 四桶）
const usageAgg = { cacheHit: 0, cacheMiss: 0, promptTokens: 0, completionTokens: 0 };
  const accUsage = (r?: { usage?: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number } }) => {
    if (!r?.usage) return;
    usageAgg.cacheHit += r.usage.cacheHit;
    usageAgg.cacheMiss += r.usage.cacheMiss;
    usageAgg.promptTokens += r.usage.promptTokens;
    usageAgg.completionTokens += r.usage.completionTokens;
  };
  // v6.0（S4）+ 审计修复：跨阶段预算扣减——每阶段下发「剩余预算」，阶段内用尽即停。
  // 已耗尽时返回 -1 哨兵（loop 守卫对负值立即停）——原 Math.max(0, 剩余) 使剩余 0
  // 时 runAgent 判「预算未启用 = 不限制」，任一阶段耗尽后后续阶段无限额跑模型。
  const remainBudget = () => {
    if (taskTokenBudget <= 0) return 0;
    const remaining = taskTokenBudget - (usageAgg.promptTokens + usageAgg.completionTokens);
    return remaining <= 0 ? -1 : remaining;
  };
  // 累计真实用量已 ≥ 预算（编排层据此跳过后续阶段——Executor 摘要不该带着预算用尽
  // 消息白跑一轮 Reviewer，autoRefine 也不该在预算外发起模型调用）
  const budgetExhausted = () =>
    taskTokenBudget > 0 && (usageAgg.promptTokens + usageAgg.completionTokens) >= taskTokenBudget;

  const aborted = () => abortSignal?.aborted === true;

  /** 角色路由（v2.2 轻量模型选择）：角色指定 > 默认模型；fallback 同理 */
  const roleCfg = (phase: PhaseId) => {
    const r = roleModelConfigs?.[phase];
    return {
      modelConfig: r?.modelConfig ?? modelConfig,
      fallbackModelConfigs: r?.fallbackModelConfigs ?? fallbackModelConfigs,
    };
  };
  /** 角色独立思考级别（v2.3）：角色级优先于全局 thinkingLevel */
  const roleThink = (phase: PhaseId): number => roleThinking?.[phase] ?? thinkingLevel ?? 2;

  // 默认计划确认：复用审批机制（CLI 交互 / -y 自动批准；拒绝 = 取消任务）
  const confirm: NonNullable<OrchestratedRunOptions["confirmPlan"]> = confirmPlan ?? (async (text: string) => {
    const approved = await requestApproval(
      `确认执行以下计划吗？（批准后将开始修改代码）\n\n${text.slice(0, 3000)}`,
      "medium"
    );
    if (!approved) return null;
    return { plan: undefined, feedback: "批准执行" };
  });

  // 计划确认候选模型链（意图判断复用；主 + 降级）
  const feedbackCandidates: ModelCandidate[] = [
    { provider: modelConfig.provider, model: modelConfig.model, baseURL: modelConfig.baseURL, apiKey: modelConfig.apiKey },
    ...(fallbackModelConfigs ?? []).map((f) => ({ provider: f.provider, model: f.model, baseURL: f.baseURL, apiKey: f.apiKey })),
  ];

  // ── v2.6 主流 Agent 式流程（默认）：单一 Agent 循环直接执行 ──
  // 模型自主决定：寒暄直接回复（0 工具自然结束）、复杂任务自主探索/建清单/执行。
  // 不强制 Planner/计划确认/Reviewer；分层编排仅在 orchestrate=true 时显式启用。
  if (!orchestrate) {
    const rc = roleCfg("executor");
    const execMaxSteps = resolveMaxSteps({ explicit: maxSteps, planText: "", prompt, templateId });
    const exec = await runAgent({
      modelConfig: rc.modelConfig,
      fallbackModelConfigs: rc.fallbackModelConfigs,
      thinkingLevel: roleThink("executor"),
      initialMessages,
      system: EXECUTOR_SYSTEM_PROMPT + (skillsPrompt ?? "") + (agentsPrompt ?? "") + (infuPrompt ?? "") + (memoryPrompt ?? ""),
      // v3.1：附件引用文本 + 图片视觉 parts
      prompt: execPromptInput(attachText(prompt)),
      tools: executorTools ? withMcpTools(TOOLS, executorTools) : TOOLS,
      hooks,
      root,
      projectRoot,
      emit,
      requestApproval,
      maxSteps: execMaxSteps,
      abortSignal,
      scopeRules,
      extraReadDirs,
    sessionId,
      askUser,
      phase: { id: "executor", label: "执行", model: rc.modelConfig.model },
      // 终态由本层按「是否真实干活」决定：纯文本回复（寒暄/问答）不发交付报告不沉淀
      suppressFinal: true,
      // v6.0（S4）：直接模式预算全量下发
      taskTokenBudget,
    });
    if (aborted()) {
      return { text: ABORTED_MSG, steps: 0, toolCount: 0, approvals: exec.approvals, toolLogs: exec.toolLogs, planText: "", reviewText: "" };
    }
    const worked = exec.toolCount > 0;
    // 真实干活（调过工具）才任务沉淀；纯文本回复直接 done（对齐 v2.6.2 寒暄短路语义）
    accUsage(exec);
    let commitNote = "";
    if (worked) {
      // v3.5：自动 git 提交（可选）+ 记忆自动提炼（默认开，失败静默）
      try { commitNote = await tryAutoCommit(root, prompt); } catch { /* 忽略 */ }
      // 审计修复：预算耗尽后 autoRefine 仍发起无限额模型调用（streamChatWithFailover
      // 完整调用一次、不计入 usageAgg）——预算用尽路径跳过提炼
      if (!budgetExhausted()) {
        try { accUsage({ usage: await tryAutoRefine(projectRoot, prompt, exec, emit) }); } catch { /* 忽略 */ }
      }
    }
    if (worked && loadConfig()?.memory?.autoSediment !== false) {
      try {
        const sed = sedimentTask({
          root: projectRoot,
          prompt,
          result: exec,
          reviewText: "",
          modelLabel: `${rc.modelConfig.provider}/${rc.modelConfig.model}`,
        });
        // v3：只读容器跳过沉淀时 path 为空，不发 memory-sediment 事件
        if (sed.path) emit({ type: "memory-sediment", path: sed.path, summary: sed.entry });
      } catch (e) {
        emit({ type: "error", message: `任务沉淀失败（不影响交付）：${(e as Error).message}` });
      }
    }
    try { await discardCleanWorktrees(projectRoot); } catch { /* 忽略 */ }
    const finalText = exec.text + commitNote;
    emit({ type: "done", text: finalText, toolCount: exec.toolCount, steps: exec.steps, usage: usageAgg });
    return { text: finalText, steps: exec.steps, toolCount: exec.toolCount, approvals: exec.approvals, toolLogs: exec.toolLogs, planText: "", reviewText: "", usage: usageAgg };
  }

  // ① Planner：只读规划（v2.2 按角色路由模型；v2.3 阶段级续跑 startPhase=executor
  //    时跳过——计划沿用上次确认的 resumePlanText）
  if (startPhase !== "executor") {
    // 审计修复：预算已在执行前耗尽 → 跳过 Planner（不再发起模型调用，emit 明确文案）
    if (budgetExhausted()) {
      const msg = "任务 Token 预算已用尽，任务在此停止。已完成的工作已保存，可调整预算后发送「继续」接着干。";
      emit({ type: "error", message: msg });
      emit({ type: "done", text: msg, toolCount: 0, steps: 0, usage: usageAgg });
      return { text: msg, steps: 0, toolCount: 0, approvals: { required: 0, approved: 0, denied: 0 }, toolLogs: [], planText: "", reviewText: "" };
    }
    const rc = roleCfg("planner");
    const plan = await runAgent({
      modelConfig: rc.modelConfig,
      fallbackModelConfigs: rc.fallbackModelConfigs,
      thinkingLevel: roleThink("planner"),
      initialMessages,
      // v2.6：项目指令全量注入所有阶段（权威规则；规划也须遵守）
      system: PLANNER_SYSTEM_PROMPT + (infuPrompt ?? ""),
      prompt: `${attachText(prompt)}\n\n请先分析项目并制定执行计划，不要修改任何文件。`,
      tools: getReadOnlyTools(),
      root,
      projectRoot,
      emit,
      requestApproval,
      maxSteps: 12,
      abortSignal,
      scopeRules,
      extraReadDirs,
    sessionId,
      askUser,
      phase: { id: "planner", label: "规划", model: rc.modelConfig.model },
      suppressFinal: true,
      taskTokenBudget: remainBudget(),
    });
    accUsage(plan);
    if (aborted()) {
      return { text: ABORTED_MSG, steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText: "", reviewText: "" };
    }
    planText = plan.text.trim();

    // v2.6.2 寒暄/闲聊短路：Planner 未调用任何工具且未产出计划（无【建议步数】）——
    // 视为非开发任务，其流式文本已进对话流（无前缀标记），此处只收尾，不重发、不进确认/执行/审查。
    // 判断依据：真开发任务 Planner 必然调用只读工具或输出带【建议步数】的计划。
    // v3.9 审计修复（C2）：原条件过宽——Planner 对开发任务未调工具且输出未按
    // 【建议步数】格式时整任务被吞（文本直接作为最终回复）。收窄：文本含任务意图词
    // 或长度像计划（≥200 字）时仍进执行阶段，由 Executor 自主判断。
    const TASK_INTENT =
      /(实现|修复|重构|创建|新建|添加|增加|修改|优化|完成|解决|分析|检查|测试|开发|集成|部署|迁移|升级|调整|支持|调研|评审|审查|构建|初始化|报错|异常|问题|改成|编写|做一个|写一个)/;
    if (
      plan.toolCount === 0 &&
      !planText.includes("【建议步数】") &&
      planText.length < 200 &&
      !TASK_INTENT.test(planText)
    ) {
      const reply = planText;
      emit({ type: "done", text: reply, toolCount: 0, steps: 0, usage: usageAgg });
      return { text: reply, steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText: "", reviewText: "" };
    }

    // ② 计划确认（v2.3 三态：用户自由文本回复 → 模型判断 execute/revise/abort）
    //    execute → 执行（回复中的指示注入执行阶段）；revise → 按意见重新规划再确认；abort → 中止任务
    if (planApproval && planText && planText !== ABORTED_MSG) {
      let reviseRounds = 0;
      for (;;) {
        const decision = await confirm(planText);
        if (aborted()) {
          return { text: ABORTED_MSG, steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
        }
        if (decision === null) {
          // 用户取消
          const msg = "执行计划未获确认，任务已取消";
          emit({ type: "error", message: msg });
          return { text: msg, steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
        }
        // 用户编辑后的计划替换原计划（Web 计划卡片场景）
        if (decision.plan?.trim()) planText = decision.plan.trim();

        // 判断用户回复意图（"先不做" → abort；"改成…" → revise；其余 execute）
        const judged = await interpretPlanFeedback({
          candidates: feedbackCandidates,
          feedback: decision.feedback ?? "",
          planText,
          signal: abortSignal,
        });
        if (judged.usage) {
          usageAgg.cacheHit += judged.usage.cacheHit;
          usageAgg.cacheMiss += judged.usage.cacheMiss;
          usageAgg.promptTokens += judged.usage.promptTokens;
          usageAgg.completionTokens += judged.usage.completionTokens;
          if (judged.usage.promptTokens || judged.usage.completionTokens) {
            emit({ type: "model-call", model: feedbackCandidates[0]?.model ?? modelConfig.model, ...judged.usage });
          }
        }

        if (judged.action === "abort") {
          // 用户要求暂缓/停止：任务中止（不执行、不审查），进度与计划保留可继续
          const msg = "你要求暂缓执行，任务已停止（计划已保存，可稍后继续会话）";
          emit({ type: "error", message: msg });
          return { text: msg, steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
        }
        if (judged.action === "revise" && reviseRounds < 2) {
          // 按用户意见重新规划（最多 2 轮），再确认一次
          reviseRounds++;
          const rc = roleCfg("planner");
          const revised = await runAgent({
            modelConfig: rc.modelConfig,
            fallbackModelConfigs: rc.fallbackModelConfigs,
            thinkingLevel: roleThink("planner"),
            initialMessages,
            system: PLANNER_SYSTEM_PROMPT + (infuPrompt ?? ""),
            prompt: `${attachText(prompt)}\n\n【原计划】（用户要求修改）\n${planText}\n\n【用户修改意见】\n${judged.instruction ?? "请调整计划"}\n\n请按修改意见重新制定执行计划，不要修改任何文件。`,
            tools: getReadOnlyTools(),
            root,
            projectRoot,
            emit,
            requestApproval,
            maxSteps: 12,
            abortSignal,
            scopeRules,
            extraReadDirs,
            sessionId,
            askUser,
            phase: { id: "planner", label: "规划（修订）", model: rc.modelConfig.model },
            suppressFinal: true,
            taskTokenBudget: remainBudget(),
          });
          if (aborted()) {
            return { text: ABORTED_MSG, steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
          }
          accUsage(revised);
          if (revised.text.trim()) planText = revised.text.trim();
          continue; // 再次确认修订后的计划
        }
        // v3.0 审计修复（B2）：修订超过 2 轮时原实现静默落入 execute 分支（修改意见被当
        // 执行指示吞掉，用户无感知）——改为明示用户 + 意见仍作为附加指示注入执行
        if (judged.action === "revise") {
          const overMsg = `已按你的意见修订计划 2 轮，本次修改意见不再重新规划，将作为附加指示随计划执行。`;
          emit({ type: "text", text: overMsg });
          userInstruction = [userInstruction, judged.instruction ?? ""].filter(Boolean).join("\n");
          break;
        }
        // execute：回复中的附加指示注入执行阶段
        if (judged.instruction?.trim()) userInstruction = judged.instruction.trim();
        break;
      }
    }
  }

  // ③ Executor：全工具按计划执行（v2.2 动态步数：显式 > Planner 建议步数 > 启发式 > 默认 30；
  //    v2.3 MCP 动态注入：executorTools 仅此阶段生效，Planner/Reviewer 不暴露）
  const rcExec = roleCfg("executor");
  const execMaxSteps = resolveMaxSteps({
    explicit: maxSteps,
    planText,
    prompt,
    templateId,
  });
  const execPrompt = planText
    ? `${attachText(prompt)}\n\n【执行计划】（Planner 生成，请按其执行）\n${planText}${userInstruction ? `\n\n【用户附加指示】（必须遵守）\n${userInstruction}` : ""}`
    : attachText(prompt);
  const exec = await runAgent({
    modelConfig: rcExec.modelConfig,
    fallbackModelConfigs: rcExec.fallbackModelConfigs,
    thinkingLevel: roleThink("executor"),
    initialMessages,
    system: EXECUTOR_SYSTEM_PROMPT + (skillsPrompt ?? "") + (agentsPrompt ?? "") + (infuPrompt ?? "") + (memoryPrompt ?? ""),
    // v3.1：附件图片仅 Executor 阶段走视觉
    prompt: execPromptInput(execPrompt),
    tools: executorTools ? withMcpTools(TOOLS, executorTools) : TOOLS,
    hooks,
    root,
    projectRoot,
    emit,
    requestApproval,
    maxSteps: execMaxSteps,
    abortSignal,
    scopeRules,
    extraReadDirs,
    sessionId,
    askUser,
    phase: { id: "executor", label: "执行", model: rcExec.modelConfig.model },
    suppressFinal: true,
    taskTokenBudget: remainBudget(),
  });
  if (aborted()) {
    return { text: ABORTED_MSG, steps: exec.steps, toolCount: exec.toolCount, approvals: exec.approvals, toolLogs: exec.toolLogs, planText, reviewText: "" };
  }
  // v6.0（S4）：先并入执行用量，Reviewer 阶段预算按剩余下发
  accUsage(exec);

  // ④ Reviewer：只读审查（执行未中止；v2.2 按角色路由模型）
  // 审计修复：执行阶段已耗尽预算 → 跳过 Reviewer（exec.text 是预算用尽消息，
  // 原实现拿它当执行摘要又白跑一轮审查模型调用）
  if (exec.text && exec.text !== ABORTED_MSG && !budgetExhausted()) {
    const rc = roleCfg("reviewer");
    const review = await runAgent({
      modelConfig: rc.modelConfig,
      fallbackModelConfigs: rc.fallbackModelConfigs,
      thinkingLevel: roleThink("reviewer"),
      initialMessages,
      system: REVIEWER_SYSTEM_PROMPT + (infuPrompt ?? ""),
      prompt: `请审查以下开发任务的执行结果：\n\n【任务】${attachText(prompt)}\n\n【执行摘要】\n${exec.text.slice(0, 4000)}\n\n请用 git_diff / read_file / run_test 等工具核实改动与测试结果，然后输出审查意见。不要修改任何文件。`,
      tools: getReviewerTools(),
      root,
      projectRoot,
      emit,
      requestApproval,
      maxSteps: 10,
      abortSignal,
      scopeRules,
      extraReadDirs,
    sessionId,
      askUser,
      phase: { id: "reviewer", label: "审查", model: rc.modelConfig.model },
      suppressFinal: true,
      taskTokenBudget: remainBudget(),
    });
    accUsage(review);
    reviewText = review.text.trim();
    if (reviewText && reviewText !== ABORTED_MSG) emit({ type: "review", content: reviewText });
  }

  // ⑤ 收尾（v3.1 交付报告已移除）：任务完成事件 + 自动沉淀（L4 项目历史）
  // v3.5：自动 git 提交（可选）+ 记忆自动提炼（默认开，失败静默）
  let commitNote = "";
  if (exec.text !== ABORTED_MSG && exec.toolCount > 0) {
    try { commitNote = await tryAutoCommit(root, prompt); } catch { /* 忽略 */ }
    // 审计修复：预算耗尽后 autoRefine 仍发起无限额模型调用——跳过
    if (!budgetExhausted()) {
      try { accUsage({ usage: await tryAutoRefine(projectRoot, prompt, exec, emit) }); } catch { /* 忽略 */ }
    }
  }

  // v3.5 数据生命周期：任务收尾自动清理无改动的 worktree（.infu/worktrees/ 由
  // server/cli 创建、仅用户手动 merge/discard——无改动任务永久残留）。有改动的保留
  // （用户可能 review / merge）；失败静默不影响交付。
  try {
    await discardCleanWorktrees(projectRoot);
  } catch { /* 忽略 */ }

  // v2.6 任务自动沉淀（L4 项目历史）：结构化元数据归档 .infu/history/YYYY-MM-DD.md。
  // 零额外模型调用（用户拍板方案：报告归档 + 工具补充）；稳定约定/教训由 Agent 中途 memory_write 记录。
  // 沉淀失败不影响交付（try/catch 放行）。v2.7：config.memory.autoSediment=false 时关闭。
  try {
    if (loadConfig()?.memory?.autoSediment === false) throw new Error("__skip_sediment__");
    const sed = sedimentTask({
      root: projectRoot,
      prompt,
      result: exec,
      reviewText,
      modelLabel: `${rcExec.modelConfig.provider}/${rcExec.modelConfig.model}`,
    });
    // v3：只读容器跳过沉淀时 path 为空，不发 memory-sediment 事件
    if (sed.path) emit({ type: "memory-sediment", path: sed.path, summary: sed.entry });
  } catch (e) {
    if ((e as Error).message !== "__skip_sediment__") {
      emit({ type: "error", message: `任务沉淀失败（不影响交付）：${(e as Error).message}` });
    }
  }

  const finalText = exec.text + commitNote;
  emit({ type: "done", text: finalText, toolCount: exec.toolCount, steps: exec.steps, usage: usageAgg });
  return { text: finalText, steps: exec.steps, toolCount: exec.toolCount, approvals: exec.approvals, toolLogs: exec.toolLogs, planText, reviewText, usage: usageAgg };
}

const execFileAsync = promisify(execFile);

/**
 * v3.5 常规设置「自动 git 提交」（general.autoCommit，默认关）：
 * 任务真实干活（调过工具）且未中止时，在任务 root 执行 git add -A + commit，
 * 消息 = 任务指令前 50 字。**绝不 push**（本地提交，用户自行推送/合并）。
 * 非 git 仓库 / 无改动 / 未配置 git 身份 → 静默跳过；提交成功返回提示行。
 * enabled 由调用方解析（测试可直传，避免依赖真实配置）。
 */
export async function tryAutoCommit(root: string, prompt: string, enabled = loadConfig()?.general?.autoCommit === true): Promise<string> {
  try {
    if (!enabled) return "";
    const repo = await execFileAsync("git", ["-C", root, "rev-parse", "--git-dir"], { windowsHide: true, timeout: 5000 }).catch(() => null);
    if (!repo) return ""; // 非 git 仓库
    const status = await execFileAsync("git", ["-C", root, "status", "--porcelain"], { windowsHide: true, timeout: 5000 }).catch(() => null);
    if (!status || !status.stdout.trim()) return ""; // 无改动
    await execFileAsync("git", ["-C", root, "add", "-A"], { windowsHide: true, timeout: 10000 });
    const msg = `InFu: ${prompt.replace(/\s+/g, " ").slice(0, 50)}`;
    const commit = await execFileAsync("git", ["-C", root, "commit", "-m", msg], { windowsHide: true, timeout: 10000 }).catch(() => null);
    if (!commit) return ""; // 无身份等 → 静默
    return `\n\n（已自动提交到本地 git，未推送：${msg}）`;
  } catch {
    return ""; // 失败静默不影响交付
  }
}

/**
 * v3.5 记忆自动提炼（config.memory.autoRefine，默认开）：
 * 任务收尾用轻量模型把本次任务沉淀为项目记忆（conventions/lessons/preferences），
 * 补齐「Agent 不主动写 memory」的缺口（对齐 Codex 会话后自动总结）。
 * 只读校验：仅 Executor 模型配置（避免额外角色模型缺失）；失败静默。
 */
async function tryAutoRefine(root: string, prompt: string, result: RunResult, emit: (e: AgentEvent) => void): Promise<RunResult["usage"] | undefined> {
  try {
    const cfg = loadConfig();
    if (cfg?.memory?.autoRefine === false) return;
    const { refineMemory } = await import("../memory/refine.js");
    return await refineMemory({ root, prompt, result, emit });
  } catch { /* 提炼失败静默 */ }
}

/**
 * v3.5 数据生命周期：清理无改动的 git worktree。
 * 每个 worktree 目录名 = 分支名（server.ts:1417 创建时的 -b <name>）。
 * 无改动（status --porcelain 空）→ worktree remove + 分支删除；
 * 有改动/非 git 仓库/失败 → 保留，用户手动处理。全程静默。
 */
async function discardCleanWorktrees(root: string): Promise<void> {
  const dir = join(root, ".infu", "worktrees");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const wt = join(dir, name);
    try {
      const status = await execFileAsync("git", ["-C", wt, "status", "--porcelain"], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      }).catch(() => null);
      if (!status || status.stdout.trim() !== "") continue; // 非 git / 有改动 → 保留
      await execFileAsync("git", ["worktree", "remove", "--force", wt], { windowsHide: true, timeout: 10000 }).catch(() => {});
      await execFileAsync("git", ["-C", root, "branch", "-D", name], { windowsHide: true, timeout: 10000 }).catch(() => {});
    } catch {
      /* 单个 worktree 失败跳过 */
    }
  }
}
