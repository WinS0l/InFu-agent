/**
 * 消息级上下文重建自测（v2.2 断点恢复地基）
 * 运行：npx tsx packages/agent/tests/rebuild.test.ts
 *
 * 覆盖：轮次结构 / 工具配对 / reasoning_content / 缺失占位 / 孤儿丢弃 / 空轮丢弃 /
 *      非对话事件忽略 / maxEvents 截断 / 无 callId 兜底
 */
import { rebuildMessages } from "../src/db/rebuild.js";
import type { StoredEvent, AgentEvent } from "@infu/shared";
import type { ChatMessageLike } from "../src/providers/chat.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// 事件流构造辅助：seq 自动递增
function evts(...events: AgentEvent[]): StoredEvent[] {
  return events.map((event, i) => ({ seq: i, ts: 1000 + i, event }));
}

console.log("\n=== 消息级上下文重建自测 ===\n");

// 1. 完整一轮：user → 思考 → 文本 + 工具调用 → 结果 → 收尾文本
console.log("▶ 完整轮次重建");
const msgs = rebuildMessages(
  evts(
    { type: "user-message", text: "帮我加个功能" },
    { type: "step-start", step: 1 },
    { type: "reasoning", text: "先分析" },
    { type: "text", text: "我来看看" },
    { type: "tool-start", tool: "read_file", args: { path: "a.ts" }, risk: "low", callId: "call-1" },
    { type: "tool-result", tool: "read_file", ok: true, summary: "文件内容", callId: "call-1" },
    { type: "step-start", step: 2 },
    { type: "text", text: "搞定了" },
    { type: "done", text: "x", toolCount: 1, steps: 2 }
  )
);
check("消息数 = user + 2 assistant + 1 tool", msgs.length === 4, JSON.stringify(msgs.map((m) => m.role)));
const [u, a1, tool, a2] = msgs;
check("首条是 user", u.role === "user" && u.content === "帮我加个功能");
check("assistant 含文本 + tool_calls", a1.role === "assistant" && a1.content === "我来看看" && (a1 as any).tool_calls?.length === 1);
check("tool_calls 结构与 wire 格式一致", (a1 as any).tool_calls[0].id === "call-1" && (a1 as any).tool_calls[0].function.name === "read_file" && (a1 as any).tool_calls[0].function.arguments === '{"path":"a.ts"}');
check("reasoning 进 reasoning_content", (a1 as any).reasoning_content === "先分析");
check("tool 消息配对（完整 summary）", tool.role === "tool" && (tool as any).tool_call_id === "call-1" && tool.content === "文件内容");
check("第二轮 assistant 纯文本", a2.role === "assistant" && a2.content === "搞定了" && !(a2 as any).tool_calls);

// 2. 缺失工具结果（rewind 截断）→ 补占位
console.log("\n▶ 结果缺失补占位");
const msgs2 = rebuildMessages(
  evts(
    { type: "user-message", text: "任务" },
    { type: "step-start", step: 1 },
    { type: "tool-start", tool: "write_file", args: { path: "b.ts", content: "x" }, risk: "high", callId: "call-9" }
  )
);
check("assistant + 占位 tool", msgs2.length === 3, JSON.stringify(msgs2.map((m) => m.role)));
check("占位消息带同一 callId", (msgs2[2] as any).tool_call_id === "call-9");
check("占位内容说明丢失", String(msgs2[2].content).includes("丢失"));

// 3. 孤儿 tool-result 丢弃 / 空轮丢弃 / 非对话事件忽略
console.log("\n▶ 孤儿结果与空轮");
const msgs3 = rebuildMessages(
  evts(
    { type: "user-message", text: "任务" },
    { type: "step-start", step: 1 },
    { type: "text", text: "无工具轮" },
    { type: "step-start", step: 2 }, // 空轮（无内容）
    { type: "phase-start", phase: "executor", label: "执行" },
    { type: "tool-result", tool: "read_file", ok: true, summary: "孤儿", callId: "orphan" },
    { type: "plan", id: "p", content: "计划" },
    { type: "report", content: "报告" },
    { type: "model-fallback", from: "a", to: "b", reason: "test" },
    { type: "approval-required", id: "ap", description: "x", risk: "high" }
  )
);
check("user + 1 轮 assistant（空轮/孤儿/非对话事件全部忽略）", msgs3.length === 2, JSON.stringify(msgs3.map((m) => m.role)));
check("文本轮完整", msgs3[1].role === "assistant" && msgs3[1].content === "无工具轮");

// 4. 并行工具调用（一个 assistant 多个 tool_calls + 多个结果）
console.log("\n▶ 并行工具调用重建");
const msgs4 = rebuildMessages(
  evts(
    { type: "user-message", text: "并行" },
    { type: "step-start", step: 1 },
    { type: "tool-start", tool: "search_code", args: { q: "a" }, risk: "low", callId: "c1" },
    { type: "tool-start", tool: "search_code", args: { q: "b" }, risk: "low", callId: "c2" },
    { type: "tool-result", tool: "search_code", ok: true, summary: "结果1", callId: "c1" },
    { type: "tool-result", tool: "search_code", ok: true, summary: "结果2", callId: "c2" }
  )
);
check("单 assistant 含 2 个 tool_calls", msgs4.length === 4, String(msgs4.length));
const a4 = msgs4[1] as any;
check("tool_calls 顺序与 index 一致", a4.tool_calls[0].id === "c1" && a4.tool_calls[1].id === "c2", JSON.stringify(a4.tool_calls));
check("结果按顺序配对", (msgs4[2] as any).tool_call_id === "c1" && (msgs4[3] as any).tool_call_id === "c2");

// 5. 无 callId 旧数据兜底
console.log("\n▶ 无 callId 旧数据");
const msgs5 = rebuildMessages(
  evts(
    { type: "user-message", text: "旧数据" },
    { type: "step-start", step: 1 },
    { type: "tool-start", tool: "list_directory", args: { path: "." }, risk: "low" } // 无 callId
  )
);
const a5 = msgs5[1] as any;
check("生成占位 id 且非空", a5.tool_calls?.[0]?.id && a5.tool_calls[0].id.startsWith("rebuilt-"));
check("占位 tool 消息配对", (msgs5[2] as any).tool_call_id === a5.tool_calls[0].id);

// 6. maxEvents 截断（只重建最近 N 个事件）
console.log("\n▶ maxEvents 截断");
const msgs6 = rebuildMessages(
  evts(
    { type: "user-message", text: "第一轮" },
    { type: "step-start", step: 1 },
    { type: "text", text: "第一轮输出" },
    { type: "user-message", text: "第二轮" },
    { type: "step-start", step: 1 },
    { type: "text", text: "第二轮输出" }
  ),
  { maxEvents: 3 }
);
check("截断后只含最近 3 事件的轮次", msgs6.length === 2 && msgs6[0].role === "user" && msgs6[0].content === "第二轮", JSON.stringify(msgs6.map((m) => m.role)));

// 7. includeReasoning 关闭
console.log("\n▶ includeReasoning 关闭");
const msgs7 = rebuildMessages(
  evts(
    { type: "user-message", text: "x" },
    { type: "step-start", step: 1 },
    { type: "reasoning", text: "思考" },
    { type: "text", text: "正文" }
  ),
  { includeReasoning: false }
);
check("不携带 reasoning_content", (msgs7[1] as any).reasoning_content === undefined && msgs7[1].content === "正文");

// 8. 空事件流
console.log("\n▶ 空事件流");
check("空流返回空数组", rebuildMessages([]).length === 0);

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
