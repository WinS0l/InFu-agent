/**
 * 子智能体控制自测（v2.11：后台模式 delegate_task background / list_agents / report /
 * send_message（agent_message 等待-恢复）/ interrupt_agent / 深度清理）
 * 运行：npx tsx packages/agent/tests/subagent-control.test.ts
 *
 * 覆盖：
 *  - startBackgroundSubagent：立即返回句柄（不阻塞）/ subagent-start 带 background 标记 / 完成态与 subagent-done
 *  - report：运行中 / 等待中 / 完成三种回收文本
 *  - agent_message 等待 → agent-waiting 事件 → send_message 恢复 → 子 Agent 继续并完成
 *  - send_message 错误分支：运行中 / 已完成 / 未找到
 *  - interrupt_agent：中止 → subagent-done ok=false
 *  - list_agents：列出全部状态
 *  - abortBackgroundAgentsByDepth：按深度清理运行中/等待中的后台子智能体
 *  - 后台委派同样受深度限制
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@infu/shared";
import {
  startBackgroundSubagent, listBackgroundAgents, getBackgroundAgent,
  interruptBackgroundAgent, sendMessageToAgent, getAgentReport, abortBackgroundAgentsByDepth,
  MAX_DELEGATION_DEPTH, type DelegationContext,
} from "../src/agent/subagent.js";
import { TOOLS } from "../src/tools/index.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

/** 轮询等待条件成立（带超时） */
async function waitUntil(cond: () => boolean, timeoutMs = 8000, interval = 50): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return cond();
}

