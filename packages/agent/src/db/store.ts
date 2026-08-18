/**
 * InFu 会话存储 — SQLite（node:sqlite，Node 22.5+ 内置，零依赖）
 *
 * v2.1 持久化地基：会话 + 全量事件流（记忆/统计/审计都依赖这里）。
 *   - sessions 表：会话元数据（标题/根目录/模型/模式/状态/时间）
 *   - events 表：AgentEvent 全量 JSON（seq 自增，顺序即时间线）
 *
 * 检查点语义：user-message（用户发起一轮）与 step-start（模型每轮思考开始）
 * 是天然检查点；Rewind(seq) = 删除 seq >= 目标的所有事件（截断回滚）。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, SessionMeta, SessionStatus, StoredEvent } from "@infu/shared";
import { resolveDataDir } from "../data-dir.js";

function defaultDbPath(): string {
  return join(resolveDataDir(), "infu.db");
}

/**
 * 历史回顾（继续会话时注入新 prompt）：用户消息序列 + 最后一次 plan/review/report 产出。
 * CLI / 服务端共用。
 */
export interface SessionSummary {
  prompts: string[];
  lastPlan?: string;
  lastReview?: string;
  lastReport?: string;
}

/** v2.7 使用统计（从会话事件流聚合；token 为字符数/4 估算）
 *  v3.0 UI 审查：model-call 事件（每次模型调用真实四桶）聚合按天×模型细分与模型真实用量 */
export interface UsageStats {
  rangeDays: number;
  tokens: number;
  sessions: number;
  messages: number;
  activeDays: number;
  streak: number;
  topModel: { model: string; share: number } | null;
  modelUsage: Array<{ model: string; tokens: number; share: number }>;
  dailyTrend: Array<{
    date: string;
    tokens: number;
    prompt: number;
    completion: number;
    cacheHit: number;
    cacheMiss: number;
    estimated: boolean;
    /** v3.0 UI 审查：该日各模型真实 token（model-call 聚合；旧会话无数据时为空数组） */
    byModel: Array<{ model: string; tokens: number }>;
  }>;
}

export function buildContinuationPrompt(summary: SessionSummary, newPrompt: string): string {
  const parts: string[] = [newPrompt, "", "【历史会话回顾】（你在继续此前的任务，请结合进展继续）", ""];
  if (summary.prompts.length) {
    parts.push("之前你已处理过以下轮次的任务：");
    summary.prompts.forEach((p, i) => parts.push(`${i + 1}. ${p.slice(0, 200)}`));
    parts.push("");
  }
  const prev: string[] = [];
  if (summary.lastPlan) prev.push(`【执行计划】\n${summary.lastPlan}`);
  if (summary.lastReview) prev.push(`【审查意见】\n${summary.lastReview}`);
  if (summary.lastReport) prev.push(`【交付报告】\n${summary.lastReport}`);
  if (prev.length) {
    parts.push("此前产出（供参考，请勿重复输出）：");
    parts.push(...prev);
    parts.push("");
  }
  parts.push("请结合以上进展继续完成任务（仓库当前状态以工具实际读取为准，不要臆测）。");
  return parts.join("\n");
}

export class SessionStore {
  private db: DatabaseSync;
  /** v4.0：事务嵌套深度——rewind 内部调用 appendEvent（appendEvent 自身包事务），
   *  SQLite 不支持嵌套 BEGIN（"cannot start a transaction within a transaction"）；
   *  深度 > 0 时 appendEvent 只参与外层事务，不自行 BEGIN/COMMIT */
  private txnDepth = 0;

