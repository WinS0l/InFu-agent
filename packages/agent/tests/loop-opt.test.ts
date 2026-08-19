/**
 * v2.6 收尾工具调用优化自测（畸形 JSON 修复 / 结果裁剪 / 写工具分组）
 * 运行：npx tsx packages/agent/tests/loop-opt.test.ts
 */
import { repairToolArgs, trimToolResult, TRIM_TOOL_RESULT, isMutatingTool, isToolResultFailure, shouldBlockSameCallFailure } from "../src/agent/loop.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== v2.6 收尾工具调用优化自测 ===\n");

// 1. repairToolArgs
console.log("▶ 畸形 JSON 修复");
check("合法 JSON 原样解析", JSON.stringify(repairToolArgs('{"path":"a.ts"}')) === '{"path":"a.ts"}', JSON.stringify(repairToolArgs('{"path":"a.ts"}')));
check("空参数 → {}", JSON.stringify(repairToolArgs("")) === "{}", JSON.stringify(repairToolArgs("")));
check("去 markdown 围栏", repairToolArgs('```json\n{"path":"a"}\n```')?.path === "a", JSON.stringify(repairToolArgs('```json\n{"path":"a"}\n```')));
check("去外层括号", repairToolArgs('({"path":"a"})')?.path === "a", JSON.stringify(repairToolArgs('({"path":"a"})')));
check("修尾逗号", repairToolArgs('{"a":1,"b":2,}')?.b === 2, JSON.stringify(repairToolArgs('{"a":1,"b":2,}')));
check("单引号键值", repairToolArgs("{'path':'a.ts','limit':5}")?.path === "a.ts", JSON.stringify(repairToolArgs("{'path':'a.ts','limit':5}")));
check("垃圾输入 → null", repairToolArgs("not json at all {{{") === null, String(repairToolArgs("not json at all {{{")));
check("数组输入 → null（非对象）", repairToolArgs("[1,2,3]") === null, String(repairToolArgs("[1,2,3]")));

// 2. trimToolResult
console.log("\n▶ 工具结果裁剪");
const long = "x".repeat(20000);
const trimmed = trimToolResult(long);
check("超长截断", trimmed.length < 20000 && trimmed.includes("已截断"), `len=${trimmed.length}`);
const short = "hello";
check("短结果原样", trimToolResult(short) === short);
check("上限常量合理", TRIM_TOOL_RESULT > 0 && TRIM_TOOL_RESULT <= 12000);

// 3. isMutatingTool 分组
console.log("\n▶ 写工具串行分组");
check("写工具命中", isMutatingTool("write_file") && isMutatingTool("edit_file") && isMutatingTool("run_command") && isMutatingTool("git_commit") && isMutatingTool("git_add") && isMutatingTool("memory_write"));
check("ask_user 串行", isMutatingTool("ask_user"));
check("只读工具并行", !isMutatingTool("read_file") && !isMutatingTool("search_code") && !isMutatingTool("git_status") && !isMutatingTool("git_log") && !isMutatingTool("git_diff") && !isMutatingTool("webfetch") && !isMutatingTool("delegate_task"));

// 4. Same-call operational failure guard
console.log("\n▶ 同参失败恢复守卫");
check("工具错误文本视为失败", isToolResultFailure(true, "错误：文件不存在 x.ts"));
check("成功结果不计失败", !isToolResultFailure(true, "已写入 x.ts"));
check("用户拒绝不计入失败（保留下次审批）", !isToolResultFailure(true, "用户拒绝：未写入"));
check("两次失败前允许调整", !shouldBlockSameCallFailure(1));
check("两次同参失败后阻止第三次执行", shouldBlockSameCallFailure(2));

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
