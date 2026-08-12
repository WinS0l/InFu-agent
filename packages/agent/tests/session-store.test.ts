/**
 * 会话存储自测（v2.1 持久化层：SQLite 会话 + 事件流 + Rewind + 历史回顾）
 * 运行：npx tsx packages/agent/tests/session-store.test.ts
 */
import { SessionStore } from "../src/db/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const dir = mkdtempSync(join(tmpdir(), "infu-db-test-"));
const store = new SessionStore(join(dir, "test.db"));

console.log("\n=== 会话存储自测 ===\n");

// 1. 创建会话
console.log("▶ 创建/列表/详情");
const id = store.createSession({ title: "修复测试失败", root: "E:\\proj", modelId: "deepseek-v4-flash", mode: "orchestrate" });
const list = store.listSessions();
check("列表含新会话", list.length === 1, JSON.stringify(list));
check("列表元数据完整", list[0].title === "修复测试失败" && list[0].root === "E:\\proj" && list[0].modelId === "deepseek-v4-flash" && list[0].status === "running");
const meta = store.getSession(id);
check("详情读取", meta !== null && meta.id === id && meta.eventCount === 0);

// 2. 事件追加（有序 seq）
console.log("\n▶ 事件流");
const ev1: AgentEvent = { type: "user-message", text: "帮我修测试" };
const ev2: AgentEvent = { type: "step-start", step: 1 };
const ev3: AgentEvent = { type: "tool-start", tool: "read_file", args: { path: "a.ts" }, risk: "low", callId: "call-1" };
const ev4: AgentEvent = { type: "tool-result", tool: "read_file", ok: true, summary: "完整内容".repeat(100), callId: "call-1" };
const s1 = store.appendEvent(id, ev1);
const s2 = store.appendEvent(id, ev2);
const s3 = store.appendEvent(id, ev3);
const s4 = store.appendEvent(id, ev4);
check("seq 从 0 递增", s1 === 0 && s2 === 1 && s3 === 2 && s4 === 3, `${s1},${s2},${s3},${s4}`);
const events = store.getEvents(id);
check("事件按序读出且 JSON 完整", events.length === 4 && events[0].event.type === "user-message" && events[3].event.type === "tool-result");
check("summary 存完整输出（不截断）", (events[3].event as any).summary.length > 200);
check("callId 保留", (events[2].event as any).callId === "call-1");
check("统计更新", store.getSession(id)?.eventCount === 4 && store.getSession(id)?.toolCount === 1 && store.getSession(id)?.promptCount === 1);

// 3. 状态更新
console.log("\n▶ 状态");
store.updateStatus(id, "done");
check("状态 done", store.getSession(id)?.status === "done");

// 4. Rewind（回滚到 seq=2 检查点：删掉 tool-start 之后的事件）
console.log("\n▶ Rewind");
store.updateStatus(id, "done");
const ok = store.rewind(id, s3);
check("rewind 成功", ok);
const after = store.getEvents(id);
check("截断到检查点（保留 0..1）", after.length === 2 && after[after.length - 1].event.type === "step-start", JSON.stringify(after.map((e) => e.event.type)));
check("rewind 后状态重置为 stopped", store.getSession(id)?.status === "stopped");
check("rewind 未知会话返回 false", store.rewind("nope", 0) === false);

// 5. 历史回顾（继续会话注入）
console.log("\n▶ 历史回顾");
const id2 = store.createSession({ title: "回顾", root: "E:\\proj2" });
store.appendEvent(id2, { type: "user-message", text: "任务一" });
store.appendEvent(id2, { type: "plan", id: "p1", content: "计划A" });
store.appendEvent(id2, { type: "review", content: "审查A" });
store.appendEvent(id2, { type: "report", content: "报告A" });
store.appendEvent(id2, { type: "user-message", text: "继续做" });
store.appendEvent(id2, { type: "report", content: "报告B" });
const sum = store.summarizeSession(id2);
check("prompts 序列完整", sum.prompts.length === 2 && sum.prompts[1] === "继续做");
check("产出取最后一次", sum.lastPlan === "计划A" && sum.lastReview === "审查A" && sum.lastReport === "报告B");

// 6. 删除
console.log("\n▶ 删除");
store.deleteSession(id2);
check("删除后不存在", store.getSession(id2) === null);
check("列表只剩一个", store.listSessions().length === 1);
store.deleteSession(id);
check("全部删除", store.listSessions().length === 0);

// 清理
store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
