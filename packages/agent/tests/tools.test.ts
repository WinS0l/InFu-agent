/**
 * 工具系统自测（不依赖任何模型）
 * 运行：npx tsx packages/agent/tests/tools.test.ts
 */
import { TOOLS } from "../src/tools/index.js";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, AgentEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// ── 测试项目夹具 ──
const proj = mkdtempSync(join(tmpdir(), "infu-test-"));
mkdirSync(join(proj, "src"), { recursive: true });
writeFileSync(join(proj, "package.json"), JSON.stringify({
  name: "fixture", version: "1.0.0",
  dependencies: { react: "^19.0.0", express: "^5.0.0" },
  scripts: { test: "echo hello-test" },
}, null, 2));
writeFileSync(join(proj, "src", "app.ts"), "export const greet = (name: string) => `Hello ${name}`;\n// TODO: fix me\n");
writeFileSync(join(proj, "README.md"), "# Fixture\n测试项目\n");

const events: AgentEvent[] = [];
const ctx: ToolContext = {
  root: proj,
  cwd: proj,
  requestApproval: async () => true,
  emit: (e) => events.push(e),
};

const run = (name: string, args: Record<string, unknown>) => TOOLS[name].execute(args, ctx);
const T = TOOLS;

console.log("\n=== 工具系统自测 ===\n");

// 1. project_scan
console.log("▶ project_scan");
const scan = await run("project_scan", {});
check("识别 Node.js 技术栈", scan.includes("Node.js"), scan);
check("识别 React 框架", scan.includes("React"), scan);

// 2. list_directory
console.log("\n▶ list_directory");
const list = await run("list_directory", {});
check("列出 src 目录", list.includes("[dir]  src/"), list);
check("列出 package.json", list.includes("package.json"), list);

// 3. read_file
console.log("\n▶ read_file");
const rd = await run("read_file", { path: "src/app.ts" });
check("读取内容", rd.includes("greet"), rd);
check("带行号", rd.includes("1\t"), rd);

// 4. search_code
console.log("\n▶ search_code");
const sr = await run("search_code", { pattern: "TODO" });
check("搜索命中", /src[\\/]app\.ts:2/.test(sr), sr);

// 5. write_file + 越界防护
console.log("\n▶ write_file");
const wr = await run("write_file", { path: "src/new.txt", content: "hello" });
check("写入成功", wr.includes("已写入"), wr);
check("文件存在", existsSync(join(proj, "src", "new.txt")));
const escape = await run("write_file", { path: "../../evil.txt", content: "x" });
check("路径越界被拦截", escape.includes("越界"), escape);

// 6. edit_file
console.log("\n▶ edit_file");
const ed = await run("edit_file", { path: "src/app.ts", old_text: "Hello ${name}", new_text: "Hi ${name}" });
check("编辑成功", ed.includes("已修改"), ed);
const ed2 = await run("edit_file", { path: "src/app.ts", old_text: "不存在的内容", new_text: "x" });
check("原文不匹配报错", ed2.includes("未找到"), ed2);

// 7. run_command
console.log("\n▶ run_command");
const cmd = await run("run_command", { command: "echo infu-ok" });
check("命令执行", cmd.includes("infu-ok"), cmd);

// 8. git_status / git_diff
console.log("\n▶ git_status / git_diff");
const gs = await run("git_status", {});
check("非 git 仓库友好提示", gs.includes("不是 Git 仓库") || gs.includes("fatal"), gs);

// 9. run_test
console.log("\n▶ run_test");
const rt = await run("run_test", {});
check("自动检测 npm test", rt.includes("hello-test"), rt);

// 10. 越界防护（read）
console.log("\n▶ 越界防护");
const re = await run("read_file", { path: "../../../windows/system32/notepad.exe" });
check("read 越界拦截", re.includes("越界"), re);

// 清理
rmSync(proj, { recursive: true, force: true });

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
