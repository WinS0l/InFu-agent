/**
 * 任务级 Token 预算守卫自测（v6.0 S4）
 * 运行：npx tsx packages/agent/tests/budget.test.ts
 *
 * 覆盖：
 *  - 预算用尽：累计真实用量（prompt+completion）达预算 → 优雅停止（不再发起任何模型调用，
 *    输出进度总结文本 + done 事件），本轮工具调用不执行
 *  - 无预算（0/缺省）：正常完整执行
 *  - 预算未用尽：任务正常完成
 *  - 跨阶段扣减语义：orchestrator remainBudget（Planner 用量后 Executor 拿剩余）
 */
import { runAgent } from "../src/agent/loop.js";
import type { AgentEvent } from "@infu/shared";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const root = mkdtempSync(join(tmpdir(), "infu-budget-"));
const SID = "sess-budget-test";

const originalFetch = globalThis.fetch;
let requestBodies: any[] = [];
// 每轮调用真实用量 20000（prompt 15000 + completion 5000）
// 注意：behaviors 传「函数」（懒执行）——数组字面量内直接调用会变成 Response 对象
function installFetch(behaviors: Array<() => Response>) {
  requestBodies = [];
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    requestBodies.push(body);
    const idx = requestBodies.length - 1;
    const b = behaviors[idx];
    if (!b) throw new TypeError(`no behavior for fetch #${idx}`);
    return b();
  };
}
function restoreFetch() { globalThis.fetch = originalFetch; }
function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const usageChunk = `\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15000,"completion_tokens":5000,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":15000}}\n\ndata: [DONE]\n\n`;
const okSse = (text: string) => sse(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n` + usageChunk.slice(2));
const toolCallSse = () => sse(
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"noop","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n` +
  `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":15000,"completion_tokens":5000,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":15000}}\n\ndata: [DONE]\n\n`
);

const noopTool = {
  name: "noop",
  description: "测试空操作",
  risk: "low" as const,
  schema: z.object({}),
  async execute() { return "noop 完成"; },
};

async function run(budget: number | undefined) {
  const events: AgentEvent[] = [];
  return runAgent({
    modelConfig: { provider: "deepseek", model: "m", apiKey: "k", baseURL: "http://mock" },
    system: "测试系统",
    prompt: "测试预算",
    tools: { noop: noopTool },
    root,
    emit: (e) => events.push(e),
    requestApproval: async () => true,
    maxSteps: 6,
    sessionId: SID,
    taskTokenBudget: budget,
  }).then((r) => ({ r, events }));
}

(async () => {
  console.log("══ 任务级 Token 预算守卫（v6.0 S4）══");

  // ── 0. 调试：无预算限制 + 3 行为，看 fetch 次数 ──
  console.log("\n▶ 调试（budget=1000000）");
  installFetch([() => toolCallSse(), () => toolCallSse(), () => okSse("最终结果")]);
  const r0 = await run(1000000);
  check("调试：正常完成", r0.r.text.includes("最终结果") && requestBodies.length === 3, `${r0.r.text.slice(0, 60)} fetches=${requestBodies.length}`);

  // ── 1. 预算用尽：第一次模型调用即超预算 → 停止，不再发起第二次调用 ──
  console.log("\n▶ 预算用尽（budget=15000，单轮真实用量 20000）");
  installFetch([() => toolCallSse(), () => toolCallSse(), () => okSse("最终结果")]);
  const r1 = await run(15000);
  check("停止并输出预算用尽说明", r1.r.text.includes("预算已用尽") && r1.r.text.includes("15,000"), r1.r.text.slice(0, 120));
  check("只发生了一次模型调用", requestBodies.length === 1, `calls=${requestBodies.length}`);
  check("本轮请求的工具照常执行（工具与调用同轮）", r1.r.toolCount === 1, String(r1.r.toolCount));
  check("done 事件已发", r1.events.some((e) => e.type === "done"));
  check("error 事件提示预算", r1.events.some((e) => e.type === "error" && e.message.includes("预算")));
  check("usage 已累计单轮真实用量", r1.r.usage?.promptTokens === 15000 && r1.r.usage?.completionTokens === 5000, JSON.stringify(r1.r.usage));

  // ── 2. 预算足够：完整执行（工具调用 + 最终回复）──
  console.log("\n▶ 预算足够（budget=100000）");
  installFetch([() => toolCallSse(), () => toolCallSse(), () => okSse("最终结果")]);
  const r2 = await run(100000);
  check("任务正常完成", r2.r.text.includes("最终结果"), r2.r.text.slice(0, 80));
  check("两次工具轮 + 收尾轮共三次模型调用", requestBodies.length === 3, `calls=${requestBodies.length}`);
  check("工具已执行两轮", r2.r.toolCount === 2, String(r2.r.toolCount));
  check("usage 三轮累计", r2.r.usage?.promptTokens === 45000 && r2.r.usage?.completionTokens === 15000, JSON.stringify(r2.r.usage));

  // ── 3. 无预算（缺省 = 0）：行为不变 ──
  console.log("\n▶ 无预算（不传）");
  installFetch([() => toolCallSse(), () => toolCallSse(), () => okSse("最终结果")]);
  const r3 = await run(undefined);
  check("正常完成且无预算文案", r3.r.text.includes("最终结果") && !r3.r.text.includes("预算已用尽"), r3.r.text.slice(0, 80));
  check("调用次数不受限（三轮）", requestBodies.length === 3, `calls=${requestBodies.length}`);

  // ── 4. 预算精确边界：累计 == 预算 → 停止（>= 语义）──
  console.log("\n▶ 边界（budget=20000，一轮恰好 20000）");
  installFetch([() => toolCallSse(), () => toolCallSse(), () => okSse("最终结果")]);
  const r4 = await run(20000);
  check("累计等于预算即停止", r4.r.text.includes("预算已用尽"), r4.r.text.slice(0, 80));
  check("只发生一次调用", requestBodies.length === 1, `calls=${requestBodies.length}`);

  restoreFetch();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});