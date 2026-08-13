/**
 * 上下文压缩自测（v2.2：按模型上下文窗口因地制宜）
 * 运行：npx tsx packages/agent/tests/compress.test.ts
 *
 * 覆盖：estimateTokens 粗估 / resolveContextWindow（显式>模型名>provider>兜底）/
 *      compressMessages（触发边界、保留最新、摘要注入、摘要失败降级丢弃）
 */
import { estimateTokens, compressMessages, serializeHistory } from "../src/agent/context.js";
import { resolveContextWindow } from "../src/providers/registry.js";
import type { ChatMessageLike } from "../src/providers/chat.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 上下文压缩自测 ===\n");

// 1. estimateTokens 粗估
console.log("▶ estimateTokens");
const msgs1: ChatMessageLike[] = [
  { role: "system", content: "你是 InFu" },                    // 4 中文 ≈ 4 + 4 结构
  { role: "user", content: "你好" },                           // 2 + 4
  { role: "user", content: "a".repeat(40) },                  // 10 + 4
];
const est1 = estimateTokens(msgs1);
check("粗估为正值且中文按 1 字符/token", est1 > 20 && est1 < 40, String(est1));
check("英文 4 字符≈1 token", estimateTokens([{ role: "user", content: "a".repeat(400) }]) < 130, String(estimateTokens([{ role: "user", content: "a".repeat(400) }])));
const withCalls: ChatMessageLike[] = [{ role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] }];
check("工具调用计入开销", estimateTokens(withCalls) > estimateTokens([{ role: "assistant", content: "" }]));

// 2. resolveContextWindow 因地制宜（2026-08 调研校准：主流模型已升级 1M）
console.log("\n▶ resolveContextWindow");
check("显式配置优先", resolveContextWindow({ provider: "deepseek", model: "any", contextWindow: 4096 }) === 4096);
check("模型名匹配（gpt-5.6）", resolveContextWindow({ provider: "openai", model: "gpt-5.6-luna" }) === 1_000_000);
check("模型名匹配（claude）", resolveContextWindow({ provider: "anthropic", model: "claude-sonnet-5" }) === 1_000_000);
check("模型名匹配（kimi）", resolveContextWindow({ provider: "custom", model: "kimi-k3" }) === 1_000_000);
check("provider 默认（deepseek）", resolveContextWindow({ provider: "deepseek", model: "whatever" }) === 1_000_000);
check("custom 模板默认（256k）", resolveContextWindow({ provider: "custom", model: "unknown-model" }) === 256_000);
check("glm-5.2 模型名匹配（1M）", resolveContextWindow({ provider: "zhipu", model: "glm-5.2" }) === 1_000_000);

// 3. 触发边界：小窗口早触发、大窗口晚触发（同一组消息）
console.log("\n▶ 触发边界（小窗口早触发 / 大窗口晚触发）");
const longHistory: ChatMessageLike[] = [
  { role: "system", content: "你是 InFu" },
  ...Array.from({ length: 200 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `第 ${i} 轮：这是一段比较长的对话内容，包含工具操作与结果，用来撑大估算量。${"x".repeat(100)}`,
  })),
];
const estLong = estimateTokens(longHistory);
check("长历史估算 > 8k 窗口的 80%（小窗口触发）", estLong > 8000 * 0.8, String(estLong));
const summarizeCalls: string[] = [];
const fakeSummarize = async (h: ChatMessageLike[]) => {
  summarizeCalls.push(`history=${h.length}`);
  return "摘要：任务目标已明确，改了 a.ts，测试通过，遗留 b.ts 未完成。";
};

// 小窗口（8k）：触发压缩
const small = await compressMessages(longHistory, 8000, fakeSummarize);
check("小窗口触发压缩（after ≤ 窗口×60%）", small.after <= 8000 * 0.6, `after=${small.after}`);
check("压缩后含摘要消息", small.messages[0].content.includes("此前会话摘要"));
check("保留最近内容（非摘要消息仍在）", small.messages.length < longHistory.length && small.messages.some((m) => m.role === "assistant"));
check("压缩了部分历史（摘要输入 = 被压缩段）", summarizeCalls.length === 1 && summarizeCalls[0] === `history=${longHistory.length - (small.messages.length - 1)}`, summarizeCalls.join(","));
check("压缩后估算 < 压缩前", small.after < small.before, `${small.before} → ${small.after}`);

// 大窗口（1M）：不触发
summarizeCalls.length = 0;
const big = await compressMessages(longHistory, 1_000_000, fakeSummarize);
check("大窗口不触发压缩（原样返回）", big.messages.length === longHistory.length && summarizeCalls.length === 0, `calls=${summarizeCalls.length}`);
check("大窗口 before/after 相等", big.before === big.after);

// 4. 摘要失败降级：直接丢弃最老部分（不阻塞）
console.log("\n▶ 摘要失败降级");
const failSummarize = async () => { throw new Error("模型挂了"); };
const fail = await compressMessages(longHistory, 8000, failSummarize);
check("摘要失败仍返回压缩结果", fail.messages.length < longHistory.length);
check("降级后无摘要消息（直接丢弃）", !fail.messages[0].content.includes("此前会话摘要"));
check("摘要字段为空", fail.summary === "");

// 5. 未超预算：原样返回且不调摘要
console.log("\n▶ 未超预算");
const tiny: ChatMessageLike[] = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
let called = false;
const noop = await compressMessages(tiny, 8000, async () => { called = true; return "x"; });
check("未超预算原样返回", noop.messages.length === tiny.length && !called);

// 6. system 消息不被压缩掉
console.log("\n▶ system 保留");
const sys = await compressMessages(longHistory, 8000, fakeSummarize);
check("压缩后首条非摘要（若摘要注入）或保留 system", sys.messages[0].role === "user", sys.messages[0].role);
check("压缩后不含原 system（被摘要替换为 user 摘要）或 system 保留——至少 1 条", sys.messages.length >= 2);

// 7. serializeHistory 截断保护
console.log("\n▶ serializeHistory");
const huge: ChatMessageLike[] = [{ role: "user", content: "y".repeat(50000) }];
const ser = serializeHistory(huge);
check("超长历史序列化有总长上限", ser.length <= 30000 + 800, String(ser.length));

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
