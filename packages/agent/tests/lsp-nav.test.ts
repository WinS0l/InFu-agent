/**
 * LSP 跳转定义 / 查找引用 / 补全 自测（v6.0 P3：tsserver 语义级导航）
 * 运行：npx tsx packages/agent/tests/lsp-nav.test.ts
 *
 * 覆盖：
 *  - 跳转定义：跨文件 import 符号 → 定义位置（相对路径:行:列 + 上下文行）
 *  - 项目外定义（node_modules 上溯解析）→ 提示「项目外」不展示内容
 *  - 查找引用：声明 + 多处调用计数、去重、项目外计数
 *  - 补全候选：成员补全（类方法）、过滤内部符号
 *  - 边界：越界路径/不存在文件/非 TS 文件/非法行号 → 报错文案
 *  - 工具注册：lsp_definition/lsp_references/lsp_completion（low + 只读白名单）
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lspGotoDefinition, lspCompletions, lspFindReferences } from "../src/tools/lsp.js";
import { TOOLS, getReadOnlyTools } from "../src/tools/index.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const base = mkdtempSync(join(tmpdir(), "infu-lspnav-"));
const root = join(base, "proj");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(base, "node_modules", "fake-lib"), { recursive: true });

writeFileSync(join(root, "src", "client.ts"), `export class Client {
  name: string;
  constructor(name: string) { this.name = name; }
  fetch(): string { return "data"; }
}
export function createClient(name: string): Client {
  return new Client(name);
}
`);
const mainLines = [
  `import { createClient, Client } from "./client";`,
  `import { libFn } from "fake-lib";`,
  ``,
  `export function main(): void {`,
  `  const c = createClient("api");`,
  `  libFn(c.name);`,
  `  libFn("again");`,
  `  c.fetch();`,
  `}`,
  ``,
  `const helper = (s: string) => s.toUpperCase();`,
  `void helper;`,
];
writeFileSync(join(root, "src", "main.ts"), mainLines.join("\n"));
writeFileSync(join(base, "node_modules", "fake-lib", "index.d.ts"), `export declare function libFn(x: string): string;\n`);
writeFileSync(join(root, "README.md"), "# fixture\n");

function lineOf(text: string, needle: string, nth = 0): { line: number; offset: number } {
  const lines = text.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(needle);
    if (idx >= 0) {
      if (seen === nth) return { line: i + 1, offset: idx + 1 };
      seen++;
    }
  }
  return { line: 1, offset: 1 };
}

(async () => {
  console.log("══ LSP 跳转/引用/补全（v6.0 P3）══");
  const main = mainLines.join("\n");

  // ── 1. 跳转定义 ──
  console.log("\n▶ 跳转定义");
  const pos = lineOf(main, "createClient(");
  const def = await lspGotoDefinition(root, "src/main.ts", pos.line, pos.offset);
  check("跨文件符号 → 定义位置", def.ok && def.message.includes("src/client.ts:") && def.message.includes("function createClient"), def.message);
  const pos2 = lineOf(main, "libFn(");
  const def2 = await lspGotoDefinition(root, "src/main.ts", pos2.line, pos2.offset);
  check("项目外定义 → 提示不展示", def2.ok && def2.message.includes("项目外"), def2.message);
  const pos3 = lineOf(main, "c.fetch()");
  const def3 = await lspGotoDefinition(root, "src/main.ts", pos3.line, pos3.offset + 2);
  check("成员方法定义（含上下文行）", def3.ok && def3.message.includes("src/client.ts:") && def3.message.includes("fetch"), def3.message);
  const noDef = await lspGotoDefinition(root, "src/main.ts", 9, 8);
  check("空行/非标识符 → 未找到", noDef.ok && noDef.message.includes("未找到"), noDef.message);

  // ── 2. 查找引用 ──
  console.log("\n▶ 查找引用");
  const refPos = lineOf(main, "libFn(");
  const refs = await lspFindReferences(root, "src/main.ts", refPos.line, refPos.offset);
  check("引用计数（声明 + 2 调用 + import；项目外计数）", refs.ok && refs.message.includes("4 处引用") && refs.message.includes("项目内 3 处") && refs.message.includes("项目外 1 处") && refs.message.includes("main.ts:6") && refs.message.includes("main.ts:7"), refs.message);
  const refs2 = await lspFindReferences(root, "src/main.ts", 7, 10);
  check("字符串字面量内 → 未找到", refs2.ok && refs2.message.includes("未找到"), refs2.message);

  // ── 3. 补全候选 ──
  console.log("\n▶ 补全候选");
  const dotPos = lineOf(main, ".fetch()");
  const comp = await lspCompletions(root, "src/main.ts", dotPos.line, dotPos.offset + 1);
  check("成员补全（Client 的 name/fetch）", comp.ok && comp.message.includes("fetch") && comp.message.includes("name"), comp.message);
  const comp2 = await lspCompletions(root, "src/main.ts", 9, 1);
  check("模块作用域补全（有候选）", comp2.ok && comp2.message.includes("补全候选"), comp2.message);

  // ── 4. 边界 ──
  console.log("\n▶ 边界");
  const b1 = await lspGotoDefinition(root, "../secret.ts", 1, 1);
  check("越界路径拒绝", !b1.ok && b1.message.includes("越界"), b1.message);
  const b2 = await lspGotoDefinition(root, "src/nope.ts", 1, 1);
  check("不存在文件拒绝", !b2.ok && b2.message.includes("不存在"), b2.message);
  const b3 = await lspGotoDefinition(root, "src/main.ts", 0, 1);
  check("非法行号拒绝", !b3.ok && b3.message.includes("line"), b3.message);
  const b4 = await lspCompletions(root, "README.md", 1, 1);
  check("非 TS 文件拒绝", !b4.ok && b4.message.includes("仅支持"), b4.message);

  // ── 5. 工具注册 ──
  console.log("\n▶ 工具注册");
  check("lsp_definition 注册且 low", !!TOOLS.lsp_definition && TOOLS.lsp_definition.risk === "low");
  check("lsp_references 注册且 low", !!TOOLS.lsp_references && TOOLS.lsp_references.risk === "low");
  check("lsp_completion 注册且 low", !!TOOLS.lsp_completion && TOOLS.lsp_completion.risk === "low");
  const ro = getReadOnlyTools();
  check("三工具进只读白名单", !!ro.lsp_definition && !!ro.lsp_references && !!ro.lsp_completion);

  try { rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});