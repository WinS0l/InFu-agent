/**
 * 后台任务（job）自测（v2.11：run_command background / job_list / job_output / job_kill / 上限 / 深度清理）
 * 运行：npx tsx packages/agent/tests/jobs.test.ts
 *
 * 覆盖：
 *  - startBackgroundJob：立即返回 / job-start 事件 / 完成 → status done + job-done 事件 / 输出收集
 *  - job_output：完整输出 / tail 只看尾部
 *  - job_list：按启动时间排序列出
 *  - job_kill：终止运行中任务（进程树）/ 对已完成任务提示
 *  - 每会话活跃上限 MAX_JOBS_PER_SESSION
 *  - 目录不存在报错
 *  - abortJobsByDepth：按深度清理运行中任务（不同深度不受影响）
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@infu/shared";
import {
  startBackgroundJob, listJobs, getJob, getJobOutput, killJob, abortJobsByDepth,
  MAX_JOBS_PER_SESSION,
} from "../src/tools/jobs.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

/** 轮询等待条件成立（带超时） */
async function waitUntil(cond: () => boolean, timeoutMs = 10000, interval = 80): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return cond();
}

const root = mkdtempSync(join(tmpdir(), "infu-jobs-"));
const SID = "sess-jobs-test";
let events: AgentEvent[] = [];

(async () => {
  console.log("══ 后台任务（v2.11 job）══");

  // ── 1. 启动 + 完成 + 输出 ──
  events = [];
  const h1 = startBackgroundJob(`node -e "console.log('hello-job'); console.error('err-line')"`, root, SID, 0, (e) => events.push(e));
  check("启动立即返回句柄（status=running）", h1.status === "running", h1.status);
  check("job-start 事件已发", events.some((e) => e.type === "job-start" && e.id === h1.id));
  check("注册表可查到", getJob(SID, h1.id) === h1);
  const done1 = await waitUntil(() => h1.status !== "running");
  check("任务自动完成", done1 && h1.status === "done", h1.status);
  check("job-done 事件 ok=true", events.some((e) => e.type === "job-done" && e.id === h1.id && e.ok === true));
  const out1 = getJobOutput(SID, h1.id);
  check("输出含 stdout 与 stderr", out1.includes("hello-job") && out1.includes("err-line"), out1.slice(0, 100));
  check("job_output tail 只看尾部", getJobOutput(SID, h1.id, 5).includes("line") && !getJobOutput(SID, h1.id, 5).includes("hello-job"));
  check("job_list 列出完成项", listJobs(SID).some((j) => j.id === h1.id && j.status === "done"));

  // ── 2. 失败退出码 ──
  const h2 = startBackgroundJob(`node -e "process.exit(3)"`, root, SID, 0, () => {});
  await waitUntil(() => h2.status !== "running");
  check("非零退出 → status=failed + code=3", h2.status === "failed" && h2.code === 3, `${h2.status} code=${h2.code}`);

  // ── 3. job_kill 终止运行中任务 ──
  const h3 = startBackgroundJob(`node -e "setInterval(()=>{},1000)"`, root, SID, 0, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const k = killJob(SID, h3.id);
  check("job_kill 返回已请求终止", k.includes("已请求终止"), k);
  const killed = await waitUntil(() => h3.status !== "running");
  check("任务被终止（status=killed）", killed && h3.status === "killed", h3.status);
  check("job_kill 对已完成任务提示无需终止", killJob(SID, h1.id).includes("无需终止"));
  check("job_kill 对不存在 id 报错", killJob(SID, "nope").includes("未找到"));
  check("job_output 对不存在 id 报错", getJobOutput(SID, "nope").includes("未找到"));

  // ── 4. 每会话活跃上限 ──
  const started: string[] = [];
  for (let i = 0; i < MAX_JOBS_PER_SESSION; i++) {
    try {
      const h = startBackgroundJob(`node -e "setInterval(()=>{},1000)"`, root, SID, 0, () => {});
      started.push(h.id);
    } catch {
      break;
    }
  }
  check(`允许并发 ${MAX_JOBS_PER_SESSION} 个`, started.length === MAX_JOBS_PER_SESSION, `${started.length}/${MAX_JOBS_PER_SESSION}`);
  try {
    startBackgroundJob(`node -e "setInterval(()=>{},1000)"`, root, SID, 0, () => {});
    check("超过上限拒绝启动", false, "未抛错");
  } catch (e) {
    check("超过上限拒绝启动", /上限/.test((e as Error).message), (e as Error).message.slice(0, 60));
  }
  // 清理这批长任务（轮询等进程树真正退出，避免占用活跃名额）
  for (const id of started) killJob(SID, id);
  await waitUntil(() => listJobs(SID).every((j) => j.status !== "running"), 10000);

  // ── 5. 深度清理（父任务结束时按深度中止）──
  const h5 = startBackgroundJob(`node -e "setInterval(()=>{},1000)"`, root, SID, 0, () => {});
  const h6 = startBackgroundJob(`node -e "setInterval(()=>{},1000)"`, root, SID, 1, () => {});
  await new Promise((r) => setTimeout(r, 300));
  abortJobsByDepth(SID, 0);
  await waitUntil(() => h5.status !== "running");
  check("深度 0 的任务被父级结束清理", h5.status === "killed", h5.status);
  check("深度 1 的任务不受清理影响", h6.status === "running", h6.status);
  killJob(SID, h6.id);
  await waitUntil(() => h6.status !== "running", 10000);
  await new Promise((r) => setTimeout(r, 300));

  // ── 6. 目录不存在 ──
  try {
    startBackgroundJob("echo hi", join(root, "no-such-dir"), SID, 0, () => {});
    check("目录不存在报错", false, "未抛错");
  } catch (e) {
    check("目录不存在报错", /目录不存在/.test((e as Error).message));
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 被杀的 cmd 进程树可能仍在释放 cwd——temp 目录由系统清理，忽略
  }
  console.log(`\n后台任务：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