  constructor(dbPath: string = defaultDbPath()) {
    mkdirSync(join(resolveDataDir()), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // v3.5 审计修复：WAL + busy_timeout——多进程（server/CLI/定时任务）并发写
    // 此前 SQLITE_BUSY 直接抛错（读锁期间的写/写锁期间的读写）；WAL 让读写并行，
    // busy_timeout 让瞬时锁等待而非报错（projects.json 已改原子写，这里同思路）
    try {
      this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`);
    } catch { /* 只读库（测试注入）忽略 */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        root TEXT NOT NULL,
        model_id TEXT,
        mode TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
    `);
    // v2.6.1 幂等迁移：sessions 表加 pinned/archived 列（顶置/归档）
    const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all().map((r: any) => r.name);
    if (!cols.includes("pinned")) this.db.exec(`ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes("archived")) this.db.exec(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  }

  close() {
    this.db.close();
  }

  /**
   * v5.0（C4）：一键备份——VACUUM INTO 把当前库的一致性快照写入目标路径
   * （WAL 下直接复制文件会丢未 checkpoint 数据；VACUUM INTO 是 SQLite 官方备份语义）
   */
  backupTo(targetPath: string): void {
    this.db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  }

  /**
   * v5.0（A4）：归档会话事件压缩（显式选项，默认关）——保留最近 keep 条事件，
   * 前置一条摘要事件（取自最后一次 done/文本，截断 2000 字）；rebuild 兼容
   * （摘要成为最早的 assistant 文本）。返回压缩前后事件数；事件不足不压缩。
   */
  compressSessionEvents(id: string, keep = 200): { before: number; after: number } | null {
    const events = this.getEvents(id);
    if (events.length <= keep + 50) return null;
    // 摘要源：最后一次 done 文本 > 最后一次 text > 最后一条 user-message
    let summary = "";
    for (let i = events.length - 1; i >= 0 && !summary; i--) {
      const ev = events[i].event as AgentEvent;
      if (ev.type === "done" && ev.text?.trim()) summary = ev.text.trim();
      else if (ev.type === "text" && (ev as { text?: string }).text?.trim()) summary = (ev as { text?: string }).text!.trim();
      else if (ev.type === "user-message" && (ev as { text?: string }).text?.trim()) summary = (ev as { text?: string }).text!.trim();
    }
    const kept = events.slice(-keep);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM events WHERE session_id = ?`).run(id);
      const now = Date.now();
      const summaryEvent: AgentEvent = {
        type: "text",
        text: `【历史已压缩（v5.0 归档压缩）】此会话早于最近 ${keep} 条事件的历史已折叠为摘要：
${summary.slice(0, 2000)}`,
      };
      this.db
        .prepare(`INSERT INTO events (session_id, seq, ts, event_json) VALUES (?, 0, ?, ?)`)
        .run(id, now, JSON.stringify(summaryEvent));
      for (let i = 0; i < kept.length; i++) {
        this.db
          .prepare(`INSERT INTO events (session_id, seq, ts, event_json) VALUES (?, ?, ?, ?)`)
          .run(id, i + 1, kept[i].ts, JSON.stringify(kept[i].event));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 忽略 */ }
      throw e;
    }
    return { before: events.length, after: keep + 1 };
  }

