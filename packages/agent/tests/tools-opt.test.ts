// v2.10 工具与上下文优化自测：glob 工具 / 压缩剪枝 / 摘要前缀
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS, getReadOnlyTools } from "../src/tools/index.js";
import { pruneToolResults, pruneHistoricalToolResults, compressMessages } from "../src/agent/context.js";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

// ── 1. glob 工具 ──
console.log("\n▶ glob 工具");
{
  const root = mkdtempSync(join(tmpdir(), "infu-glob-"));
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");
  writeFileSync(join(root, "src", "components", "b.tsx"), "export const b = 2;\n");
  writeFileSync(join(root, "src", "c.md"), "# c\n");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x\n");
  const ctx: any = { root, emit: () => {}, requestApproval: async () => true, cwd: root };

  const all = await TOOLS.glob.execute({ pattern: "**/*.{ts,tsx}" }, ctx);
  check("glob **/*.{ts,tsx} 命中 2 个", all.includes("src/a.ts") && all.includes("src/components/b.tsx") && !all.includes("node_modules"), all);
  const nested = await TOOLS.glob.execute({ pattern: "src/components/*" }, ctx);
  check("glob 单层模式命中 tsx", nested.includes("b.tsx"));
  const md = await TOOLS.glob.execute({ pattern: "**/*.md" }, ctx);
  check("glob 命中 md", md.includes("c.md"));
  const escape = await TOOLS.glob.execute({ pattern: "../etc/*" }, ctx);
  check("glob 越界模式拒绝", escape.includes("错误"));
  const noMatch = await TOOLS.glob.execute({ pattern: "**/*.rs" }, ctx);
  check("glob 无匹配提示 0", noMatch.includes("0 个文件"));
  check("glob 进只读白名单", "glob" in getReadOnlyTools());
  rmSync(root, { recursive: true, force: true });
}

// ── 2. 压缩剪枝（pruneToolResults）──
console.log("\n▶ 压缩剪枝");
{
  const big = "x".repeat(20000);
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_command", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: big },
    { role: "assistant", content: "done" },
  ];
  const pruned = pruneToolResults(msgs);
  const toolText = pruned[3].content as string;
  check("超长工具结果被剪", toolText.length < big.length && toolText.length > 5000);
  check("剪枝保留头尾", toolText.startsWith("x".repeat(4096)) && toolText.endsWith("x".repeat(1024)));
  check("剪枝含标记", toolText.includes("中间部分已剪"));
  const small = [{ role: "tool", tool_call_id: "c1", content: "tiny" }];
  check("短结果不剪", pruneToolResults(small)[0].content === "tiny");
}

// ── 2.5 长任务历史工具输出裁剪（不等到 1M 窗口才省 token）──
console.log("\n▶ 长任务历史工具输出裁剪");
{
  const messages = [
    { role: "system" as const, content: "sys" },
    ...Array.from({ length: 8 }, (_, i) => ({ role: "tool" as const, tool_call_id: `c${i}`, content: `${i}:` + "z".repeat(4000) })),
  ];
  const pruned = pruneHistoricalToolResults(messages, 2);
  check("较早大型工具结果被裁剪", typeof pruned[1].content === "string" && (pruned[1].content as string).includes("较早工具结果已压缩"));
  check("最近工具结果保持完整", pruned[7].content === messages[7].content && pruned[8].content === messages[8].content);
  check("历史裁剪保留头尾证据", typeof pruned[1].content === "string" && (pruned[1].content as string).startsWith((messages[1].content as string).slice(0, 1600)) && (pruned[1].content as string).endsWith("z".repeat(600)));
}

// ── 3. compressMessages 剪枝后不超预算则不压缩 ──
console.log("\n▶ 压缩剪枝联动");
{
  const big = "y".repeat(30000);
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "任务：实现功能" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_command", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: big },
    { role: "assistant", content: "完成" },
  ];
  let summarized = 0;
  const r = await compressMessages(msgs, 10000, async () => { summarized++; return "摘要"; });
  check("剪枝后不触发摘要（预算内）", summarized === 0, `summarized=${summarized}`);
  check("剪枝后消息保留", r.messages.length === 5);
}

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