// ── fetch mock（按调用序号路由：子 Agent 循环第 N 次模型调用给第 N 个响应；支持延迟模拟长任务）──
const originalFetch = globalThis.fetch;
let fetchResponses: Array<() => Response> = [];
let fetchDelays: Array<number> = [];
let fetchCount = 0;
function installFetch() {
  fetchCount = 0;
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    void body;
    const i = fetchCount++;
    const b = fetchResponses[i];
    if (!b) throw new TypeError(`no behavior for fetch call #${i}`);
    const delay = fetchDelays[i] ?? 0;
    if (delay > 0) {
      // 模拟真实网络：abort signal 生效（interrupt/父级中止时立即抛 AbortError，与真实 fetch 一致）
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true }
        );
      });
    }
    return b();
  };
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}
function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const textChunk = (text: string) => `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`;
const toolCallChunk = (name: string, args: string) =>
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"${name}","arguments":"${args}"}}]}}]}\n\n`;
const doneChunk = "data: [DONE]\n\n";
/** 工具调用响应（模型要求调用某工具） */
const toolCallResp = (name: string, args: Record<string, unknown>) =>
  sse(toolCallChunk(name, JSON.stringify(args).replace(/"/g, '\\"')) + doneChunk);
/** 纯文本响应（模型结束，无工具调用） */
const textResp = (text: string) => sse(textChunk(text) + doneChunk);

// ── 测试环境 ──
const root = mkdtempSync(join(tmpdir(), "infu-subagent-ctl-"));
mkdirSync(join(root, ".infu", "agents"), { recursive: true });
const SID = "sess-ctl-test";

let events: AgentEvent[] = [];
function makeCtx(overrides: Partial<DelegationContext> = {}): DelegationContext {
  return {
    tools: TOOLS,
    root,
    emit: (e) => events.push(e),
    requestApproval: async () => true,
    modelConfig: { provider: "deepseek", model: "sub-model", apiKey: "k", baseURL: "http://mock" },
    sessionId: SID,
    ...overrides,
  };
}

function startTest() {
  events = [];
  installFetch();
}

/** 工具层调用的最小 ToolContext（send_message 等管理工具只需 sessionId + emit） */
function toolCtxFor(sid: string, evts: AgentEvent[]): any {
  return { root, cwd: root, requestApproval: async () => true, emit: (e: AgentEvent) => evts.push(e), sessionId: sid };
}

(async () => {
  console.log("══ 子智能体控制（v2.11 后台模式）══");

  // ── 1. 后台启动立即返回 + 完成回收 ──
  startTest();
  fetchResponses = [() => textResp("后台任务完成摘要")];
  const h1 = startBackgroundSubagent({ prompt: "后台跑一个简单任务" }, makeCtx());
  check("后台启动立即返回句柄（不 await 子循环）", h1.status === "running", h1.status);
  check("注册表可查到", getBackgroundAgent(SID, h1.id) === h1);
  check("subagent-start 带 background 标记", events.some((e) => e.type === "subagent-start" && e.background === true));
  const doneOk = await waitUntil(() => h1.status === "done");
  check("子 Agent 自动完成（status=done）", doneOk, h1.status);
  check("subagent-done 事件带结果", events.some((e) => e.type === "subagent-done" && e.id === h1.id && e.text === "后台任务完成摘要"));
  const rep = getAgentReport(SID, h1.id);
  check("report 回收完成结果", rep.includes("后台任务完成摘要") && rep.includes(h1.id), rep.slice(0, 80));
  check("list_agents 列出完成项", listBackgroundAgents(SID).some((a) => a.id === h1.id && a.status === "done"));

  // ── 2. agent_message 等待 → send_message 恢复 → 继续完成 ──
  startTest();
  // 第 0 次调用：要求 agent_message；第 1 次调用：最终文本
  fetchResponses = [
    () => toolCallResp("agent_message", { message: "请问父级选择方案 A 还是 B？" }),
    () => textResp("已按方案 A 完成"),
  ];
  const h2 = startBackgroundSubagent({ prompt: "需要父级决策的任务" }, makeCtx());
  const waiting = await waitUntil(() => h2.status === "waiting");
  check("agent_message 后进入 waiting 状态", waiting, h2.status);
  check("agent-waiting 事件带消息", events.some((e) => e.type === "agent-waiting" && e.id === h2.id && (e as { message: string }).message.includes("方案 A 还是 B")));
  const wr = getAgentReport(SID, h2.id);
  check("report 在等待态提示可 send_message 恢复", wr.includes("send_message") && wr.includes("方案 A 还是 B"), wr.slice(0, 80));
  // 经工具层调用（同时验证 agent-resumed 事件发射）
  const sent = await TOOLS.send_message.execute({ agent_id: h2.id, message: "用方案 A" }, toolCtxFor(SID, events));
  check("send_message 恢复等待中的子 Agent", sent.includes("已发送"), sent);
  const resumed = await waitUntil(() => h2.status === "done");
  check("恢复后子 Agent 继续并完成", resumed, h2.status);
  check("最终结果含父级决策后的产出", getAgentReport(SID, h2.id).includes("已按方案 A 完成"));
  check("agent-resumed 事件已发", events.some((e) => e.type === "agent-resumed" && e.id === h2.id));

  // ── 3. send_message 错误分支 ──
  startTest();
  fetchResponses = [() => textResp("已完成任务")];
  const h3 = startBackgroundSubagent({ prompt: "短任务" }, makeCtx());
  await waitUntil(() => h3.status === "done");
  check("send_message 对已完成子 Agent 提示不可接收", /已完成/.test(sendMessageToAgent(SID, h3.id, "hi")));
  check("send_message 对不存在 id 报错", /未找到/.test(sendMessageToAgent(SID, "nope", "hi")));
  // 运行中分支：慢任务（第一响应延迟，第二响应才完成）
  startTest();
  fetchResponses = [() => textResp("慢任务完成")];
  fetchDelays = [600];
  const h3b = startBackgroundSubagent({ prompt: "慢任务" }, makeCtx());
  await new Promise((r) => setTimeout(r, 200));
  const busyMsg = sendMessageToAgent(SID, h3b.id, "hi");
  check("send_message 对运行中子 Agent 提示无需发送", /正在运行/.test(busyMsg), busyMsg);
  await waitUntil(() => h3b.status === "done");
  fetchDelays = [];

  // ── 4. interrupt_agent 中止 ──
  startTest();
  // 慢模型响应：200ms 时仍在运行中，interrupt 应能中止
  fetchResponses = [() => textResp("慢任务"), () => textResp("第二轮")];
  fetchDelays = [1000, 0];
  const h4 = startBackgroundSubagent({ prompt: "被中止的任务" }, makeCtx());
  await new Promise((r) => setTimeout(r, 200));
  const killed = interruptBackgroundAgent(SID, h4.id);
  check("interrupt_agent 返回 true", killed === true);
  const stopped = await waitUntil(() => h4.status !== "running", 8000);
  check("子 Agent 被中止（status=error）", stopped && h4.status === "error", h4.status);
  check("subagent-done ok=false", events.some((e) => e.type === "subagent-done" && e.id === h4.id && e.ok === false));
  check("interrupt 不存在 id 返回 false", interruptBackgroundAgent(SID, "nope") === false);
  fetchDelays = [];

  // ── 5. abortBackgroundAgentsByDepth 深度清理 ──
  startTest();
  fetchResponses = [() => textResp("完成1")];
  fetchDelays = [600];
  const h5 = startBackgroundSubagent({ prompt: "深度0任务" }, makeCtx({ delegationDepth: 0 }));
  await new Promise((r) => setTimeout(r, 200));
  // 无匹配深度不清理（模拟"其他深度启动的"后台子 Agent）
  abortBackgroundAgentsByDepth(SID, 5);
  check("无匹配深度不受清理影响", h5.status === "running", h5.status);
  // 匹配深度清理
  abortBackgroundAgentsByDepth(SID, 0);
  const cleaned = await waitUntil(() => h5.status === "error" || h5.status === "done");
  check("父级结束按深度中止后台子智能体", cleaned, h5.status);
  fetchDelays = [];

  // ── 6. 后台同样受深度限制 ──
  try {
    startBackgroundSubagent({ prompt: "x" }, makeCtx({ delegationDepth: MAX_DELEGATION_DEPTH }));
    check("后台委派超深度拒绝", false, "未抛错");
  } catch (e) {
    check("后台委派超深度拒绝", /深度超限/.test((e as Error).message), (e as Error).message.slice(0, 60));
  }

  restoreFetch();
  rmSync(root, { recursive: true, force: true });

  console.log(`\n子智能体控制：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exit(1);
})().catch((e) => {
  restoreFetch();
  console.error("测试异常:", e);
  process.exit(1);
});
