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

import type { AgentEvent, OrchestrateMode, RiskLevel, ToolDef } from "@infu/shared";
import { runAgent, buildReport, DEFAULT_SYSTEM_PROMPT, type RunResult } from "./loop.js";
import { TOOLS, getReadOnlyTools, getReviewerTools } from "../tools/index.js";

/** Planner 角色提示词：只读分析 + 拆解步骤，绝不修改 */
export const PLANNER_SYSTEM_PROMPT = `你是 InFu 的规划员（Planner），负责为开发任务制定执行计划。
工作方式：
1. 先用只读工具了解项目（project_scan / list_directory / read_file / search_code / git_status / git_diff）。不要修改任何文件、不要运行有副作用的命令。
2. 把任务拆解为清晰的执行步骤，输出一份可执行的计划：
   - 任务理解（一句话）
   - 执行步骤（编号列表，每步说明要做什么、涉及哪些文件/命令）
   - 验证方式（如何确认任务完成，如运行测试）
3. 计划要具体、可执行，供 Executor 按步骤落地。
4. 只输出计划本身，不要执行任何修改操作。`;

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
  modelConfig: {
    provider: string;
    model: string;
    baseURL?: string;
    apiKey: string;
  };
  prompt: string;
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
   * 计划确认钩子（Web 挂计划卡片：可编辑后批准；默认 = 审批弹窗贴计划文本）。
   * editedPlan 为编辑后的计划，批准时以它替换原计划进入执行。
   */
  confirmPlan?: (planText: string) => Promise<{ approved: boolean; editedPlan?: string }>;
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
    modelConfig, prompt, root, emit, requestApproval,
    maxSteps, abortSignal, orchestrate = "full", planApproval = true,
    confirmPlan,
  } = opts;

  let planText = "";
  let reviewText = "";

  const aborted = () => abortSignal?.aborted === true;

  // 默认计划确认：复用审批机制（CLI 交互 / -y 自动批准）
  const confirm = confirmPlan ?? (async (text: string) => {
    const approved = await requestApproval(
      `确认执行以下计划吗？（批准后将开始修改代码）\n\n${text.slice(0, 3000)}`,
      "medium"
    );
    return { approved, editedPlan: undefined };
  });

  // ① Planner：只读规划（orchestrate ≠ off）
  if (orchestrate !== "off") {
    const plan = await runAgent({
      modelConfig,
      system: PLANNER_SYSTEM_PROMPT,
      prompt: `${prompt}\n\n请先分析项目并制定执行计划，不要修改任何文件。`,
      tools: getReadOnlyTools(),
      root,
      emit,
      requestApproval,
      maxSteps: 12,
      abortSignal,
      phase: { id: "planner", label: "规划" },
      suppressFinal: true,
    });
    if (aborted()) {
      return { text: ABORTED_MSG, report: "", steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText: "", reviewText: "" };
    }
    planText = plan.text.trim();

    // ② 计划确认：用户批准后才进入执行（Web 计划卡片可编辑；CLI 走审批弹窗）
    if (planApproval && planText && planText !== ABORTED_MSG) {
      const decision = await confirm(planText);
      if (aborted()) {
        return { text: ABORTED_MSG, report: "", steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
      }
      if (!decision.approved) {
        const msg = "执行计划未获确认，任务已取消";
        emit({ type: "error", message: msg });
        return { text: msg, report: "", steps: 0, toolCount: 0, approvals: plan.approvals, toolLogs: plan.toolLogs, planText, reviewText: "" };
      }
      // 用户编辑后的计划替换原计划（Web 计划卡片场景）
      if (decision.editedPlan?.trim()) planText = decision.editedPlan.trim();
    }
  }

  // ③ Executor：全工具按计划执行
  const execPrompt = planText
    ? `${prompt}\n\n【执行计划】（Planner 生成，请按其执行）\n${planText}`
    : prompt;
  const exec = await runAgent({
    modelConfig,
    system: EXECUTOR_SYSTEM_PROMPT,
    prompt: execPrompt,
    tools: TOOLS,
    root,
    emit,
    requestApproval,
    maxSteps,
    abortSignal,
    phase: { id: "executor", label: "执行" },
    suppressFinal: true,
  });
  if (aborted()) {
    return { text: ABORTED_MSG, report: "", steps: exec.steps, toolCount: exec.toolCount, approvals: exec.approvals, toolLogs: exec.toolLogs, planText, reviewText: "" };
  }

  // ④ Reviewer：只读审查（orchestrate = full 且执行未中止）
  if (orchestrate === "full" && exec.text && exec.text !== ABORTED_MSG) {
    const review = await runAgent({
      modelConfig,
      system: REVIEWER_SYSTEM_PROMPT,
      prompt: `请审查以下开发任务的执行结果：\n\n【任务】${prompt}\n\n【执行摘要】\n${exec.text.slice(0, 4000)}\n\n请用 git_diff / read_file / run_test 等工具核实改动与测试结果，然后输出审查意见。不要修改任何文件。`,
      tools: getReviewerTools(),
      root,
      emit,
      requestApproval,
      maxSteps: 10,
      abortSignal,
      phase: { id: "reviewer", label: "审查" },
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
