/**
 * v3.7 定时任务回归测试（审计修复）
 * 覆盖：
 *  1. cron dom/dow 标准（Vixie）语义——两字段均受限时互为 OR（原实现恒 AND，
 *     `0 9 1 * 1` = 每月 1 号**或**周一，此前被实现成「1 号且周一」大部分月份缺席）
 *  2. 调度即预留 lastRun（防服务重启后 runningIds 丢失 → 同分钟 cron 重复执行）
 * 运行：npx tsx packages/agent/tests/schedule.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cronMatches,
  validCronSyntax,
  addSchedule,
  listSchedules,
  startScheduler,
  stopScheduler,
} from "../src/schedule.js";
import { setDataDirForTest } from "../src/data-dir.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const tmpData = mkdtempSync(join(tmpdir(), "infu-schedule-"));
setDataDirForTest(tmpData);

console.log("\n=== 定时任务回归（schedule）自测 ===\n");

// ── 1. cron dom/dow OR 语义（Vixie 标准）──
// 2026-08-01 = 周六(dow=6)、2026-08-03 = 周一(dow=1)、2026-08-10 = 周一、2026-08-15 = 周六
console.log("▶ cron 日/周字段 OR 语义");
{
  const aug1 = new Date("2026-08-01T09:00:00");   // 1 号，周六
  const aug3 = new Date("2026-08-03T09:00:00");   // 3 号，周一（非 1 号）
  const aug10 = new Date("2026-08-10T09:00:00");  // 10 号，周一
  const aug15 = new Date("2026-08-15T09:00:00");  // 15 号，周六

  // `0 9 1 * 1`：每月 1 号或周一（两字段均受限 → OR）
  check("1 号（周六）命中", cronMatches("0 9 1 * 1", aug1));
  check("周一非 1 号（8/3）命中", cronMatches("0 9 1 * 1", aug3), "原 AND 实现此处缺席");
  check("周一非 1 号（8/10）命中", cronMatches("0 9 1 * 1", aug10));
  check("非 1 号非周一（8/15）不命中", !cronMatches("0 9 1 * 1", aug15));
  check("分钟不匹配不命中", !cronMatches("0 9 1 * 1", new Date("2026-08-03T10:00:00")));

  // 仅一方受限 → 双方都须匹配（行为不变）
  check("`* * 1 * *` 非 1 号不命中", !cronMatches("* * 1 * *", aug3));
  check("`* * * * 1` 周一命中", cronMatches("* * * * 1", aug3));
  check("`* * * * 1` 周六不命中", !cronMatches("* * * * 1", aug15));
  check("`* * 1 * *` 1 号命中", cronMatches("* * 1 * *", aug1));

  // 周 0/7 双写法（回归确认）
  check("dow=0 周日命中", cronMatches("0 9 * * 0", new Date("2026-08-16T09:00:00"))); // 8/16 周日
  check("dow=7 周日命中", cronMatches("0 9 * * 7", new Date("2026-08-16T09:00:00")));
}

// ── 2. 语法校验与示例修正 ──
console.log("\n▶ cron 语法校验");
{
  check("合法表达式通过", validCronSyntax("*/30 * * * *"));
  check("区间 - 仍拒绝（文档示例同步修正）", !validCronSyntax("0 9 * * 1-5"));
  check("非法数字拒绝", !validCronSyntax("60 * * * *"));
  check("字段数不足拒绝", !validCronSyntax("0 9 * *"));
}

// ── 3. 调度即预留 lastRun（重启防重）──
console.log("\n▶ 调度预留 lastRun（重启防重）");
{
  const r = addSchedule("* * * * *", "每分钟任务", tmpData);
  check("添加成功", r.ok === true, r.message);
  const id = r.entry!.id;

  let runCount = 0;
  let release: (v: unknown) => void = () => {};
  const gate = new Promise((res) => { release = res; });
  // 第一次「启动」：runner 挂起（模拟长任务运行中）
  startScheduler(async () => { runCount++; await gate; return { ok: true, message: "" }; });

  const afterStart = listSchedules().find((s) => s.id === id);
  check("调度即写 lastRun（预留）", afterStart?.lastRun !== undefined, JSON.stringify(afterStart?.lastRun));
  check("预留状态为 started", afterStart?.lastStatus === "started", String(afterStart?.lastStatus));
  check("预留时间在当前分钟内", afterStart!.lastRun! > new Date(Date.now() - 60000).toISOString());

  // 模拟服务重启：runningIds 丢失
  stopScheduler();

  const runsBeforeRestart = runCount;
  // 重启后同分钟内再次 tick → 应跳过（lastRun 预留生效）
  startScheduler(async () => { runCount++; return { ok: true, message: "" }; });
  check("重启后同分钟不重复执行", runCount === runsBeforeRestart, `runCount=${runCount} 期望=${runsBeforeRestart}`);
  stopScheduler();

  // 放行挂起的第一次任务，完成回调覆写状态
  release(null);
  await new Promise((r) => setTimeout(r, 100));
  const finished = listSchedules().find((s) => s.id === id);
  check("完成后状态覆写为 ok", finished?.lastStatus === "ok", String(finished?.lastStatus));
}

// 清理
stopScheduler();
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);