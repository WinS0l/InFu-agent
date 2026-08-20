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
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { cleanupOldBackups } from "./cleanup.js";
import { resolveDataDir } from "./data-dir.js";

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

function schedPath(): string {
  return join(resolveDataDir(), "schedules.json");
}
function withSchedulesLock<T>(fn: () => T): T {
  mkdirSync(resolveDataDir(), { recursive: true });
  const file = schedPath();
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch { /* retry */ }
      if (Date.now() >= deadline) throw new Error("定时任务注册表正被另一个 InFu 进程更新，请稍后重试");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  const lease = setInterval(() => { try { utimesSync(lock, new Date(), new Date()); } catch { /* release raced */ } }, 5_000);
  try { return fn(); } finally {
    clearInterval(lease);
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function isValidEntry(x: unknown): x is ScheduleEntry {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.cron === "string" &&
    typeof o.prompt === "string" &&
    typeof o.root === "string" &&
    typeof o.enabled === "boolean"
  );
}

/**
 * 读取定时任务注册表。
 * v3.4 审计修复：原实现 JSON.parse 直接当数组用——损坏/手改/旧版本文件静默返回 []，
 * 用户所有定时任务「消失」且无任何提示；逐条字段校验，损坏条目丢弃并备份原文件。
 */
function loadSchedules(): ScheduleEntry[] {
  const SCHED_PATH = schedPath();
  try {
    if (!existsSync(SCHED_PATH)) return [];
    const raw = JSON.parse(readFileSync(SCHED_PATH, "utf-8"));
    if (!Array.isArray(raw)) throw new Error("注册表不是数组");
    return raw.filter(isValidEntry);
  } catch (e) {
    try {
      const backup = `${SCHED_PATH}.broken-${Date.now()}`;
      if (existsSync(SCHED_PATH)) copyFileSync(SCHED_PATH, backup);
      console.error(`[infu] 定时任务注册表损坏（已备份到 ${backup}）：${(e as Error).message}`);
    } catch {
      /* 备份失败忽略 */
    }
    // v3.5 数据生命周期：顺带清理超期损坏备份（.broken-* 永久累积）
    try { cleanupOldBackups(SCHED_PATH); } catch { /* ignore */ }
    return [];
  }
}
function saveSchedules(list: ScheduleEntry[]): void {
  const SCHED_PATH = schedPath();
  mkdirSync(join(resolveDataDir()), { recursive: true });
  // v3.5：原子写（tmp + rename）——防多进程并发写截断（与 projects/config 同款修复）
  const tmp = `${SCHED_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, SCHED_PATH);
}

/** cron 5 字段解析 → 当前时刻是否命中。支持 * / 数字（分 时 日 月 周；周 0=周日） */
export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  // v3.4 审计修复：删除 min0 死参数（从未被使用——DOM/月 的 1 起始在解析侧无意义，
  // 值比较自然成立；参数存在即误导）
  const match = (field: string, value: number): boolean => {
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
  const domOk = match(dom, date.getDate());
  // v3.1 审计修复：cron 周字段 `7` 也代表周日；v3.5 补：`0`（标准周日写法）此前被
  // 映射成 7 后恒不匹配——两种写法都接受
  const dowOk = match(dow, dowVal) || (dowVal === 0 && match(dow, 7));
  // v3.7 审计修复：标准 cron（Vixie）语义——日字段与周字段**均受限**时互为 OR
  // （`0 9 1 * 1` = 每月 1 号**或**周一）；仅一方受限时则双方都须匹配。
  // 原实现恒 AND：`1 号且周一` 的月份大多不执行，任务静默缺席。
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
  return (
    match(min, date.getMinutes()) &&
    match(hour, date.getHours()) &&
    dayOk &&
    match(mon, date.getMonth() + 1)
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
      const stepM = /^\*\/(\d+)$/.exec(tok);
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
    return { ok: false, message: `cron 表达式无效：${cron}（格式：分 时 日 月 周，如 "*/30 * * * *" 每 30 分钟、"0 9 * * 1,2,3,4,5" 工作日 9 点——当前仅支持 * / 逗号数字，不支持区间 -）` };
  }
  const entry: ScheduleEntry = {
    id: `s${randomUUID().slice(0, 8)}`,
    cron,
    prompt,
    root,
    enabled: true,
    nextRun: nextCronRun(cron, t)?.toISOString(),
  };
  withSchedulesLock(() => {
    const list = loadSchedules();
    list.push(entry);
    saveSchedules(list);
  });
  return { ok: true, message: `已添加定时任务 ${entry.id}（cron "${cron}"，下次 ${entry.nextRun}）`, entry };
}

export function listSchedules(): ScheduleEntry[] {
  return loadSchedules();
}

export function removeSchedule(id: string): { ok: boolean; message: string } {
  return withSchedulesLock(() => {
    const current = loadSchedules();
    const list = current.filter((s) => s.id !== id);
    if (list.length === current.length) return { ok: false, message: `定时任务不存在：${id}` };
    saveSchedules(list);
    return { ok: true, message: `已删除定时任务 ${id}` };
  });
}

export function setScheduleEnabled(id: string, enabled: boolean): { ok: boolean; message: string } {
  return withSchedulesLock(() => {
    const list = loadSchedules();
    const e = list.find((s) => s.id === id);
    if (!e) return { ok: false, message: `定时任务不存在：${id}` };
    e.enabled = enabled;
    saveSchedules(list);
    return { ok: true, message: `定时任务 ${id} 已${enabled ? "启用" : "暂停"}` };
  });
}

/** 标记执行结果（调度器回调） */
export function markScheduleRun(id: string, status: string): void {
  withSchedulesLock(() => {
    const list = loadSchedules();
    const e = list.find((s) => s.id === id);
    if (!e) return;
    e.lastRun = new Date().toISOString();
    e.lastStatus = status;
    e.nextRun = nextCronRun(e.cron)?.toISOString();
    saveSchedules(list);
  });
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
      // v3.7 审计修复：调度即预留 lastRun——原实现只在**完成后**写入，服务重启时
      // runningIds 内存丢失且 lastRun 未写 → 同分钟 cron 再次命中 → 同一任务执行两轮。
      // 预留后本分钟内不再命中（含重启后）；完成回调再覆写为真实结果。
      markScheduleRun(entry.id, "started");
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
