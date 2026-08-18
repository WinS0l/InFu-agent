/**
 * v3.1 工具补齐自测：project_tree / file_ops / os_info / current_time
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOLS } from "../src/tools/index.js";
import { READONLY_TOOLS } from "../src/agent/agents.js";
import { isMutatingTool } from "../src/agent/loop.js";
import { setDataDirForTest } from "../src/data-dir.js";
import type { ToolContext } from "@infu/shared";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "infu-fstools-"));
const root = path.join(tmp, "proj");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
fs.writeFileSync(path.join(root, "README.md"), "hi");
fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;");
fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "deep", "b.ts"), "export const b = 2;");

const ctx: ToolContext = {
  root, cwd: root, emit: () => {},
  requestApproval: async () => true,
  scopeRules: undefined,
} as unknown as ToolContext;

console.log("=== v3.1 fs/env 工具自测 ===");

// ── 注册与归类 ──
ok("project_tree 已注册", !!TOOLS.project_tree);
ok("file_ops 已注册", !!TOOLS.file_ops);
ok("os_info 已注册", !!TOOLS.os_info);
ok("current_time 已注册", !!TOOLS.current_time);
ok("project_tree 进只读白名单", READONLY_TOOLS.includes("project_tree"));
ok("os_info 进只读白名单", READONLY_TOOLS.includes("os_info"));
ok("current_time 进只读白名单", READONLY_TOOLS.includes("current_time"));
ok("file_ops 计入写工具（串行）", isMutatingTool("file_ops"));
ok("project_tree 非写工具", !isMutatingTool("project_tree"));

// ── project_tree ──
{
  const out = await TOOLS.project_tree.execute({}, ctx);
  ok("树包含 src/", typeof out === "string" && out.includes("src/"));
  ok("树包含文件", typeof out === "string" && out.includes("a.ts"));
  ok("树跳过 node_modules", typeof out === "string" && !out.includes("node_modules"));
  const out2 = await TOOLS.project_tree.execute({ depth: 1 }, ctx);
  ok("深度 1 不再展开 src/ 内部", typeof out2 === "string" && !out2.includes("a.ts"));
  const out3 = await TOOLS.project_tree.execute({ path: "src" }, ctx);
  ok("指定子目录起点", typeof out3 === "string" && out3.includes("src") && out3.includes("deep"));
  const outBad = await TOOLS.project_tree.execute({ path: "../x" }, ctx);
  ok("越界拒绝", typeof outBad === "string" && outBad.includes("越界"));
}

// ── file_ops ──
{
  const r1 = await TOOLS.file_ops.execute({ op: "mkdir", path: "lib" }, ctx);
  ok("mkdir 成功", typeof r1 === "string" && r1.includes("已创建"));
  ok("lib 存在", fs.existsSync(path.join(root, "lib")));

  const r2 = await TOOLS.file_ops.execute({ op: "cp", path: "src/a.ts", dest: "lib/a-copy.ts" }, ctx);
  ok("cp 成功", typeof r2 === "string" && r2.includes("已复制"));
  ok("副本存在", fs.existsSync(path.join(root, "lib", "a-copy.ts")));

  const r3 = await TOOLS.file_ops.execute({ op: "mv", path: "lib/a-copy.ts", dest: "lib/a-moved.ts" }, ctx);
  ok("mv 成功", typeof r3 === "string" && r3.includes("移动"));
  ok("旧路径消失", !fs.existsSync(path.join(root, "lib", "a-copy.ts")));
  ok("新路径存在", fs.existsSync(path.join(root, "lib", "a-moved.ts")));

  const r4 = await TOOLS.file_ops.execute({ op: "rm", path: "lib/a-moved.ts" }, ctx);
  ok("rm 文件成功", typeof r4 === "string" && r4.includes("已删除"));
  ok("文件已删", !fs.existsSync(path.join(root, "lib", "a-moved.ts")));

  const r5 = await TOOLS.file_ops.execute({ op: "rm", path: "lib" }, ctx);
  ok("rm 目录无 recursive 拒绝", typeof r5 === "string" && r5.includes("recursive"));
  const r6 = await TOOLS.file_ops.execute({ op: "rm", path: "lib", recursive: true }, ctx);
  ok("rm 目录 recursive 成功", typeof r6 === "string" && r6.includes("已删除"));
  ok("目录已删", !fs.existsSync(path.join(root, "lib")));

  const r7 = await TOOLS.file_ops.execute({ op: "rm", path: "../../secrets" }, ctx);
  ok("越界拒绝", typeof r7 === "string" && r7.includes("越界"));
  const r8 = await TOOLS.file_ops.execute({ op: "mkdir", path: "../outside" }, ctx);
  ok("mkdir 越界拒绝", typeof r8 === "string" && r8.includes("越界"));
  const r9 = await TOOLS.file_ops.execute({ op: "mv", path: "README.md", dest: "../evil.md" }, ctx);
  ok("mv 目标越界拒绝", typeof r9 === "string" && r9.includes("越界"));
  const r10 = await TOOLS.file_ops.execute({ op: "cp", path: "README.md", dest: "node_modules/x.md" }, ctx);
  ok("任意项目内目标放行（node_modules 非保护）", typeof r10 === "string" && r10.includes("已复制"));
  fs.rmSync(path.join(root, "node_modules", "x.md"), { force: true });

  // v3.8 审计修复：写保护测试改隔离目录——原用 os.homedir() 作 root，写保护若回归失效，
  // 断言失败前会真实删除 ~/.infu/config.json（用户凭据）。isProtectedPath 是纯路径匹配
  // （.ssh 正则全局生效；.infu 保护跟随 resolveDataDir()），用数据目录重定向 + 临时目录
  // 验证同一套逻辑，安全等价。
  const tmpData = path.join(tmp, "infu-data");
  fs.mkdirSync(tmpData, { recursive: true });
  fs.writeFileSync(path.join(tmpData, "config.json"), "{}");
  setDataDirForTest(tmpData);
  const ctxHome: ToolContext = { ...ctx, root: tmpData } as unknown as ToolContext;
  const r11 = await TOOLS.file_ops.execute({ op: "mkdir", path: ".ssh" }, ctxHome);
  ok("~/.ssh 写保护拦截", typeof r11 === "string" && r11.includes("受保护"));
  const r12 = await TOOLS.file_ops.execute({ op: "rm", path: "config.json" }, ctxHome);
  ok("~/.infu 写保护拦截", typeof r12 === "string" && r12.includes("受保护"));
  ok("~/.infu/config.json 未被删除", fs.existsSync(path.join(tmpData, "config.json")));

  const r13 = await TOOLS.file_ops.execute({ op: "badop", path: "README.md" }, ctx);
  ok("未知 op 报错", typeof r13 === "string" && r13.includes("未知操作"));
}

// ── os_info / current_time ──
{
  const out = await TOOLS.os_info.execute({}, ctx);
  ok("os_info 含平台", typeof out === "string" && out.includes(os.platform()));
  ok("os_info 含 Node 版本", typeof out === "string" && out.includes(process.version));
  const t = await TOOLS.current_time.execute({}, ctx);
  const d = new Date(t as string);
  ok("current_time 合法 ISO", !Number.isNaN(d.getTime()) && (t as string).includes("T"));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);