/**
 * v2.6 收尾任务协作工具自测（read_files / todo_write / ask_user）
 * 运行：npx tsx packages/agent/tests/task-tools.test.ts
 */
import { TOOLS } from "../src/tools/index.js";
import { getTodos } from "../src/tools/task-tools.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, AgentEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const proj = mkdtempSync(join(tmpdir(), "infu-task-"));
writeFileSync(join(proj, "one.ts"), "const a = 1;\nconst b = 2;\n");
writeFileSync(join(proj, "two.md"), "# Two\n");

const events: AgentEvent[] = [];
const ctx: ToolContext = {
  root: proj,
  cwd: proj,
  requestApproval: async () => true,
  emit: (e) => events.push(e),
  askUser: async (_q, _opts) => "用户自定义回答",
};
const run = (name: string, args: Record<string, unknown>) => TOOLS[name].execute(args, ctx);

console.log("\n=== v2.6 收尾任务协作工具自测 ===\n");

// 1. read_files
console.log("▶ read_files");
const rf = await run("read_files", { paths: ["one.ts", "two.md"] });
check("批量读取多个文件", rf.includes("const a = 1") && rf.includes("# Two"), rf);
check("带行号", /1\tconst a = 1/.test(rf), rf);
const rfMiss = await run("read_files", { paths: ["missing.txt"] });
check("缺失文件报错", rfMiss.includes("文件不存在"), rfMiss);
const rfEscape = await run("read_files", { paths: ["../../outside.txt"] });
check("越界拦截", rfEscape.includes("越界"), rfEscape);

// 2. todo_write
console.log("\n▶ todo_write");
const tw = await run("todo_write", {
  todos: [
    { text: "分析项目", status: "completed" },
    { text: "实现功能" },
    { text: "跑测试", status: "in_progress" },
  ],
});
check("建立清单含完成数", /1\/3 完成/.test(tw), tw);
check("状态标记正确", tw.includes("[x]") && tw.includes("[→]") && tw.includes("[ ]"), tw);
const stored = getTodos(proj);
check("内存态存储", stored.length === 3 && stored[0].status === "completed", JSON.stringify(stored));
const tw2 = await run("todo_write", { todos: [] });
check("清空清单", tw2.includes("任务清单为空"), tw2);
const twBad = await run("todo_write", { todos: "不是数组" });
check("todos 非数组防御", twBad.includes("必须是数组") && !/is not a function/.test(twBad), twBad);
const rfBad = await run("read_files", { paths: "src/a.ts" });
check("paths 非数组防御", rfBad.includes("必须是数组"), rfBad);

// 3. ask_user
console.log("\n▶ ask_user");
const au = await run("ask_user", { question: "选哪个方案？", options: ["A", "B"] });
check("返回用户回答", au.includes("用户回答：用户自定义回答"), au);
const auNull: ToolContext = { ...ctx, askUser: async () => null };
const au2 = await TOOLS.ask_user.execute({ question: "q" }, auNull);
check("未回答提示", au2.includes("用户未回答"), au2);
const auNoChannel: ToolContext = { ...ctx, askUser: undefined };
const au3 = await TOOLS.ask_user.execute({ question: "q" }, auNoChannel);
check("通道未接线提示", au3.includes("通道未接线"), au3);

// 清理
rmSync(proj, { recursive: true, force: true });

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
