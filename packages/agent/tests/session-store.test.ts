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
// v2.14 批 10：rewind 默认落 marker 事件（AI 感知回滚位置）→ 截断后追加一条 rewind 标记
check("截断到检查点（保留 0..1）", after.length === 3 && after[1].event.type === "step-start" && after[2].event.type === "rewind", JSON.stringify(after.map((e) => e.event.type)));
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

// 6. Job 审计镜像（事件流仍为事实来源，审计表用于查询）
console.log("\n▶ Job 审计");
const jobId = store.createSession({ title: "审计", root: "E:\\audit" });
store.appendEvent(jobId, { type: "job-start", id: "job-1", command: "npm test" });
check("Job 启动写入审计", store.listJobAudits(jobId)[0]?.status === "running");
store.appendEvent(jobId, { type: "job-done", id: "job-1", code: 0, ok: true });
check("Job 完成更新审计", store.listJobAudits(jobId)[0]?.status === "completed" && store.listJobAudits(jobId)[0]?.outputSummary === "exit=0");
store.appendEvent(jobId, { type: "phase-start", phase: "planner", label: "规划" });
check("任务快照包含阶段和可恢复性", store.getTaskSnapshot(jobId)?.phase === "planner" && store.getTaskSnapshot(jobId)?.resumability === "safe");
store.deleteSession(jobId);

// 7. 删除
console.log("\n▶ 删除");
store.deleteSession(id2);
check("删除后不存在", store.getSession(id2) === null);
check("列表只剩一个", store.listSessions().length === 1);
store.deleteSession(id);
check("全部删除", store.listSessions().length === 0);

// 8. v2.6.1 会话管理（重命名/顶置/归档）
console.log("\n▶ 会话管理（重命名/顶置/归档）");
const m1 = store.createSession({ title: "原始标题", root: "E:\\proj" });
check("新会话默认未顶置未归档", store.getSession(m1)?.pinned === false && store.getSession(m1)?.archived === false);
check("重命名成功", store.renameSession(m1, "新标题") && store.getSession(m1)?.title === "新标题");
check("重命名空标题拒绝", store.renameSession(m1, "   ") === false);
check("重命名不存在会话拒绝", store.renameSession("nope", "x") === false);
check("顶置成功", store.setPinned(m1, true) && store.getSession(m1)?.pinned === true);
check("取消顶置", store.setPinned(m1, false) && store.getSession(m1)?.pinned === false);
check("归档成功", store.setArchived(m1, true) && store.getSession(m1)?.archived === true);
// 归档过滤：默认列表不含归档，archived=true 列表含
const listAll = store.listSessions(50, undefined);
const listActive = store.listSessions(50, false);
const listArchived = store.listSessions(50, true);
check("默认列表不含归档会话", !listActive.some((s) => s.id === m1) && listActive.length === 0);
check("归档列表含归档会话", listArchived.some((s) => s.id === m1));
check("全量列表含归档会话", listAll.some((s) => s.id === m1));
check("恢复归档", store.setArchived(m1, false) && store.getSession(m1)?.archived === false && store.listSessions().some((s) => s.id === m1));
store.deleteSession(m1);

// 9. v2.6.1 幂等迁移（已有库打开不报错 + 列存在）
console.log("\n▶ 幂等迁移");
const s2c = new SessionStore(join(dir, "test.db")); // 重复打开：ALTER 幂等
const m2 = s2c.createSession({ title: "迁移后", root: "E:\\proj" });
check("重复打开后仍可创建/读取（pinned/archived 列就位）", s2c.getSession(m2)?.pinned === false);
s2c.deleteSession(m2);
s2c.close();

// 清理
store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
