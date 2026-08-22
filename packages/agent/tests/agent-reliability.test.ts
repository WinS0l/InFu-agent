/**
 * Agent 可靠性场景测试。
 *
 * 覆盖真实 loop 的多轮闭环：文件读取 → 编辑 → 独立验证 → 交付，及工具失败后
 * 阻止原样重试、接受新参数恢复。它刻意不把可靠性只建立在单个工具的单元测试上。
 * 运行：npx tsx packages/agent/tests/agent-reliability.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentEvent } from "@infu/shared";
import { runAgent, summarizeAgentMetrics } from "../src/agent/loop.js";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const originalFetch = globalThis.fetch;
let requests: Array<{ messages?: Array<{ role: string; content?: string }> }> = [];

function sseChunk(delta: Record<string, unknown>, finishReason?: string) {
  return `data: ${JSON.stringify({ choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }] })}\n\n`;
}
function toolCall(name: string, args: object, id: string) {
  return new Response(
    sseChunk({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
function finalText(text: string) {
  return new Response(sseChunk({ content: text }, "stop") + "data: [DONE]\n\n", {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}
function installFetch(responses: Array<() => Response>) {
  requests = [];
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    const response = responses[requests.length - 1];
    if (!response) throw new Error(`unexpected model request #${requests.length}`);
    return response();
  };
}

async function run(root: string, tools: Record<string, any>, sessionId: string, events: AgentEvent[]) {
  return runAgent({
    modelConfig: { provider: "deepseek", model: "reliability-mock", apiKey: "test", baseURL: "http://mock" },
    system: "可靠性测试系统提示",
    prompt: "执行可靠性测试任务",
    tools,
    root,
    sessionId,
    maxSteps: 8,
    emit: (event) => events.push(event),
    requestApproval: async () => true,
  });
}

(async () => {
  console.log("══ Agent 关键链路可靠性场景 ══");
  const root = mkdtempSync(join(tmpdir(), "infu-agent-reliability-"));
  try {
    console.log("\n▶ 文件读取 → 编辑 → 验证 → 交付");
    const document = join(root, "document.txt");
    writeFileSync(document, "status=draft\n", "utf8");
    const order: string[] = [];
    const fileTools = {
      read_doc: {
        name: "read_doc", description: "读取文件", risk: "low" as const,
        schema: z.object({ path: z.string() }),
        async execute({ path }: { path: string }) { order.push("read"); return readFileSync(path, "utf8"); },
      },
      edit_doc: {
        name: "edit_doc", description: "编辑文件", risk: "low" as const,
        schema: z.object({ path: z.string(), text: z.string() }),
        async execute({ path, text }: { path: string; text: string }) { order.push("edit"); writeFileSync(path, text, "utf8"); return "编辑完成"; },
      },
      verify_doc: {
        name: "verify_doc", description: "验证文件", risk: "low" as const,
        schema: z.object({ path: z.string(), expected: z.string() }),
        async execute({ path, expected }: { path: string; expected: string }) {
          order.push("verify");
          return readFileSync(path, "utf8") === expected ? "验证通过：文件内容匹配" : "错误：验证失败";
        },
      },
    };
    installFetch([
      () => toolCall("read_doc", { path: document }, "read-1"),
      () => toolCall("edit_doc", { path: document, text: "status=ready\n" }, "edit-1"),
      () => toolCall("verify_doc", { path: document, expected: "status=ready\n" }, "verify-1"),
      () => finalText("文件已读取、编辑并验证完成。"),
    ]);
    const fileEvents: AgentEvent[] = [];
    const fileRun = await run(root, fileTools, "reliability-file", fileEvents);
    check("真实文件已被编辑", readFileSync(document, "utf8") === "status=ready\n");
    check("工具按读、改、验顺序执行", order.join(" → ") === "read → edit → verify", order.join(","));
    check("验证结果进入工具审计", fileRun.toolLogs.some((log) => log.tool === "verify_doc" && log.ok && log.summary.includes("验证通过")));
    check("交付在验证后结束", fileRun.text.includes("验证完成") && requests.length === 4, `requests=${requests.length}`);
    check("每一步都产生可观测工具事件", fileEvents.filter((event) => event.type === "tool-result").length === 3);

    console.log("\n▶ 源码修改后的交付验证门禁");
    const source = join(root, "gate.ts");
    const gateOrder: string[] = [];
    const gateTools = {
      write_file: {
        name: "write_file", description: "写源码", risk: "low" as const,
        schema: z.object({ path: z.string(), text: z.string() }),
        async execute({ path, text }: { path: string; text: string }) { gateOrder.push("write"); writeFileSync(path, text, "utf8"); return "写入成功"; },
      },
      run_test: {
        name: "run_test", description: "运行测试", risk: "low" as const,
        schema: z.object({}),
        async execute() { gateOrder.push("test"); return "1 passed, 0 failed"; },
      },
    };
    installFetch([
      () => toolCall("write_file", { path: source, text: "export const ready = true;\n" }, "gate-write"),
      () => finalText("代码已经完成。"),
      () => toolCall("run_test", {}, "gate-test"),
      () => finalText("代码已完成并通过测试。"),
    ]);
    const gateRun = await run(root, gateTools, "reliability-gate", []);
    check("未验证的首次交付被门禁拦住", requests.length === 4 && JSON.stringify(requests[2]).includes("verification-required"), `requests=${requests.length}`);
    check("验证完成后才正式交付", gateOrder.join(" → ") === "write → test" && gateRun.text.includes("通过测试"), gateOrder.join(","));

    console.log("\n▶ 失败后调整参数并恢复");
    let lookupExecutions = 0;
    const lookup = {
      lookup: {
        name: "lookup", description: "按路径查询", risk: "low" as const,
        schema: z.object({ path: z.string() }),
        async execute({ path }: { path: string }) {
          lookupExecutions++;
          return path === "good.txt" ? "找到目标内容" : "错误：文件不存在";
        },
      },
    };
    installFetch([
      () => toolCall("lookup", { path: "bad.txt" }, "bad-1"),
      () => toolCall("lookup", { path: "bad.txt" }, "bad-2"),
      () => toolCall("lookup", { path: "bad.txt" }, "bad-3"),
      () => toolCall("lookup", { path: "good.txt" }, "good-1"),
      () => finalText("已改用正确路径并完成查询。"),
    ]);
    const failureEvents: AgentEvent[] = [];
    const failureRun = await run(root, lookup, "reliability-recovery", failureEvents);
    const blocked = failureEvents.find((event) => event.type === "tool-result" && event.summary.includes("已阻止原样重试"));
    check("两次失败后第三次同参调用未实际执行", lookupExecutions === 3, `executions=${lookupExecutions}`);
    check("拦截结果明确要求调整策略", Boolean(blocked && blocked.summary.includes("改变路径/参数/权限或改用恢复方案")));
    check("调整参数后工具继续成功", failureRun.toolLogs.some((log) => log.args.path === "good.txt" && log.ok && log.summary.includes("找到目标")));
    check("恢复后可正常交付", failureRun.text.includes("正确路径") && requests.length === 5, `requests=${requests.length}`);
    const metrics = summarizeAgentMetrics(failureRun);
    check("评测指标统计失败、恢复建议与成本", metrics.failedToolCalls === 3 && metrics.recoveryGuidanceCount >= 2 && metrics.totalTokens === 0, JSON.stringify(metrics));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  globalThis.fetch = originalFetch;
  console.error("测试异常:", error);
  process.exit(1);
});
