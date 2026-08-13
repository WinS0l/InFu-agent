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

import type { AgentEvent, OrchestrateMode, PhaseId, RiskLevel, ToolDef } from "@infu/shared";
import { runAgent, buildReport, DEFAULT_SYSTEM_PROMPT, type RunResult } from "./loop.js";
import { TOOLS, getReadOnlyTools, getReviewerTools } from "../tools/index.js";
import { withMcpTools } from "../mcp/index.js";
import { resolveMaxSteps } from "./steps.js";
import { interpretPlanFeedback } from "./plan-feedback.js";
import type { ModelCandidate } from "../providers/gateway.js";
import type { ChatMessageLike } from "../providers/chat.js";

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
export const PLANNER_SYSTEM_PROMPT = `你是 InFu 的规划员（Planner），负责为开发任务制定执行计划。
工作方式：
1. 先用只读工具了解项目（project_scan / list_directory / read_file / search_code / git_status / git_diff）。不要修改任何文件、不要运行有副作用的命令。
2. 把任务拆解为清晰的执行步骤，输出一份可执行的计划：
   - 任务理解（一句话）
   - 执行步骤（编号列表，每步说明要做什么、涉及哪些文件/命令）
   - 验证方式（如何确认任务完成，如运行测试）
3. 计划要具体、可执行，供 Executor 按步骤落地。
4. 只输出计划本身，不要执行任何修改操作。
5. 最后单独输出一行「【建议步数】N」（N 为 1-60 的整数，表示执行阶段建议的最大工具轮次；简单任务给 5-10，复杂任务给 20-40）。`;

