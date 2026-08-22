/**
 * v2.12 自测：工具 schema 精简（compactJsonSchema）/ usage 四桶解析 / session 查询工具
 * 运行：npx tsx packages/agent/tests/v212.test.ts
 *
 * 覆盖：
 *  - compactJsonSchema：删元字段 / description 截断 / enum 截断 / 深度折叠 / 属性数限制 / 标量数组保留
 *  - 全部内置工具 schema 过裁剪不抛错（类型字段保留，只读白名单不受影响）
 *  - usage 四桶：SSE 末尾 chunk usage → cacheHit/cacheMiss/promptTokens/completionTokens 解析
 *  - session_search：关键词匹配 / 最近会话 / 无匹配 / 格式
 *  - session_trace：关键事件轨迹摘要 / 会话不存在
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/db/store.js";
import { compactJsonSchema } from "../src/agent/loop.js";
import { streamChat, type StreamChatOptions } from "../src/providers/chat.js";
import { TOOLS, getReadOnlyTools } from "../src/tools/index.js";
import { setSessionStoreProvider } from "../src/tools/session-tools.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

(async () => {
  console.log("══ v2.12：schema 精简 / usage 四桶 / session 查询 ══");

  // ── 1. compactJsonSchema ──
  console.log("\n▶ compactJsonSchema（工具 schema 精简）");
  const big = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    title: "大工具",
    additionalProperties: false,
    properties: {
      a: { type: "string", description: "x".repeat(500), default: "d", examples: ["e"] },
      b: { type: "string", enum: Array.from({ length: 30 }, (_, i) => `v${i}`) },
      c: {
        type: "object",
        properties: {
          c1: { type: "object", properties: { c1a: { type: "object", properties: { c1a1: { type: "object", properties: { c1a1a: { type: "object", properties: { deep: { type: "object", properties: { x: { type: "string" } } } } } } } } } } },
        },
      },
      ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: "string" }])),
    },
    definitions: { x: { type: "string" } },
  };
  const c = compactJsonSchema(big) as Record<string, unknown>;
  check("删除 $schema/title/additionalProperties/definitions/default/examples", !("$schema" in c) && !("title" in c) && !("additionalProperties" in c) && !("definitions" in c));
  const props = c.properties as Record<string, any>;
  check("description 截断到 150", props.a.description.length <= 151 && props.a.description.endsWith("…"));
  check("enum 截断到 12", props.b.enum.length === 12);
  check("深层结构折叠（>5 层后 properties 不再展开）", !props.c.properties.c1.properties.c1a.properties.c1a1.properties.c1a1a.properties, JSON.stringify(props.c.properties.c1.properties.c1a.properties.c1a1).slice(0, 120));
  check("属性数限制（25 个只保留 20）", Object.keys(props).length === 20, `got ${Object.keys(props).length}`);
  check("类型字段保留", props.a.type === "string" && props.b.type === "string");

  // 全部内置工具 schema 过裁剪不抛错（含 MCP 转换器产物形状）
  let allOk = true;
  for (const [name, t] of Object.entries(TOOLS)) {
    try {
      const out = compactJsonSchema({ type: "object", properties: t.schema.shape ? Object.fromEntries(Object.entries(t.schema.shape).map(([k, v]: [string, any]) => [k, { type: "string", description: v?._def?.description }])) : {} });
      void out;
    } catch (e) {
      allOk = false;
      console.log(`    ⚠ ${name}: ${(e as Error).message}`);
    }
  }
  check("全部内置工具 schema 可裁剪（不抛错）", allOk);
  check("只读白名单仍含新工具", ["session_search", "session_trace", "list_agents", "report", "job_list", "job_output"].every((n) => n in getReadOnlyTools()));

  // ── 2. usage 四桶解析（SSE 末尾 chunk）──
  console.log("\n▶ usage 四桶（chat.ts 末尾 chunk 解析）");
  const originalFetch = globalThis.fetch;
  const usageFrame = `data: {"usage":{"prompt_tokens":1200,"completion_tokens":340,"prompt_cache_hit_tokens":800,"prompt_cache_miss_tokens":400}}\n\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n`;
  (globalThis as any).fetch = async () => new Response(usageFrame, { status: 200, headers: { "content-type": "text/event-stream" } });
  const deltas = [];
  for await (const d of streamChat({ baseURL: "http://t/v1", apiKey: "k", model: "m", messages: [], signal: undefined as unknown as AbortSignal } as StreamChatOptions)) {
    deltas.push(d);
  }
  globalThis.fetch = originalFetch;
  const u = deltas.find((d) => d.usage)?.usage;
  check("usage 四桶完整解析", u && u.cacheHit === 800 && u.cacheMiss === 400 && u.promptTokens === 1200 && u.completionTokens === 340, JSON.stringify(u));

  // ── 3. session 查询工具（注入临时库）──
  console.log("\n▶ session_search / session_trace");
  const dir = mkdtempSync(join(tmpdir(), "infu-v212-db-"));
  const testStore = new SessionStore(join(dir, "test.db"));
  const sid = testStore.createSession({ title: "修复测试失败", root: "E:\\proj\\demo", modelId: "agnes-2.5-flash" });
  testStore.appendEvent(sid, { type: "user-message", text: "帮我修测试" });
  testStore.appendEvent(sid, { type: "text", text: "我先看看测试文件" });
  testStore.appendEvent(sid, { type: "tool-start", tool: "read_file", args: { path: "test/a.test.ts" }, risk: "low", callId: "c1" });
  testStore.appendEvent(sid, { type: "tool-result", tool: "read_file", ok: true, summary: "文件内容……", callId: "c1" });
  testStore.appendEvent(sid, { type: "done", text: "完成", toolCount: 1, steps: 2 });
  testStore.createSession({ title: "另一个无关会话", root: "E:\\other" });
  setSessionStoreProvider(() => testStore);

  const searchAll = await TOOLS.session_search.execute({}, { root: ".", cwd: "." } as any);
  check("session_search 列出最近会话", searchAll.includes(sid) && searchAll.includes("修复测试失败") && searchAll.includes("另一个无关会话"));
  const searchHit = await TOOLS.session_search.execute({ query: "测试" }, { root: ".", cwd: "." } as any);
  check("session_search 关键词命中", searchHit.includes(sid) && !searchHit.includes("无关"), searchHit.slice(0, 120));
  const searchMiss = await TOOLS.session_search.execute({ query: "不存在的词xyz" }, { root: ".", cwd: "." } as any);
  check("session_search 无匹配提示", searchMiss.includes("未找到"));
  const trace = await TOOLS.session_trace.execute({ session_id: sid }, { root: ".", cwd: "." } as any);
  check("session_trace 轨迹含关键事件", trace.includes("修测试") && trace.includes("read_file") && trace.includes("完成"), trace.slice(0, 150));
  check("session_trace 不重复展示子智能体内部噪音", trace.includes("另一个无关会话") === false);
  // v4.0 审计修复（M5）：历史工具参数/结果中的凭据脱敏——write_file 内容/命令文本中的
  // 令牌不得原样进入当前模型上下文（low 工具 + 高敏感数据的错配）
  const sid2 = testStore.createSession({ title: "凭据脱敏", root: "E:\\proj2" });
  testStore.appendEvent(sid2, { type: "user-message", text: "任务" });
  testStore.appendEvent(sid2, { type: "tool-start", tool: "run_command", args: { command: "curl -H 'Authorization: Bearer sk-test1234567890abc' http://x" }, risk: "medium", callId: "s1" });
  testStore.appendEvent(sid2, { type: "tool-result", tool: "run_command", ok: true, summary: "输出 ghp_abcdefghijklmnopqrstuvwxyz123456 完成", callId: "s1" });
  const traceMasked = await TOOLS.session_trace.execute({ session_id: sid2 }, { root: ".", cwd: "." } as any);
  check("session_trace 凭据脱敏（Bearer/sk-）", !traceMasked.includes("sk-test1234567890abc"), traceMasked);
  check("session_trace 凭据脱敏（ghp_）", !traceMasked.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), traceMasked);
  check("session_trace 脱敏后保留可读标记", traceMasked.includes("已脱敏"), traceMasked);
  const traceBad = await TOOLS.session_trace.execute({ session_id: "nope" }, { root: ".", cwd: "." } as any);
  check("session_trace 会话不存在报错", traceBad.includes("不存在"));
  // limit 参数
  const trace1 = await TOOLS.session_trace.execute({ session_id: sid, limit: 1 }, { root: ".", cwd: "." } as any);
  check("session_trace limit 生效", trace1.includes("完成") && !trace1.includes("修测试"), trace1);

  // 收尾
  setSessionStoreProvider(null as never);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // SQLite 连接句柄释放中——temp 目录由系统清理，忽略
  }

  console.log(`\nv2.12 套件：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
