/**
 * 阶段级精确续跑（v2.2 遗留，v2.3 落地）— 继续会话时跳过已完成阶段
 *
 * 规则（从事件流推断上次编排进行到的位置）：
 *  - 尾部 phase 为 planner/executor，且历史中有确认过的计划（plan 事件）
 *    → 从 Executor 续跑（不重新规划；计划文本 = 最后一次确认的计划）
 *  - 其余情况（无阶段 / 计划未产出 / reviewer 尾部）→ 从头开始（重新规划）
 *    （reviewer 只读阶段中断重跑成本低，v1 不做 reviewer 起点）
 * 直接模式（无 phase-start 事件）不受影响。
 */

import type { AgentEvent } from "@infu/shared";

export interface ResumePoint {
  /** 续跑起点阶段（当前支持 executor：跳过重新规划） */
  startPhase?: "executor";
  /** 上次确认的计划文本（跳过规划时注入执行阶段） */
  planText?: string;
}

export function inferResumePhase(events: Array<{ event: AgentEvent }>): ResumePoint {
  const phases = events
    .map((e) => e.event)
    .filter((e): e is Extract<AgentEvent, { type: "phase-start" }> => e.type === "phase-start")
    .map((e) => e.phase);
  if (!phases.length) return {};
  const last = phases[phases.length - 1];
  if (last === "reviewer") return {}; // reviewer 只读中断：重新编排（成本低）
  // planner/executor 尾部：有确认过的计划 → 直接续 Executor；否则从头规划
  const planEvents = events
    .map((e) => e.event)
    .filter((e): e is Extract<AgentEvent, { type: "plan" }> => e.type === "plan");
  if (!planEvents.length) return {};
  return { startPhase: "executor", planText: planEvents[planEvents.length - 1].content };
}
