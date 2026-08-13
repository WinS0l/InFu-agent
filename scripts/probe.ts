#!/usr/bin/env node
/**
 * provider 兼容矩阵探针（v2.2）
 * 用法：npm run probe -- <modelId>    （如 npm run probe -- deepseek-v4-flash）
 *
 * 对指定模型跑一组协议探针，输出差异报告（回填 docs/PROVIDER-MATRIX.md）：
 *   1. 纯文本生成（流式）   2. reasoning_content（思考字段）
 *   3. 单轮工具调用         4. 多轮工具调用（结果回填）
 *   5. 中文长输出
 *
 * 探针直连原生 OpenAI Chat Completions 协议（与 Agent 同路径 streamChat），
 * 不经过编排层——差异定位更干净。
 */
import { loadConfig, resolveModel, toRuntimeModel } from "../packages/agent/src/providers/registry.js";
import { streamChat, type ChatMessageLike, type StreamChatOptions } from "../packages/agent/src/providers/chat.js";

const modelId = process.argv[2];
if (!modelId) {
  console.error("用法：npm run probe -- <modelId>（如 deepseek-v4-flash）");
  process.exit(1);
}

async function main() {
const cfg = loadConfig();
const model = resolveModel(cfg, modelId);
const rt = toRuntimeModel(model);
console.log(`\n═══ 兼容性探针：${model.name}（${rt.provider}/${rt.model}）═══\n`);

const PROBE_TOOLS: StreamChatOptions["tools"] = [
  {
    type: "function",
    function: {
      name: "get_now",
      description: "获取当前时间（格式：YYYY-MM-DD HH:MM）",
      parameters: { type: "object", properties: {} },
    },
  },
];

interface ProbeOutcome { ok: boolean; detail: string }

async function callOnce(opts: { messages: ChatMessageLike[]; tools?: StreamChatOptions["tools"] }): Promise<{
  text: string; reasoning: string; toolCalls: Array<{ id: string; name: string; arguments: string }>;
}> {
  let text = "";
  let reasoning = "";
  let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  for await (const d of streamChat({
    baseURL: rt.baseURL, apiKey: rt.apiKey, model: rt.model,
    messages: opts.messages, tools: opts.tools, timeoutMs: 60000,
  })) {
    if (d.reasoning) reasoning += d.reasoning;
    if (d.text) text += d.text;
    if (d.toolCalls?.length) toolCalls = d.toolCalls.map((tc) => ({ id: tc.id ?? "", name: tc.name ?? "", arguments: tc.arguments ?? "" }));
  }
  return { text, reasoning, toolCalls };
}

// 1. 纯文本生成（流式）
async function probeText(messages: ChatMessageLike[]): Promise<ProbeOutcome> {
  const r = await callOnce({ messages });
  return { ok: r.text.trim().length > 0, detail: `产出 ${r.text.trim().length} 字符` };
}

// 2. reasoning 探测
async function probeReasoning(): Promise<ProbeOutcome> {
  const r = await callOnce({
    messages: [{ role: "user", content: "9.9 和 9.11 哪个大？请先仔细思考推理过程，再给出最终答案。" }],
  });
  const hasReasoning = r.reasoning.trim().length > 0;
  return { ok: true, detail: hasReasoning ? `有思考字段（${r.reasoning.trim().length} 字符）` : "无思考字段（返回空）" };
}

// 3/4. 工具调用（rounds 轮，结果回填）
async function probeTools(rounds: number): Promise<ProbeOutcome> {
  const messages: ChatMessageLike[] = [
    { role: "user", content: `请连续 ${rounds} 次调用 get_now 工具获取当前时间，每次获取后都要把结果告诉我。` },
  ];
  let executed = 0;
  for (let r = 0; r < rounds; r++) {
    const out = await callOnce({ messages, tools: PROBE_TOOLS });
    if (!out.toolCalls.length) break;
    executed++;
    messages.push({
      role: "assistant",
      content: out.text,
      tool_calls: out.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments || "{}" } })),
    });
    for (const c of out.toolCalls) {
      messages.push({ role: "tool", tool_call_id: c.id, content: "当前时间：2026-08-13 12:00" });
    }
    if (r === 0 && out.text) {
      messages.push({ role: "user", content: "继续。请再次调用 get_now。" });
    }
  }
  return { ok: executed === rounds, detail: `成功发起 ${executed}/${rounds} 轮工具调用` };
}

// 主流程
const results: Array<{ name: string; outcome: ProbeOutcome }> = [];

for (const [name, fn] of [
  ["① 纯文本生成（流式）", () => probeText([{ role: "user", content: "用一句话介绍你自己。" }])],
  ["② reasoning_content（思考字段）", probeReasoning],
  ["③ 单轮工具调用", () => probeTools(1)],
  ["④ 多轮工具调用（结果回填）", () => probeTools(2)],
  ["⑤ 中文长输出", () => probeText([{ role: "user", content: "请用中文写一篇 200 字左右的短文介绍人工智能。" }])],
] as Array<[string, () => Promise<ProbeOutcome>]>) {
  try {
    const outcome = await fn();
    results.push({ name, outcome });
    console.log(`  ${outcome.ok ? "✅" : "⚠️"} ${name}：${outcome.detail}`);
  } catch (e) {
    results.push({ name, outcome: { ok: false, detail: `异常：${(e as Error).message.slice(0, 150)}` } });
    console.log(`  ❌ ${name}：${(e as Error).message.slice(0, 150)}`);
  }
}

// 汇总（供回填 PROVIDER-MATRIX.md）
console.log(`\n═══ 汇总（${results.filter((r) => r.outcome.ok).length}/${results.length} 通过）═══`);
console.log(`| ${model.provider} | ${model.model} |` + results.map((r) => ` ${r.outcome.ok ? "✅" : "❌"} ${r.name.replace(/^.\s*/, "")}：${r.outcome.detail} |`).join(""));
process.exit(results.every((r) => r.outcome.ok) ? 0 : 2);
}

main().catch((e) => {
  console.error(`✗ 探针运行失败：${e.message}`);
  process.exit(1);
});
