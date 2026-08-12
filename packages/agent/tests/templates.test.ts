/**
 * 模板任务单测（M4 小白引导，不依赖模型）
 * 运行：npx tsx packages/agent/tests/templates.test.ts
 */
import { TASK_TEMPLATES, findTemplate } from "../src/templates.js";
import { renderTemplate } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 模板任务自测 ===\n");

// 1. 模板清单
check("模板数量 >= 4", TASK_TEMPLATES.length >= 4, `实际 ${TASK_TEMPLATES.length}`);
check("模板 id 唯一", new Set(TASK_TEMPLATES.map((t) => t.id)).size === TASK_TEMPLATES.length);
const ids = TASK_TEMPLATES.map((t) => t.id);
for (const id of ["init-project", "fix-tests", "analyze", "add-feature"]) {
  check(`包含模板 ${id}`, ids.includes(id));
}

// 2. findTemplate
check("findTemplate 命中", findTemplate("fix-tests")?.id === "fix-tests");
check("findTemplate 未命中返回 undefined", findTemplate("nope") === undefined);

// 3. renderTemplate 占位符替换
const init = findTemplate("init-project")!;
const rendered = renderTemplate(init, { techStack: "Python" });
check("占位符被替换", rendered.includes("Python"), rendered);
check("占位符无残留", !rendered.includes("{techStack}"), rendered);

// 4. 字段缺失时用默认值
const renderedDefault = renderTemplate(init, {});
check("缺失字段用默认值", renderedDefault.includes("Node.js + TypeScript"), renderedDefault);

// 5. 无字段模板直接渲染
const fix = findTemplate("fix-tests")!;
check("无字段模板不报错", renderTemplate(fix, {}).length > 50);

// 6. 兜底替换：values 里未声明在 fields 的键
const analyze = findTemplate("analyze")!;
const r2 = renderTemplate(analyze, { extra: "X" });
check("未声明键兜底替换不破坏输出", r2.includes("技术栈"));

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===\n`);
if (failed > 0) process.exit(1);
