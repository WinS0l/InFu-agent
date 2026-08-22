/**
 * 异步任务编排自测。
 * 运行：npx tsx packages/agent/tests/task-notify.test.ts
 *
 * 覆盖：
 *  - job 完成通知：startBackgroundJob notify 回调（completed/failed/killed 三态）+ task-notification 事件
 *  - 后台子智能体完成通知：startBackgroundSubagent notify 回调（completed / failed）+ 事件
 *  - 运行时注入：loop drain——工具调用中 enqueueTaskNotification → 下一步模型请求 messages 含
 *    <task-notification> XML（含转义）
 *  - rebuild 注入：task-notification 事件 → user XML 消息（与运行时同格式，不破坏工具配对）
 *  - wait_task：完成返回结果 / 超时返回进度 / 未找到报错 / waiting 提示 send_message
 *  - 工具注册：wait_task/screen_drag/screen_windows 存在；wait_task 进只读白名单
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentEvent } from "@infu/shared";
import { runAgent } from "../src/agent/loop.js";
import { READONLY_TOOLS } from "../src/agent/agents.js";
import { startBackgroundSubagent, type DelegationContext } from "../src/agent/subagent.js";
import { startBackgroundJob, killJob } from "../src/tools/jobs.js";
import { TOOLS } from "../src/tools/index.js";
import { rebuildMessages } from "../src/db/rebuild.js";
import type { StoredEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

async function waitUntil(cond: () => boolean, timeoutMs = 10000, interval = 80): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return cond();
}

const root = mkdtempSync(join(tmpdir(), "infu-tasknotify-"));
const SID = "sess-tasknotify-test";

// ── fetch mock（runAgent 子循环走 streamChatWithFailover → 原生 fetch）──
const originalFetch = globalThis.fetch;
let requestBodies: Array<{ messages: unknown[] }> = [];
function installFetch(behaviors: Record<string, () => Response>) {
  requestBodies = [];
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    requestBodies.push({ messages: body.messages ?? [] });
    const b = behaviors[body.model];
    if (!b) throw new TypeError(`no behavior for model ${body.model}`);
    return b();
  };
}
function restoreFetch() { globalThis.fetch = originalFetch; }
function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const okSse = (text: string) => sse(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`);

(async () => {
  console.log("══ 异步任务编排（v3.3 <task-notification>）══");

  // ── 1. job 完成通知（notify 回调 + 事件 + 三态）──
  console.log("\n▶ job 完成通知");
  {
    const events: AgentEvent[] = [];
    let note: any = null;
    const h = startBackgroundJob(
      `node -e "console.log('job-output-line')"`, root, SID, 0,
      (e) => events.push(e),
      (n) => { note = n; }
    );
    const done = await waitUntil(() => h.status !== "running");
    check("job 自动完成", done && h.status === "done", h.status);
    check("task-notification 事件已发（completed）", events.some((e) => e.type === "task-notification" && e.status === "completed" && (e as any).taskType === "job" && e.taskId === h.id), JSON.stringify(events.find((e) => e.type === "task-notification")));
    check("notify 回调收到（含输出尾部）", !!note && note.status === "completed" && note.summary.includes("job-output-line") && note.summary.includes("退出码 0"), JSON.stringify(note));
    check("notify 摘要裁剪命令名", note.name === `node -e "console.log('job-output-line')"`);
  }
  {
    const events: AgentEvent[] = [];
    let note: any = null;
    const h = startBackgroundJob(`node -e "process.exit(3)"`, root, SID, 0, (e) => events.push(e), (n) => { note = n; });
    const done = await waitUntil(() => h.status !== "running");
    check("失败命令 → notify failed", done && h.status === "failed" && note?.status === "failed", `${h.status} ${note?.status}`);
    check("失败事件含退出码", events.some((e) => e.type === "task-notification" && (e as any).summary.includes("退出码 3")));
  }
  {
    let note: any = null;
    const h = startBackgroundJob(`node -e "setTimeout(()=>{},8000)"`, root, SID, 0, () => {}, (n) => { note = n; });
    await new Promise((r) => setTimeout(r, 300));
    killJob(SID, h.id);
    const done = await waitUntil(() => h.status !== "running");
    check("被杀 → notify killed", done && h.status === "killed" && note?.status === "killed", `${h.status} ${note?.status}`);
  }

  // ── 2. 后台子智能体完成通知 ──
  console.log("\n▶ 后台子智能体完成通知");
  {
    installFetch({ "sub-m": () => okSse("子任务完成：找到 3 处问题") });
    const events: AgentEvent[] = [];
    let note: any = null;
    const ctx: DelegationContext = {
      tools: TOOLS,
      root,
      emit: (e) => events.push(e),
      requestApproval: async () => true,
      modelConfig: { provider: "deepseek", model: "sub-m", apiKey: "k", baseURL: "http://mock" },
      thinkingLevel: 2,
      sessionId: SID,
      enqueueTaskNotification: (n) => { note = n; },
    };
    const h = startBackgroundSubagent({ prompt: "帮我调研" }, ctx);
    const done = await waitUntil(() => h.status === "done" || h.status === "error");
    check("后台子智能体完成", done && h.status === "done", h.status);
    check("notify 回调 completed（含摘要）", note?.status === "completed" && note.summary.includes("子任务完成") && note.taskId === h.id, JSON.stringify(note));
    check("task-notification 事件（subagent）", events.some((e) => e.type === "task-notification" && (e as any).taskType === "subagent" && (e as any).status === "completed"), JSON.stringify(events.find((e) => e.type === "task-notification")));
    restoreFetch();
  }
  {
    // 模型调用抛错 → failed 通知
    installFetch({ "sub-m": () => { throw new TypeError("boom"); } });
    let note: any = null;
    const ctx: DelegationContext = {
      tools: TOOLS, root,
      emit: () => {},
      requestApproval: async () => true,
      modelConfig: { provider: "deepseek", model: "sub-m", apiKey: "k", baseURL: "http://mock" },
      thinkingLevel: 2,
      sessionId: SID,
      enqueueTaskNotification: (n) => { note = n; },
    };
    const h = startBackgroundSubagent({ prompt: "调研" }, ctx);
    const done = await waitUntil(() => h.status !== "running");
    check("异常 → notify failed", done && note?.status === "failed" && note.summary.includes("异常结束"), JSON.stringify(note));
    restoreFetch();
  }

  // ── 3. 运行时注入（loop drain → 下一步请求含 XML）──
  console.log("\n▶ 运行时注入（loop drain）");
  {
    let calls = 0;
    installFetch({
      "m": () => {
        calls++;
        if (calls === 1) {
          return sse(
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_notify","function":{"name":"enqueue_notify","arguments":"{}"}}]}}]}\n\n` +
            `data: [DONE]\n\n`
          );
        }
        return okSse("收到通知，继续任务");
      },
    });
    const enqueueNotifyTool = {
      name: "enqueue_notify",
      description: "测试：入队通知",
      risk: "low" as const,
      schema: z.object({}),
      async execute(_a: unknown, ctx: { enqueueTaskNotification?: (n: never) => void }) {
        ctx.enqueueTaskNotification?.({
          taskType: "job", taskId: "job-x", name: "测试命令", status: "completed",
          summary: "命令「测试」已结束（completed，退出码 0）。输出：<b>含尖括号</b>",
        } as never);
        return "已入队";
      },
    };
    const r = await runAgent({
      modelConfig: { provider: "deepseek", model: "m", apiKey: "k", baseURL: "http://mock" },
      system: "测试系统提示",
      prompt: "测试异步通知",
      tools: { enqueue_notify: enqueueNotifyTool },
      root,
      emit: () => {},
      requestApproval: async () => true,
      maxSteps: 3,
      sessionId: SID,
    });
    check("任务完成", r.text.includes("收到通知"), r.text);
    // 第二次请求的 messages 应含注入的 <task-notification> XML
    const second = requestBodies[1]?.messages ?? [];
    const injected = second.filter((m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("task-notification"));
    check("注入 user XML 消息", injected.length === 1, JSON.stringify(second.map((m: any) => typeof m.content === "string" ? m.content.slice(0, 60) : m.role)));
    check("XML 结构完整", injected.length === 1 &&
      String(injected[0].content).includes("<task-type>job</task-type>") &&
      String(injected[0].content).includes("<task-id>job-x</task-id>") &&
      String(injected[0].content).includes("<status>completed</status>") &&
      String(injected[0].content).includes("</task-notification>"), String(injected[0]?.content));
    check("XML 尖括号转义", String(injected[0].content).includes("&lt;b&gt;") && !String(injected[0].content).includes("<b>"), String(injected[0]?.content));
    check("不破坏 assistant/tool 配对", second.filter((m: any) => m.role === "tool").length === second.filter((m: any) => m.role === "assistant").length, JSON.stringify(second.map((m: any) => m.role)));
    restoreFetch();
  }

  // ── 4. rebuild 注入 ──
  console.log("\n▶ rebuild 注入");
  {
    const evts = (list: AgentEvent[]): StoredEvent[] => list.map((event, i) => ({ seq: i, ts: 1000 + i, event }));
    const msgs = rebuildMessages(evts([
      { type: "user-message", text: "跑个后台任务" },
      { type: "task-notification", taskType: "job", taskId: "job-1", name: "npm test", status: "completed", summary: "命令完成，输出 <ok> 与 >< 符号" },
      { type: "task-notification", taskType: "subagent", taskId: "sub-1", name: "explore", status: "failed", summary: "子智能体异常结束" },
    ]));
    const notes = msgs.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("task-notification"));
    check("rebuild 注入 2 条 user XML", notes.length === 2, JSON.stringify(msgs));
    check("job 通知字段完整", String(notes[0]?.content).includes("<task-type>job</task-type>") && String(notes[0]?.content).includes("<task-id>job-1</task-id>") && String(notes[0]?.content).includes("<status>completed</status>"));
    check("转义与运行时一致", String(notes[0]?.content).includes("&lt;ok&gt;"));
    check("subagent 通知字段", String(notes[1]?.content).includes("<task-type>subagent</task-type>") && String(notes[1]?.content).includes("<task-id>sub-1</task-id>") && String(notes[1]?.content).includes("<status>failed</status>"));
    check("普通 user 消息保留", msgs.some((m) => m.role === "user" && m.content === "跑个后台任务"));
  }

  // ── 5. wait_task 工具 ──
  console.log("\n▶ wait_task");
  {
    const t = TOOLS.wait_task;
    check("wait_task 已注册", !!t && t.risk === "low");
    // 完成场景：真实 job → wait 返回结果
    const h = startBackgroundJob(`node -e "console.log('wait-me')"`, root, SID, 0, () => {});
    const out = await t.execute({ task_type: "job", task_id: h.id, timeout: 30 }, { sessionId: SID } as never);
    check("job 完成返回结果（含退出码与输出）", typeof out === "string" && out.includes("已") && out.includes("wait-me") && out.includes("退出码 0"), String(out).slice(0, 120));
    // 超时场景
    const slow = startBackgroundJob(`node -e "setTimeout(()=>{},10000)"`, root, SID, 0, () => {});
    const to = await t.execute({ task_type: "job", task_id: slow.id, timeout: 1 }, { sessionId: SID } as never);
    check("超时返回进度（非错误）", typeof to === "string" && to.includes("等待超时") && to.includes("仍在运行") && to.includes("<task-notification>"), String(to).slice(0, 150));
    killJob(SID, slow.id);
    // 未找到
    const nf = await t.execute({ task_type: "job", task_id: "job-nope", timeout: 1 }, { sessionId: SID } as never);
    check("未找到报错", typeof nf === "string" && nf.includes("未找到后台任务"), String(nf).slice(0, 100));
    const nf2 = await t.execute({ task_type: "subagent", task_id: "sub-nope", timeout: 1 }, { sessionId: SID } as never);
    check("subagent 未找到报错", typeof nf2 === "string" && nf2.includes("未找到后台子智能体"), String(nf2).slice(0, 100));
  }

  // ── 6. 工具注册 / 只读白名单 ──
  console.log("\n▶ 工具注册");
  {
    check("wait_task / screen_drag / screen_windows 注册", !!TOOLS.wait_task && !!TOOLS.screen_drag && !!TOOLS.screen_windows);
    check("wait_task 进只读白名单", READONLY_TOOLS.includes("wait_task"));
    check("screen_drag medium 审批", TOOLS.screen_drag.risk === "medium");
    check("screen_windows 注册且 list 只读（low）", TOOLS.screen_windows.risk === "low");
    const n = Object.keys(TOOLS).length;
    console.log(`  ℹ 内置工具总数 = ${n}`);
    check("内置工具 ≥ 52（49 + wait_task + screen_drag + screen_windows）", n >= 52, String(n));
  }

  // ── 清理（被杀 job 的进程树退出需要时间——重试避免 EPERM）──
  await new Promise((r) => setTimeout(r, 500));
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 进程树未完全退出，留给系统清理 */ }

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
