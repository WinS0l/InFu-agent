/**
 * 定时任务（v3.0 批 11）——cron 调度 + 无人值守 Agent 执行
 *
 * 无人值守审批语义（定稿）：定时任务等价 CLI `-y`（autoApprove=true）——
 *  - low/medium 审批自动批准（config 档位 auto 语义）
 *  - **requireExplicit 场景（联网 / mcp_register / plugin_add 等安全红线）一律拒绝**，
 *    绝不自动放行（与 CLI -y 完全一致——无人值守 ≠ 放弃安全红线）
 * 任务注册表：~/.infu/schedules.json（{id, cron, prompt, root, enabled, lastRun, nextRun}）
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface ScheduleEntry {
  id: string;
  /** 5 字段 cron：分 时 日 月 周（* / 数字；周 0/7=周日） */
  cron: string;
  prompt: string;
  root: string;
  enabled: boolean;
  lastRun?: string;
  lastStatus?: string;
  nextRun?: string;
}

const SCHED_PATH = join(homedir(), ".infu", "schedules.json");

function loadSchedules(): ScheduleEntry[] {
  try {
    if (!existsSync(SCHED_PATH)) return [];
    return JSON.parse(readFileSync(SCHED_PATH, "utf-8")) as ScheduleEntry[];
  } catch {
    return [];
  }
}
function saveSchedules(list: ScheduleEntry[]): void {
  mkdirSync(join(homedir(), ".infu"), { recursive: true });
  writeFileSync(SCHED_PATH, JSON.stringify(list, null, 2));
}

/** cron 5 字段解析 → 当前时刻是否命中。支持 * / 数字（分 时 日 月 周；周 0=周日） */
export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  const match = (field: string, value: number, max: number, min0 = 0): boolean => {
    if (field === "*") return true;
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      if (!step) return false;
      return value % step === 0;
    }
    const nums = field.split(",").map((x) => parseInt(x, 10));
    return nums.some((n) => n === value);
  };
  const dowVal = date.getDay(); // 0=周日
  return (
    match(min, date.getMinutes(), 59) &&
    match(hour, date.getHours(), 23) &&
    match(dom, date.getDate(), 31, 1) &&
    match(mon, date.getMonth() + 1, 12, 1) &&
    // v3.1 审计修复：cron 周字段 `7` 也代表周日——`0 9 * * 7` 此前永不匹配（7===0 恒 false）
    match(dow, dowVal === 0 ? 7 : dowVal, 7)
  );
}

/** v3.1 审计修复：cron 语法校验（替代「24h 内有下次运行」——年度任务被误判无效） */
export function validCronSyntax(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return parts.every((field, i) => {
    if (field === "*") return true;
    const [lo, hi] = ranges[i];
    return field.split(",").every((tok) => {
      const stepM = /^\*\/\d+$/.exec(tok);
      if (stepM) return parseInt(stepM[1], 10) >= 1;
      if (!/^\d+$/.test(tok)) return false;
      const n = parseInt(tok, 10);
      return n >= lo && n <= hi;
    });
  });
}

/** 计算下次命中时刻（从 now 起 7 天内逐分钟扫描；找不到返回 null——仅用于显示） */
export function nextCronRun(cron: string, now = new Date()): Date | null {
  for (let i = 1; i <= 7 * 24 * 60; i++) {
    const t = new Date(now.getTime() + i * 60000);
    if (cronMatches(cron, t)) return t;
  }
  return null;
}

export function addSchedule(cron: string, prompt: string, root: string): { ok: boolean; message: string; entry?: ScheduleEntry } {
  const t = new Date();
  if (!validCronSyntax(cron)) {
    return { ok: false, message: `cron 表达式无效：${cron}（格式：分 时 日 月 周，如 "*/30 * * * *" 每 30 分钟、"0 9 * * 1-5" 工作日 9 点——当前仅支持 * / 逗号数字，不支持区间 -）` };
  }
  const entry: ScheduleEntry = {
    id: `s${randomUUID().slice(0, 8)}`,
    cron,
    prompt,
    root,
    enabled: true,
    nextRun: nextCronRun(cron, t)?.toISOString(),
  };
  const list = loadSchedules();
  list.push(entry);
  saveSchedules(list);
  return { ok: true, message: `已添加定时任务 ${entry.id}（cron "${cron}"，下次 ${entry.nextRun}）`, entry };
}

export function listSchedules(): ScheduleEntry[] {
  return loadSchedules();
}

export function removeSchedule(id: string): { ok: boolean; message: string } {
  const list = loadSchedules().filter((s) => s.id !== id);
  if (list.length === loadSchedules().length) return { ok: false, message: `定时任务不存在：${id}` };
  saveSchedules(list);
  return { ok: true, message: `已删除定时任务 ${id}` };
}

export function setScheduleEnabled(id: string, enabled: boolean): { ok: boolean; message: string } {
  const list = loadSchedules();
  const e = list.find((s) => s.id === id);
  if (!e) return { ok: false, message: `定时任务不存在：${id}` };
  e.enabled = enabled;
  saveSchedules(list);
  return { ok: true, message: `定时任务 ${id} 已${enabled ? "启用" : "暂停"}` };
}

/** 标记执行结果（调度器回调） */
export function markScheduleRun(id: string, status: string): void {
  const list = loadSchedules();
  const e = list.find((s) => s.id === id);
  if (!e) return;
  e.lastRun = new Date().toISOString();
  e.lastStatus = status;
  e.nextRun = nextCronRun(e.cron)?.toISOString();
  saveSchedules(list);
}

/**
 * 启动调度器（startServer 时调用）：每分钟 tick 一次，命中 cron 的任务
 * 以无人值守模式执行（autoApprove=true；requireExplicit 一律拒绝）。
 * 执行器由调用方注入（CLI/server 各自接 runAgent）——避免循环依赖。
 */
export interface ScheduleRunner {
  (entry: ScheduleEntry): Promise<{ ok: boolean; message: string }>;
}

let timer: NodeJS.Timeout | null = null;
// v3.1 审计修复：防重入——分钟级 cron（*/5）任务单次运行 >60s 时，下个 tick 会再次命中
// 并发重复执行（lastRun 只在完成后写入）。运行中集合：tick 跳过、结束清除（含失败）。
const runningIds = new Set<string>();
export function startScheduler(run: ScheduleRunner): void {
  if (timer) return;
  const tick = () => {
    const now = new Date();
    for (const entry of loadSchedules()) {
      if (!entry.enabled) continue;
      if (runningIds.has(entry.id)) continue; // 上轮还在跑，跳过本次
      if (!cronMatches(entry.cron, now)) continue;
      // 同一分钟防重复执行（lastRun 分钟内已跑过则跳过）
      if (entry.lastRun && new Date(entry.lastRun).getTime() > now.getTime() - 60000) continue;
      runningIds.add(entry.id);
      run(entry)
        .then((r) => markScheduleRun(entry.id, r.ok ? "ok" : "error"))
        .catch(() => markScheduleRun(entry.id, "error"))
        .finally(() => runningIds.delete(entry.id));
    }
  };
  tick();
  timer = setInterval(tick, 60000);
  timer.unref?.();
}
export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  runningIds.clear();
}
