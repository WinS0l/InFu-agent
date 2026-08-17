/**
 * InFu 计划反馈意图判断（v2.3）— 用户对执行计划的自由文本回复 → 结构化三态
 *
 * 生态共识（主流 ExitPlanMode approve/request-changes/reject、InFu 拒绝=中止）：
 * 用户反馈是「执行 / 修订 / 中止」的结构化意图，不是字符串。用户说"先停下来先不做"
 * 必须中止任务（不再进入执行与审查），而不是把文本当指令注入执行。
 *
 * 三态：
 *  - execute：按计划执行（feedback 中的附加指示注入执行阶段）
 *  - revise ：按修改意见让 Planner 重新规划（编排层循环，再确认一次）
 *  - abort  ：中止任务（会话 stopped，不执行不审查）
 *
 * 判断失败/超时降级为 execute（任务还能跑，不因裁判故障卡死）。
 */

import { streamChatWithFailover, ModelChain, type ModelCandidate } from "../providers/gateway.js";

export type PlanFeedbackAction = "execute" | "revise" | "abort";

export interface PlanFeedbackResult {
  action: PlanFeedbackAction;
  /** execute 时的附加指示 / revise 时的修改意见 */
  instruction?: string;
}

/** 判断提示词（要求输出单行 JSON） */
const JUDGE_PROMPT = `你是 InFu 的计划确认裁判。用户对一份执行计划给出了自由文本回复，请判断其真实意图：

- "execute"：用户同意执行（可附带附加指示，如"不要动 xxx 文件"）
- "revise"：用户要求修改计划（修改意见写入 instruction）
- "abort"：用户要求停止/不做/暂缓（如"先停下来""先不做""取消""再想想"）

只输出一行 JSON，不要其他内容：{"action":"execute|revise|abort","instruction":"..."}

【执行计划】
{plan}

【用户回复】
{feedback}`;

/**
 * 判断用户对计划的回复意图（调当前模型；失败降级 execute）。
 * @param candidates 当前编排使用的模型链（复用思考参数链路外的最小配置）
 */
export async function interpretPlanFeedback(opts: {
  candidates: ModelCandidate[];
  feedback: string;
  planText: string;
  signal?: AbortSignal;
}): Promise<PlanFeedbackResult> {
  const { candidates, feedback, planText, signal } = opts;
  const fallback: PlanFeedbackResult = { action: "execute" };
  const fb = (feedback ?? "").trim();
  if (!fb) return fallback; // 空回复 = 批准

  try {
    const chain = new ModelChain(candidates);
    const out: string[] = [];
    for await (const delta of streamChatWithFailover({
      chain,
      messages: [
        { role: "system", content: "你是一个严谨的意图裁判，只输出 JSON。" },
        {
          role: "user",
          content: JUDGE_PROMPT
            .replace("{plan}", (planText ?? "").slice(0, 3000))
            .replace("{feedback}", fb.slice(0, 2000)),
        },
      ],
      signal,
      retry: { maxAttempts: 2, baseDelayMs: 500 },
    })) {
      if (delta.text) out.push(delta.text);
    }
    const raw = out.join("").trim();
    // 提取 JSON（模型可能带 ```json 围栏或前后废话）
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    const action = parsed?.action;
    if (action === "execute" || action === "revise" || action === "abort") {
      const instruction = typeof parsed.instruction === "string" && parsed.instruction.trim()
        ? parsed.instruction.trim()
        : undefined;
      return { action, instruction };
    }
    return fallback;
  } catch {
    return fallback; // 判断失败：保守执行
  }
}