/** Executor 角色提示词：沿用默认 + 强调按计划执行 */
export const EXECUTOR_SYSTEM_PROMPT =
  DEFAULT_SYSTEM_PROMPT +
  `\n\n任务会附带【执行计划】小节（Planner 生成）：严格按计划执行；若发现计划有误（如文件不存在、方案不可行），先说明偏差原因再调整执行。`;

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
  /** 模板任务 id（v2.2 动态步数启发式参考，可选） */
  templateId?: string;
  /** 思考级别（v2 模型管理：4 档 UI，按模型实际级别数自动映射；1-4，缺省 2） */
  thinkingLevel?: number;
  /** 角色独立思考级别（v2.3 角色路由面板：角色级优先于全局 thinkingLevel） */
  roleThinking?: Partial<Record<PhaseId, number>>;
  /** 项目根目录（工具操作边界） */
  root: string;
  emit: (event: AgentEvent) => void;
  requestApproval: (description: string, risk: RiskLevel) => Promise<boolean>;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  /** 分层编排模式（默认 full） */
  orchestrate?: OrchestrateMode;
  /** Planner 计划是否需用户确认后执行（默认 true） */
  planApproval?: boolean;
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
    modelConfig, fallbackModelConfigs, roleModelConfigs, initialMessages, prompt, root, emit, requestApproval,
    maxSteps, abortSignal, orchestrate = "full", planApproval = true,
    confirmPlan, templateId, thinkingLevel, roleThinking, executorTools, startPhase, resumePlanText,
    hooks, skillsPrompt, agentsPrompt,
  } = opts;

  let planText = resumePlanText ?? "";
  let reviewText = "";
  // 批准计划时用户附带的指示（v2.3：如"不要动 xxx 文件"）——注入执行阶段 prompt
  let userInstruction = "";

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

  // ① Planner：只读规划（orchestrate ≠ off；v2.2 按角色路由模型；
  //    v2.3 阶段级续跑 startPhase=executor 时跳过——计划沿用上次确认的 resumePlanText）
  if (orchestrate !== "off" && startPhase !== "executor") {
    const rc = roleCfg("planner");
    const plan = await runAgent({
      modelConfig: rc.modelConfig,
      fallbackModelConfigs: rc.fallbackModelConfigs,
      thinkingLevel: roleThink("planner"),
      initialMessages,
      system: PLANNER_SYSTEM_PROMPT,
      prompt: `${prompt}\n\n请先分析项目并制定执行计划，不要修改任何文件。`,
      tools: getReadOnlyTools(),
      root,
      emit,
      requestApproval,
      maxSteps: 12,
      abortSignal,
      phase: { id: "planner", label: "规划", model: rc.modelConfig.model },
      suppressFinal: true,
    });
    if (aborted()) {
      return { text: ABORTED_MSG, report: "", steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText: "", reviewText: "" };
    }
    planText = plan.text.trim();

    // ② 计划确认（v2.3 三态：用户自由文本回复 → 模型判断 execute/revise/abort）
    //    execute → 执行（回复中的指示注入执行阶段）；revise → 按意见重新规划再确认；abort → 中止任务
    if (planApproval && planText && planText !== ABORTED_MSG) {
      let reviseRounds = 0;
      for (;;) {
        const decision = await confirm(planText);
        if (aborted()) {
          return { text: ABORTED_MSG, report: "", steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
        }
        if (decision === null) {
          // 用户取消
          const msg = "执行计划未获确认，任务已取消";
          emit({ type: "error", message: msg });
          return { text: msg, report: "", steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
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

        if (judged.action === "abort") {
          // 用户要求暂缓/停止：任务中止（不执行、不审查），进度与计划保留可继续
          const msg = "你要求暂缓执行，任务已停止（计划已保存，可稍后继续会话）";
          emit({ type: "error", message: msg });
          return { text: msg, report: "", steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
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
            system: PLANNER_SYSTEM_PROMPT,
            prompt: `${prompt}\n\n【原计划】（用户要求修改）\n${planText}\n\n【用户修改意见】\n${judged.instruction ?? "请调整计划"}\n\n请按修改意见重新制定执行计划，不要修改任何文件。`,
            tools: getReadOnlyTools(),
            root,
            emit,
            requestApproval,
            maxSteps: 12,
            abortSignal,
            phase: { id: "planner", label: "规划（修订）", model: rc.modelConfig.model },
            suppressFinal: true,
          });
          if (aborted()) {
            return { text: ABORTED_MSG, report: "", steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
          }
          if (revised.text.trim()) planText = revised.text.trim();
          continue; // 再次确认修订后的计划
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
    ? `${prompt}\n\n【执行计划】（Planner 生成，请按其执行）\n${planText}${userInstruction ? `\n\n【用户附加指示】（必须遵守）\n${userInstruction}` : ""}`
    : prompt;
  const exec = await runAgent({
    modelConfig: rcExec.modelConfig,
    fallbackModelConfigs: rcExec.fallbackModelConfigs,
    thinkingLevel: roleThink("executor"),
    initialMessages,
    system: EXECUTOR_SYSTEM_PROMPT + (skillsPrompt ?? "") + (agentsPrompt ?? ""),
    prompt: execPrompt,
    tools: executorTools ? withMcpTools(TOOLS, executorTools) : TOOLS,
    hooks,
    root,
    emit,
    requestApproval,
    maxSteps: execMaxSteps,
    abortSignal,
    phase: { id: "executor", label: "执行", model: rcExec.modelConfig.model },
    suppressFinal: true,
  });
  if (aborted()) {
    return { text: ABORTED_MSG, report: "", steps: exec.steps, toolCount: exec.toolCount, approvals: exec.approvals, toolLogs: exec.toolLogs, planText, reviewText: "" };
  }

  // ④ Reviewer：只读审查（orchestrate = full 且执行未中止；v2.2 按角色路由模型）
  if (orchestrate === "full" && exec.text && exec.text !== ABORTED_MSG) {
    const rc = roleCfg("reviewer");
    const review = await runAgent({
      modelConfig: rc.modelConfig,
      fallbackModelConfigs: rc.fallbackModelConfigs,
      thinkingLevel: roleThink("reviewer"),
      initialMessages,
      system: REVIEWER_SYSTEM_PROMPT,
      prompt: `请审查以下开发任务的执行结果：\n\n【任务】${prompt}\n\n【执行摘要】\n${exec.text.slice(0, 4000)}\n\n请用 git_diff / read_file / run_test 等工具核实改动与测试结果，然后输出审查意见。不要修改任何文件。`,
      tools: getReviewerTools(),
      root,
      emit,
      requestApproval,
      maxSteps: 10,
      abortSignal,
      phase: { id: "reviewer", label: "审查", model: rc.modelConfig.model },
      suppressFinal: true,
    });
    reviewText = review.text.trim();
    if (reviewText && reviewText !== ABORTED_MSG) emit({ type: "review", content: reviewText });
  }

  // ⑤ 汇总交付报告（执行报告 + 审查小节）
  let report = buildReport({ prompt, toolLogs: exec.toolLogs, approvals: exec.approvals, steps: exec.steps });
  if (reviewText) {
    report += `\n\n## 🔍 审查意见\n\n${reviewText}`;
  }
  emit({ type: "report", content: report });
  emit({ type: "done", text: exec.text, toolCount: exec.toolCount, steps: exec.steps });

  return { text: exec.text, report, steps: exec.steps, toolCount: exec.toolCount, approvals: exec.approvals, toolLogs: exec.toolLogs, planText, reviewText };
}
