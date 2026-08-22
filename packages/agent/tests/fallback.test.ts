/**
 * 降级链自测（v2.2 可靠性：主模型失败 → 备用模型切换）
 * 运行：npx tsx packages/agent/tests/fallback.test.ts
 *
 * 覆盖：主失败降级成功 / 链耗尽抛错 / 已产出内容不降级 / 降级状态跨调用保持 /
 *      resolveFallbackModels（自引用/重复/未知 id/显式优先）
 */
import { ModelChain, streamChatWithFailover } from "../src/providers/gateway.js";
import { resolveFallbackModels } from "../src/providers/registry.js";
import type { ModelConfig } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// ── fetch mock：按请求体里的 model 区分行为 ──
const originalFetch = globalThis.fetch;
let fetchCalls: string[] = []; // 记录请求过的 model 名（顺序）
function installFetch(behaviors: Record<string, () => Promise<Response> | Response | never>) {
  fetchCalls = [];
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    fetchCalls.push(body.model);
    const b = behaviors[body.model];
    if (!b) throw new TypeError(`no behavior for model ${body.model}`);
    return b();
  };
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}
function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
async function collect(chain: ModelChain, messages = []): Promise<string> {
  let text = "";
  for await (const d of streamChatWithFailover({ chain, messages, retry: { maxAttempts: 2, baseDelayMs: 1 } })) {
    text += d.text ?? "";
  }
  return text;
}

const A = { provider: "deepseek", model: "model-a", apiKey: "k" };
const B = { provider: "zhipu", model: "model-b", apiKey: "k" };

console.log("\n=== 降级链自测 ===\n");

// 1. 主模型失败 → 降级备用 → 成功
console.log("▶ 主失败降级成功");
const fallbacks1: Array<{ from: string; to: string; reason: string }> = [];
installFetch({
  "model-a": () => { throw new TypeError("fetch failed"); },
  "model-b": () => sse('data: {"choices":[{"delta":{"content":"from-b"}}]}\n\ndata: [DONE]\n\n'),
});
const chain1 = new ModelChain([A, B], { onFallback: (from, to, reason) => fallbacks1.push({ from, to, reason }) });
const t1 = await collect(chain1);
check("降级后拿到备用模型内容", t1 === "from-b", t1);
check("onFallback 收到 from/to/reason", fallbacks1.length === 1 && fallbacks1[0].from === "model-a" && fallbacks1[0].to === "model-b" && /失败/.test(fallbacks1[0].reason), JSON.stringify(fallbacks1));
// 语义：a 重试耗尽（maxAttempts=2 → a 请求 2 次）→ 降级 b 成功
check("请求顺序 a×2 → b", fetchCalls.join(",") === "model-a,model-a,model-b", fetchCalls.join(","));

// 2. 链耗尽抛错（且 onFallback 只触发一次）
console.log("\n▶ 链耗尽抛错");
const fallbacks2: string[] = [];
installFetch({
  "model-a": () => { throw new TypeError("a down"); },
  "model-b": () => { throw new TypeError("b down"); },
});
const chain2 = new ModelChain([A, B], { onFallback: (from, to) => fallbacks2.push(`${from}->${to}`) });
try {
  await collect(chain2);
  check("链耗尽抛错", false);
} catch (e) {
  // 语义：链耗尽量抛出最后活动模型的错误（a 耗尽 → 降级 b → b 也耗尽 → 抛 b 的错误）
  check("链耗尽抛错（最后活动模型错误）", /b down/.test((e as Error).message), String(e));
  check("只降级一次", fallbacks2.length === 1 && fallbacks2[0] === "model-a->model-b");
  check("尝试过 a 和 b", fetchCalls.includes("model-a") && fetchCalls.includes("model-b"));
}

// 3. 已产出内容后断流：不降级
console.log("\n▶ 已产出内容后断流不降级");
const fallbacks3: string[] = [];
installFetch({
  "model-a": () => {
    let released = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        // 第一次 read：出数据（产 delta）；第二次 read：断流（抛错）
        if (!released) {
          released = true;
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          return;
        }
        c.error(new Error("broke"));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  },
});
const chain3 = new ModelChain([A, B], { onFallback: (from, to) => fallbacks3.push(`${from}->${to}`) });
try {
  await collect(chain3);
  check("已产内容断流抛错", false);
} catch (e) {
  check("已产内容断流抛错", /流中断/.test((e as Error).message), String(e));
  check("不降级（备用未被请求）", fallbacks3.length === 0 && fetchCalls.join(",") === "model-a", fetchCalls.join(","));
}

// 4. 降级状态跨调用保持（第二步直接从备用开始）
console.log("\n▶ 降级状态跨调用保持");
installFetch({
  "model-a": () => { throw new TypeError("a down"); },
  "model-b": () => sse('data: {"choices":[{"delta":{"content":"b-ok"}}]}\n\ndata: [DONE]\n\n'),
});
const chain4 = new ModelChain([A, B]);
const step1 = await collect(chain4);
check("第一步降级成功", step1 === "b-ok");
check("降级后活动模型为 B", chain4.active.model === "model-b");
fetchCalls = [];
const step2 = await collect(chain4);
check("第二步直接用 B（不重复尝试 A）", step2 === "b-ok" && fetchCalls.join(",") === "model-b", fetchCalls.join(","));

// 5. 单候选 = 无降级能力
console.log("\n▶ 单候选无降级");
installFetch({ "model-a": () => { throw new TypeError("a down"); } });
const chain5 = new ModelChain([A]);
try {
  await collect(chain5);
  check("单候选失败抛错", false);
} catch (e) {
  check("单候选失败抛错", /a down/.test((e as Error).message));
}

// 6. resolveFallbackModels：自引用/重复/未知 id/显式优先
console.log("\n▶ resolveFallbackModels 解析");
const cfgModels: ModelConfig[] = [
  { id: "main", name: "主", provider: "deepseek", model: "m-main", fallbackModelIds: ["self", "fb1", "fb1", "nope", "fb2"] },
  { id: "fb1", name: "备1", provider: "zhipu", model: "m-fb1" },
  { id: "fb2", name: "备2", provider: "qwen", model: "m-fb2" },
  { id: "other", name: "其他", provider: "openai", model: "m-other" },
];
const cfg = { models: cfgModels, version: 1 };
const r1 = resolveFallbackModels(cfg, cfgModels[0]);
check("自身/重复/未知 id 全部跳过", r1.map((m) => m.id).join(",") === "fb1,fb2", JSON.stringify(r1.map((m) => m.id)));
const r2 = resolveFallbackModels(cfg, cfgModels[0], ["other", "nope", "fb1"]);
check("显式列表优先（含未知 id 跳过）", r2.map((m) => m.id).join(",") === "other,fb1", JSON.stringify(r2.map((m) => m.id)));
const r3 = resolveFallbackModels(cfg, cfgModels[0], []);
check("空显式列表回退自身配置", r3.map((m) => m.id).join(",") === "fb1,fb2");
check("无 fallback 配置返回空", resolveFallbackModels(cfg, cfgModels[3]).length === 0);
check("config 缺失返回空", resolveFallbackModels(null, cfgModels[0]).length === 0);

// 7. ModelChain 构造校验
console.log("\n▶ ModelChain 构造");
try {
  new ModelChain([]);
  check("空链抛错", false);
} catch (e) {
  check("空链抛错", /至少需要一个候选模型/.test((e as Error).message));
}

restoreFetch();
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
