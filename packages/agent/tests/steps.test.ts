/**
 * 动态步数自测（v2.2：任务复杂度评估 + Planner 建议步数解析）
 * 运行：npx tsx packages/agent/tests/steps.test.ts
 */
import { estimateComplexity, parseSuggestedSteps, resolveMaxSteps } from "../src/agent/steps.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 动态步数自测 ===\n");

// 1. 启发式评估
console.log("▶ estimateComplexity");
const simple = estimateComplexity("分析这个项目的结构");
check("分析类任务步数偏小", simple >= 5 && simple <= 20, String(simple));
const complex = estimateComplexity("重构整个项目的数据层，把数据库 schema 迁移到新版本，并修复所有受影响的测试用例，涉及多个文件的批量改动");
check("复杂任务步数更大", complex > simple, `${simple} → ${complex}`);
check("长描述加分", estimateComplexity("x".repeat(600)) > estimateComplexity("x"));
check("测试类加分", estimateComplexity("修复测试失败") > estimateComplexity("你好"));

console.log("▶ 模板任务");
check("init-project=25", estimateComplexity("", "init-project") === 25);
check("fix-tests=20", estimateComplexity("", "fix-tests") === 20);
check("analyze=12", estimateComplexity("", "analyze") === 12);
check("add-feature=22", estimateComplexity("", "add-feature") === 22);

// 2. 建议步数解析
console.log("\n▶ parseSuggestedSteps");
check("【建议步数】N 解析", parseSuggestedSteps("计划内容\n【建议步数】25") === 25);
check("建议步数 N 解析", parseSuggestedSteps("计划\n建议步数：18") === 18);
check("无建议返回 null", parseSuggestedSteps("没有建议步数的计划") === null);
check("越界忽略（>100）", parseSuggestedSteps("【建议步数】500") === null);
check("空文本返回 null", parseSuggestedSteps("") === null);

// 3. 综合优先级：显式 > Planner 建议 > 启发式 > 默认
console.log("\n▶ resolveMaxSteps 优先级");
check("显式优先", resolveMaxSteps({ explicit: 5, planText: "【建议步数】40" }) === 5);
check("Planner 建议 > 启发式", resolveMaxSteps({ planText: "【建议步数】40", prompt: "简单任务" }) === 40);
check("启发式兜底", resolveMaxSteps({ prompt: "分析这个项目的结构" }) === estimateComplexity("分析这个项目的结构"));
check("无输入回退默认", resolveMaxSteps({}) === 30);

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