  /** 新建会话（status=running，事件流从 0 开始） */
  createSession(opts: { title: string; root: string; modelId?: string; mode?: string }): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, root, model_id, mode, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`
      )
      .run(id, opts.title.slice(0, 200), opts.root, opts.modelId ?? null, opts.mode ?? null, now, now);
    return id;
  }

  /**
   * 会话列表（按最近更新倒序，含统计）。
   * v2.6.1：archived=false（默认）只返回未归档；archived=true 返回归档回收站；undefined = 全部。
   */
  listSessions(limit = 50, archived?: boolean): SessionMeta[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count,
          (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id
             AND json_extract(e.event_json, '$.type') = 'tool-start') AS tool_count,
          (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id
             AND json_extract(e.event_json, '$.type') = 'user-message') AS prompt_count
         FROM sessions s
         ${archived === undefined ? "" : archived ? "WHERE s.archived = 1" : "WHERE s.archived = 0"}
         ORDER BY s.updated_at DESC
         LIMIT ?`
      )
      .all(limit);
    return rows.map(rowToMeta);
  }

  /** 单个会话 */
  getSession(id: string): SessionMeta | null {
    const row = this.db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count,
          (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id
             AND json_extract(e.event_json, '$.type') = 'tool-start') AS tool_count,
          (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id
             AND json_extract(e.event_json, '$.type') = 'user-message') AS prompt_count
         FROM sessions s WHERE s.id = ?`
      )
      .get(id);
    return row ? rowToMeta(row) : null;
  }

  /**
   * 追加事件（返回 seq），同步更新 updated_at。
   * v3.6 审计修复：原实现「SELECT MAX(seq)+1」与 INSERT 分离——多进程（server + CLI
   * 同会话）在 WAL 下并发时两个进程可算出相同 next → PRIMARY KEY(session_id, seq)
   * 冲突抛 SQLITE_CONSTRAINT；改 INSERT ... SELECT + RETURNING **单语句原子分配 seq**
   * （SQLite 语句级原子性，并发安全），并直接返回实际插入的 seq。
   */
  appendEvent(sessionId: string, event: AgentEvent): number {
    const now = Date.now();
    // v4.0 审计修复（L8）：INSERT 与 UPDATE sessions 包事务——原实现 UPDATE 失败
    // （罕见）会留下「事件已入但 updated_at 停滞」的中间态；外层已有事务（rewind）时
    // 只参与不嵌套（txnDepth 见上）
    const nested = this.txnDepth > 0;
    if (!nested) this.db.exec("BEGIN");
    let seq = 0;
    try {
      const row = this.db
        .prepare(
          `INSERT INTO events (session_id, seq, ts, event_json)
           SELECT ?, COALESCE(MAX(seq), -1) + 1, ?, ? FROM events WHERE session_id = ?
           RETURNING seq`
        )
        .get(sessionId, now, JSON.stringify(event), sessionId) as { seq: number } | undefined;
      this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(now, sessionId);
      if (!nested) this.db.exec("COMMIT");
      seq = row ? Number(row.seq) : 0;
    } catch (e) {
      if (!nested) {
        try { this.db.exec("ROLLBACK"); } catch { /* 忽略 */ }
      }
      throw e;
    }
    return seq;
  }

  /** 会话全量事件（seq 升序） */
  getEvents(sessionId: string): StoredEvent[] {
    const rows = this.db
      .prepare(`SELECT seq, ts, event_json FROM events WHERE session_id = ? ORDER BY seq`)
      .all(sessionId);
    return rows.map((r) => ({
      seq: Number(r.seq),
      ts: Number(r.ts),
      event: JSON.parse(String(r.event_json)) as AgentEvent,
    }));
  }

  deleteSession(id: string) {
    this.db.prepare(`DELETE FROM events WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  /** 更新会话状态（done/error/stopped/running） */
  updateStatus(id: string, status: SessionStatus) {
    // v2.13：用户停止（stopped）为终态，不被后续 done/error 覆盖（abort 走"软返回"路径，
    // orchestrator 正常返回后 server 会写 done——停止语义必须保留）
    if (status === "done" || status === "error") {
      const cur = this.getSession(id);
      if (cur?.status === "stopped") return;
    }
    this.db.prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
  }

  /** v3.1：服务启动时清理残留 running（上次进程退出时任务已死；防续跑被误拦） */
  resetStaleRunning() {
    this.db.prepare(`UPDATE sessions SET status = 'stopped', updated_at = ? WHERE status = 'running'`).run(Date.now());
  }

  // ── v2.6.1 会话管理（重命名/顶置/归档）──

  /** 重命名会话（返回是否成功；会话不存在返回 false） */
  renameSession(id: string, title: string): boolean {
    const t = title.trim().slice(0, 200);
    if (!t) return false;
    const r = this.db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(t, Date.now(), id);
    return r.changes > 0;
  }

  /** 顶置/取消顶置（置顶区显示） */
  setPinned(id: string, pinned: boolean): boolean {
    const r = this.db.prepare(`UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?`).run(pinned ? 1 : 0, Date.now(), id);
    return r.changes > 0;
  }

  /** 归档/恢复（归档回收站） */
  setArchived(id: string, archived: boolean): boolean {
    const r = this.db.prepare(`UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?`).run(archived ? 1 : 0, Date.now(), id);
    return r.changes > 0;
  }

  /**
   * Rewind：回滚到检查点——删除 seq >= 目标的所有事件，会话回到"未完成"态。
   * 检查点事件为 user-message / step-start（由调用方传入对应 seq）。
   */
  rewind(id: string, seq: number, opts?: { marker?: boolean }): boolean {
    const s = this.getSession(id);
    if (!s) return false;
    // v4.0 审计修复（L5）：DELETE 事件 / updateStatus / marker 落库包事务——原实现
    // 三步分离，进程崩溃会留下「事件已删但状态 running」或 marker 缺失的中间态；
    // 内部 appendEvent 经 txnDepth 参与本事务（不嵌套 BEGIN）
    this.txnDepth++;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM events WHERE session_id = ? AND seq >= ?`).run(id, seq);
      this.updateStatus(id, "stopped");
      // v2.14 批 9：回滚标记落库（rebuild 时注入 system 提示——AI 意识到已回滚并知道位置）；
      // v2.14 批 10：编辑场景（marker:false）不落标记——编辑 = 正常历史修改，AI 无需被告知（截断后自然看不到旧内容）
      if (opts?.marker !== false) {
        this.appendEvent(id, { type: "rewind", to: seq, at: Date.now() });
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 忽略 */ }
      throw e;
    } finally {
      this.txnDepth--;
    }
    return true;
  }

  /**
   * 历史回顾（继续会话注入）：用户消息序列 + 最后一次 plan/review/report 产出。
   * 模型据此理解"之前做了什么、卡在哪"，再完整编排重跑（消息级重建留 v2.2）。
   */
  summarizeSession(id: string): SessionSummary {
    const events = this.getEvents(id);
    const summary: SessionSummary = { prompts: [] };
    for (const { event } of events) {
      switch (event.type) {
        case "user-message":
          summary.prompts.push(event.text);
          break;
        case "plan":
          summary.lastPlan = event.content;
          break;
        case "review":
          summary.lastReview = event.content;
          break;
        case "report":
          summary.lastReport = event.content;
          break;
      }
    }
    return summary;
  }

  /**
   * v2.7 使用统计：从会话事件流聚合（token = text/reasoning 字符数/4 估算）。
   * 模型用量按 phase-start 事件的 model 字段分布（阶段数占比）近似分配 token。
   */
  getStats(days: number): UsageStats {
    const since = Date.now() - days * 86400000;
    const get = (sql: string, ...args: any[]) => this.db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
    const all = (sql: string, ...args: any[]) => this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;

    const charSql = "length(COALESCE(json_extract(event_json,'$.text'),'')) + length(COALESCE(json_extract(event_json,'$.reasoning'),''))";

    // v3.0 批 12：总用量优先真实 usage（done 事件四桶），无真实数据回退字符估算
    const usageRow = get(
      `SELECT COALESCE(SUM(json_extract(event_json,'$.usage.promptTokens')), 0) AS pt,
              COALESCE(SUM(json_extract(event_json,'$.usage.completionTokens')), 0) AS ct,
              COALESCE(SUM(json_extract(event_json,'$.usage.cacheHit')), 0) AS ch,
              COALESCE(SUM(json_extract(event_json,'$.usage.cacheMiss')), 0) AS cm
       FROM events WHERE ts >= ? AND json_extract(event_json,'$.type') = 'done'`, since
    );
    const _pt = Number(usageRow?.pt ?? 0);
    const _ct = Number(usageRow?.ct ?? 0);
    const _ch = Number(usageRow?.ch ?? 0);
    const _cm = Number(usageRow?.cm ?? 0);
    const realTotal = _pt + _ct + _ch + _cm;
    const tokens =
      realTotal > 0
        ? Math.max(_pt, _ch + _cm) + _ct
        : Math.round(Number(get(`SELECT COALESCE(SUM(${charSql}), 0) AS chars FROM events WHERE ts >= ?`, since)?.chars ?? 0) / 4);

    const msgRow = get(`SELECT COUNT(*) AS c FROM events WHERE ts >= ? AND json_extract(event_json,'$.type') = 'user-message'`, since);
    const sessRow = get(`SELECT COUNT(*) AS c FROM sessions WHERE created_at >= ?`, since);
    const activeRow = get(`SELECT COUNT(DISTINCT date(ts/1000,'unixepoch','localtime')) AS c FROM events WHERE ts >= ?`, since);

    // 连续活跃天数（从今天往前，有会话的连续天数）
    const dayRows = all(`SELECT DISTINCT date(created_at/1000,'unixepoch','localtime') AS d FROM sessions`);
    const daySet = new Set(dayRows.map((r) => String(r.d)));
    let streak = 0;
    const now = new Date();
    for (let i = 0; i < 365; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (daySet.has(ds)) streak++;
      else break;
    }

    // v3.0 UI 审查：模型真实用量——model-call 事件聚合（每次模型调用真实 token），
    // 无 model-call 数据（旧会话）回退 phase-start 阶段数占比近似
    const mcModelRows = all(
      `SELECT json_extract(event_json,'$.model') AS model,
              SUM(COALESCE(json_extract(event_json,'$.promptTokens'),0) + COALESCE(json_extract(event_json,'$.completionTokens'),0)) AS t
       FROM events WHERE ts >= ? AND json_extract(event_json,'$.type') = 'model-call' GROUP BY model ORDER BY t DESC`,
      since
    );
    const mcTotal = mcModelRows.reduce((s, r) => s + Number(r.t), 0);
    let modelUsage: Array<{ model: string; tokens: number; share: number }>;
    if (mcTotal > 0) {
      modelUsage = mcModelRows.map((r) => ({
        model: String(r.model),
        tokens: Number(r.t),
        share: Math.round((Number(r.t) / mcTotal) * 1000) / 10,
      }));
    } else {
      const modelRows = all(
        `SELECT json_extract(event_json,'$.model') AS model, COUNT(*) AS cnt FROM events WHERE ts >= ? AND json_extract(event_json,'$.type') = 'phase-start' AND json_extract(event_json,'$.model') IS NOT NULL GROUP BY model ORDER BY cnt DESC`,
        since
      );
      const totalPhases = modelRows.reduce((s, r) => s + Number(r.cnt), 0);
      modelUsage = modelRows.map((r) => {
        const cnt = Number(r.cnt);
        const share = totalPhases ? cnt / totalPhases : 0;
        return { model: String(r.model), tokens: Math.round(tokens * share), share: Math.round(share * 1000) / 10 };
      });
    }
    const topModel = modelUsage[0] ? { model: modelUsage[0].model, share: modelUsage[0].share } : null;

    // v3.0 UI 审查：按天×模型真实 token（model-call 聚合；条形图同日多模型并列条）
    const mcDailyRows = all(
      `SELECT date(ts/1000,'unixepoch','localtime') AS d, json_extract(event_json,'$.model') AS model,
              SUM(COALESCE(json_extract(event_json,'$.promptTokens'),0) + COALESCE(json_extract(event_json,'$.completionTokens'),0)) AS t
       FROM events WHERE ts >= ? AND json_extract(event_json,'$.type') = 'model-call' GROUP BY d, model`,
      since
    );
    const byModelByDay = new Map<string, Array<{ model: string; tokens: number }>>();
    for (const r of mcDailyRows) {
      const d = String(r.d);
      const arr = byModelByDay.get(d) ?? [];
      arr.push({ model: String(r.model), tokens: Number(r.t) });
      byModelByDay.set(d, arr);
    }

    // 按天 token 趋势（v3.0 批 12：优先真实 usage——done 事件携带模型返回的
    // prompt/completion/cache 四桶；无 usage 数据的旧会话回退字符估算。
    // v3.0 UI 审查：日期集合 = done ∪ model-call——纯 model-call 会话（统计期新建、
    // 或 done 无 usage）也出现在趋势中，tokens 用 model-call 真实四桶）
    const dailyRows = all(
      `SELECT date(ts/1000,'unixepoch','localtime') AS d,
              COALESCE(SUM(json_extract(event_json,'$.usage.promptTokens')), 0) AS pt,
              COALESCE(SUM(json_extract(event_json,'$.usage.completionTokens')), 0) AS ct,
              COALESCE(SUM(json_extract(event_json,'$.usage.cacheHit')), 0) AS ch,
              COALESCE(SUM(json_extract(event_json,'$.usage.cacheMiss')), 0) AS cm,
              COALESCE(SUM(${charSql}), 0) AS chars
       FROM events WHERE ts >= ? AND json_extract(event_json,'$.type') = 'done' GROUP BY d ORDER BY d`,
      since
    );
    const mcDayRows = all(
      `SELECT date(ts/1000,'unixepoch','localtime') AS d,
              COALESCE(SUM(json_extract(event_json,'$.promptTokens')), 0) AS pt,
              COALESCE(SUM(json_extract(event_json,'$.completionTokens')), 0) AS ct
       FROM events WHERE ts >= ? AND json_extract(event_json,'$.type') = 'model-call' GROUP BY d ORDER BY d`,
      since
    );
    const mcDay = new Map(mcDayRows.map((r) => [String(r.d), { pt: Number(r.pt ?? 0), ct: Number(r.ct ?? 0) }]));
    const doneDay = new Map(dailyRows.map((r) => [String(r.d), r]));
    const allDays = [...new Set([...doneDay.keys(), ...mcDay.keys()])].sort();
    const dailyTrend = allDays.map((d) => {
      const r = doneDay.get(d);
      const pt = Number(r?.pt ?? 0);
      const ct = Number(r?.ct ?? 0);
      const ch = Number(r?.ch ?? 0);
      const cm = Number(r?.cm ?? 0);
      // v3.0 批 12：真实四桶优先；总 tokens = 输入 + 输出——输入取 max(prompt, cacheHit+cacheMiss)
      // （部分端点 prompt_tokens 已含缓存命中，直接相加会重复计算）
      const real = pt + ct + ch + cm;
      // v3.0 UI 审查：仅 model-call 的日期（无 done usage）→ 用调用级真实四桶
      const mc = mcDay.get(d);
      const tokens =
        real > 0
          ? Math.max(pt, ch + cm) + ct
          : mc && mc.pt + mc.ct > 0
            ? mc.pt + mc.ct
            : Math.round(Number(r?.chars ?? 0) / 4);
      return {
        date: d,
        tokens,
        prompt: pt || mc?.pt || 0,
        completion: ct || mc?.ct || 0,
        cacheHit: ch,
        cacheMiss: cm,
        estimated: real === 0 && !(mc && mc.pt + mc.ct > 0),
        byModel: byModelByDay.get(d) ?? [],
      };
    });

    return {
      rangeDays: days,
      tokens,
      sessions: Number(sessRow?.c ?? 0),
      messages: Number(msgRow?.c ?? 0),
      activeDays: Number(activeRow?.c ?? 0),
      streak,
      topModel,
      modelUsage,
      dailyTrend,
    };
  }
}

/** 单例（服务端 / CLI 共用；模块加载时惰性创建） */
let _store: SessionStore | null = null;
export function getStore(): SessionStore {
  if (!_store) _store = new SessionStore();
  return _store;
}

/** v3.5：数据目录迁移后重连数据库（关闭旧连接，下次 getStore 按新指针重新打开） */
export function resetStore(): void {
  try {
    _store?.close();
  } catch {
    /* 关闭失败忽略 */
  }
  _store = null;
}

function rowToMeta(row: Record<string, unknown>): SessionMeta {
  return {
    id: String(row.id),
    title: String(row.title),
    root: String(row.root),
    modelId: row.model_id ? String(row.model_id) : undefined,
    mode: row.mode ? String(row.mode) : undefined,
    status: row.status as SessionStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    eventCount: Number(row.event_count ?? 0),
    toolCount: Number(row.tool_count ?? 0),
    promptCount: Number(row.prompt_count ?? 0),
    pinned: Number(row.pinned ?? 0) === 1,
    archived: Number(row.archived ?? 0) === 1,
  };
}
