/**
 * streamChat 自动重试自测（v2.2 可靠性）
 * 运行：npx tsx packages/agent/tests/retry.test.ts
 *
 * 覆盖：429 重试成功 / 5xx 耗尽抛错 / 401 不重试 / 网络错误重试 / 超时重试 / 流中断不重试
 */
import { streamChat, ModelApiError } from "../src/providers/chat.js";
import type { StreamChatOptions, ChatDelta } from "../src/providers/chat.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// ── fetch mock 设施 ──
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
function installFetch(impl: (call: number, init?: { body?: string }) => Promise<Response> | Response) {
  fetchCalls = 0;
  (globalThis as any).fetch = (_url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    fetchCalls++;
    // 响应 abort signal（超时/外部中止时挂起的请求必须能被中断）
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      init?.signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(impl(fetchCalls, init)).then(resolve, reject);
    });
  };
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}
function sse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}
async function collect(opts: Partial<StreamChatOptions> & Pick<StreamChatOptions, "messages">): Promise<string> {
  let text = "";
  for await (const d of streamChat({ baseURL: "http://test/v1", apiKey: "k", model: "m", ...opts } as StreamChatOptions)) {
    text += (d as ChatDelta).text ?? "";
  }
  return text;
}

console.log("\n=== streamChat 自动重试自测 ===\n");

// 1. 429 重试成功
console.log("▶ 429 → 重试成功");
installFetch((call) =>
  call === 1
    ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
    : sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
);
const t1 = await collect({ messages: [], retry: { maxAttempts: 3, baseDelayMs: 1 } });
check("429 后重试拿到内容", t1 === "ok", t1);
check("fetch 调用了 2 次", fetchCalls === 2, String(fetchCalls));

// 2. 5xx 重试耗尽抛错
console.log("\n▶ 5xx 耗尽抛错");
installFetch(() => new Response("boom", { status: 500 }));
try {
  await collect({ messages: [], retry: { maxAttempts: 3, baseDelayMs: 1 } });
  check("5xx 重试耗尽后抛错", false);
} catch (e) {
  check("5xx 重试耗尽后抛错", e instanceof ModelApiError && e.retryable && e.status === 500, String(e));
  check("5xx 尝试 3 次", fetchCalls === 3, String(fetchCalls));
}

// 3. 401 不重试
console.log("\n▶ 401 不重试");
installFetch(() => new Response("unauthorized", { status: 401 }));
try {
  await collect({ messages: [], retry: { maxAttempts: 3, baseDelayMs: 1 } });
  check("401 直接抛错", false);
} catch (e) {
  check("401 直接抛错", e instanceof ModelApiError && !e.retryable && e.status === 401, String(e));
  check("401 只尝试 1 次", fetchCalls === 1, String(fetchCalls));
}

// 4. 网络错误重试成功
console.log("\n▶ 网络错误 → 重试成功");
installFetch((call) => {
  if (call === 1) throw new TypeError("fetch failed");
  return sse('data: {"choices":[{"delta":{"content":"net-ok"}}]}\n\ndata: [DONE]\n\n');
});
const t4 = await collect({ messages: [], retry: { maxAttempts: 3, baseDelayMs: 1 } });
check("网络错误后重试拿到内容", t4 === "net-ok", t4);
check("网络错误 fetch 调用 2 次", fetchCalls === 2, String(fetchCalls));

// 5. 超时（timeoutMs 内无响应）重试后抛错
console.log("\n▶ 超时重试");
installFetch(() => new Promise<Response>(() => {})); // 永不响应 → 触发内部超时 abort
try {
  await collect({ messages: [], timeoutMs: 5, retry: { maxAttempts: 2, baseDelayMs: 1 } });
  check("超时重试后抛错", false);
} catch (e) {
  check("超时重试后抛错", e instanceof ModelApiError && /超时/.test(e.message), String(e));
  check("超时尝试 2 次", fetchCalls === 2, String(fetchCalls));
}

// 6. 流中断（已产出 delta）不重试
console.log("\n▶ 已产出内容后断流不重试");
installFetch(() => {
  let released = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      // 第一次 read：出数据（产 delta）；第二次 read：断流（抛错）
      if (!released) {
        released = true;
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        return;
      }
      c.error(new Error("stream broke"));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
});
try {
  await collect({ messages: [], retry: { maxAttempts: 3, baseDelayMs: 1 } });
  check("已产内容后断流抛错", false);
} catch (e) {
  check("已产内容后断流抛错", e instanceof ModelApiError && /流中断/.test(e.message), String(e));
  check("已产内容后断流不重试（1 次）", fetchCalls === 1, String(fetchCalls));
}

// 7. 用户中止不重试
console.log("\n▶ 用户中止不重试");
const ac = new AbortController();
installFetch((call, init) => {
  if (call === 1) throw new TypeError("fetch failed");
  return sse('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n');
});
ac.abort(); // 提前中止
try {
  await collect({ messages: [], signal: ac.signal, retry: { maxAttempts: 3, baseDelayMs: 1 } });
  check("中止时抛错", false);
} catch (e) {
  check("中止时抛错（AbortError 语义）", e instanceof Error, String(e));
  check("中止不重试（1 次）", fetchCalls === 1, String(fetchCalls));
}

restoreFetch();
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
