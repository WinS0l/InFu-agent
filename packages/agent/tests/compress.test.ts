/**
 * 上下文压缩自测（v2.2：按模型上下文窗口因地制宜）
 * 运行：npx tsx packages/agent/tests/compress.test.ts
 *
 * 覆盖：estimateTokens 粗估 / resolveContextWindow（显式>模型名>provider>兜底）/
 *      compressMessages（触发边界、保留最新、摘要注入、摘要失败降级丢弃）
 */
import { estimateTokens, compressMessages, serializeHistory, balanceToolPairs } from "../src/agent/context.js";
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
// v3.4 审计修复（H2）：system 永不参与压缩——首条必为原 system
check("压缩后首条保留 system", small.messages[0].role === "system" && small.messages[0].content === "你是 InFu", JSON.stringify(small.messages[0]));
check("压缩后含摘要消息（紧随 system）", small.messages[1]?.content.includes("此前会话摘要") === true, JSON.stringify(small.messages[1]?.content));
check("保留最近内容（非摘要消息仍在）", small.messages.length < longHistory.length && small.messages.some((m) => m.role === "assistant"));
// 摘要输入 = 被压缩段（不含 system：200 条消息中 system 占 1 → 其余 199 条压缩到 kept）
check("压缩了部分历史（摘要输入 = 被压缩段）", summarizeCalls.length === 1 && summarizeCalls[0] === `history=${longHistory.length - 1 - (small.messages.length - 2)}`, summarizeCalls.join(","));
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
// v3.6 恒真断言修复：原 `!fail.messages[0].content.includes(...)` 只查首条（恒为 system，
// 摘要注入点在 messages[1]）——摘要若被错误注入此断言发现不了；改查全部消息
check("降级后无摘要消息（直接丢弃）", !fail.messages.some((m) => typeof m.content === "string" && m.content.includes("此前会话摘要")), JSON.stringify(fail.messages.slice(0, 2).map((m) => m.content)));
check("摘要字段为空", fail.summary === "");

// 5. 未超预算：原样返回且不调摘要
console.log("\n▶ 未超预算");
const tiny: ChatMessageLike[] = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
let called = false;
const noop = await compressMessages(tiny, 8000, async () => { called = true; return "x"; });
check("未超预算原样返回", noop.messages.length === tiny.length && !called);

// 6. v3.4 审计修复（H2）：system 消息永不参与压缩（强断言——旧弱断言「或保留 system」
// 恰好掩盖了 system 被压缩进摘要的行为）
console.log("\n▶ system 保留");
const sys = await compressMessages(longHistory, 8000, fakeSummarize);
check("压缩后首条必为原 system", sys.messages[0].role === "system" && sys.messages[0].content === "你是 InFu", JSON.stringify(sys.messages[0]));
check("摘要紧随 system（不夹在 system 与历史之间）", sys.messages[1]?.content.includes("此前会话摘要") === true, JSON.stringify(sys.messages[1]?.content));
check("压缩后消息数 = system + 摘要 + kept（≥3）", sys.messages.length >= 3, String(sys.messages.length));

// 6.5. v3.2 摘要过大拒绝（SUMMARY_MUST_BE_SMALLER：摘要 ≥ 被替换内容时降级为直接丢弃，
// 避免"压缩后反而更占"的无效压缩——估算低估时的保护）
console.log("\n▶ 摘要过大拒绝");
const bloatedSummarize = async () => `摘要：${"这是一个非常冗长的摘要内容用来撑大估算量。".repeat(600)}`;
const bloat = await compressMessages(longHistory, 8000, bloatedSummarize);
check("摘要过大被拒绝（不注入摘要标记）", !bloat.messages[0].content.includes("此前会话摘要"));
check("摘要过大降级为丢弃（summary 为空）", bloat.summary === "");
check("丢弃后仍比原历史短", bloat.messages.length < longHistory.length, String(bloat.messages.length));

// 6.6. v3.2 边界工具对平衡（balanceToolPairs 单元：kept 区首条为 tool 消息时向前找配对 assistant）
console.log("\n▶ 边界工具对平衡");
const pairHistory: ChatMessageLike[] = [
  { role: "system", content: "s" },
  { role: "user", content: "查看代码" },
  { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c2", content: "内容 A" },
  { role: "user", content: "继续" },
  { role: "assistant", content: "B" },
  { role: "assistant", content: "", tool_calls: [{ id: "c3", type: "function", function: { name: "read_file", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c3", content: "内容 C" },
  { role: "user", content: "最后" },
  { role: "assistant", content: "D" },
];
// kept 首条 = tool(c3)（索引 7）→ 前移到配对 assistant（索引 6）
check("tool 结果在边界 → 前移到配对 assistant", balanceToolPairs(pairHistory, 7) === 6, String(balanceToolPairs(pairHistory, 7)));
// 边界在普通消息上 → 原样
check("边界不在 tool 上 → 原样", balanceToolPairs(pairHistory, 8) === 8, String(balanceToolPairs(pairHistory, 8)));
// kept 首条 = tool(c2)（索引 3）→ 配对 assistant（索引 2）跨 user（索引 4 之后）无碍 → 前移到 2
check("tool 在边界且配对在 user 前 → 前移配对", balanceToolPairs(pairHistory, 3) === 2, String(balanceToolPairs(pairHistory, 3)));
// kept 首条 = tool 但配对被 user 消息隔断（构造畸形数据：tool 紧跟在 user 后）→ 保持原边界
const broken: ChatMessageLike[] = [
  { role: "system", content: "s" },
  { role: "user", content: "u" },
  { role: "tool", tool_call_id: "orphan", content: "内容" },
  { role: "assistant", content: "B" },
];
check("tool 无配对（畸形）→ 保持原边界", balanceToolPairs(broken, 2) === 2, String(balanceToolPairs(broken, 2)));
// 非 tool 首条 → 原样（含空数组安全）
check("空消息数组安全", balanceToolPairs([], 0) === 0);

// 7. serializeHistory 截断保护
console.log("\n▶ serializeHistory");
const huge: ChatMessageLike[] = [{ role: "user", content: "y".repeat(50000) }];
const ser = serializeHistory(huge);
check("超长历史序列化有总长上限", ser.length <= 30000 + 800, String(ser.length));

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
