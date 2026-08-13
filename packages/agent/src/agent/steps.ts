/**
 * InFu 动态步数（v2.2）— 任务复杂度评估
 *
 * 优先级：显式 --max-steps > Planner 建议步数（计划文本 【建议步数】N）> 启发式评估 > 默认 30。
 * 纯函数，便于单测。
 */

/** 默认最大步数（无任何建议时） */
export const DEFAULT_MAX_STEPS = 30;

/**
 * 启发式复杂度评估（纯函数，无模型调用）：
 * 按任务文本长度 + 任务类型特征给出建议步数。
 * @param prompt 任务描述
 * @param templateId 模板任务 id（init-project/fix-tests/analyze/add-feature），可空
 */
export function estimateComplexity(prompt: string, templateId?: string): number {
  // 模板任务有既定体量
  if (templateId) {
    switch (templateId) {
      case "init-project": return 25;   // 初始化项目：脚手架 + README + 验证
      case "fix-tests": return 20;      // 修测试：定位 + 修复 + 回归
      case "add-feature": return 22;    // 加功能：分析 + 实现 + 验证
      case "analyze": return 12;        // 分析：只读调研
    }
  }
  const p = prompt ?? "";
  if (!p.trim()) return DEFAULT_MAX_STEPS; // 无任务描述：回退默认
  let steps = 15; // 基准
  // 长任务描述 → 复杂
  if (p.length > 200) steps += 5;
  if (p.length > 500) steps += 5;
  // 任务类型特征
  const kw = (re: RegExp) => re.test(p);
  if (kw(/测试|test|用例|回归/i)) steps += 5;          // 涉及测试验证
  if (kw(/重构|重构|迁移|升级/i)) steps += 4;          // 重构/迁移
  if (kw(/数据库|schema|迁移文件/i)) steps += 4;        // 数据层
  if (kw(/多个|批量|全部|所有文件/i)) steps += 3;       // 批量改动
  if (kw(/分析|调研|总结|报告|理解/i)) steps -= 3;      // 只读调研
  if (kw(/修复|bug|错误|失败/i)) steps += 2;            // 排障可能多轮
  return Math.max(5, Math.min(40, steps));
}

/**
 * 从计划文本解析 Planner 建议步数（【建议步数】N / 建议步数 N）。
 * 无匹配返回 null（回退启发式）。
 */
export function parseSuggestedSteps(planText: string): number | null {
  const m = /【?\s*建议步数\s*】?\s*[:：]?\s*(\d{1,3})/.exec(planText ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) return null;
  return n;
}

/** 综合解析 Executor 步数（显式 > Planner 建议 > 启发式 > 默认） */
export function resolveMaxSteps(opts: {
  explicit?: number;
  planText?: string;
  prompt?: string;
  templateId?: string;
}): number {
  if (opts.explicit && opts.explicit > 0) return opts.explicit;
  const suggested = opts.planText ? parseSuggestedSteps(opts.planText) : null;
  if (suggested != null) return suggested;
  return estimateComplexity(opts.prompt ?? "", opts.templateId);
}
