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
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, SessionMeta, SessionStatus, StoredEvent } from "@infu/shared";

const DEFAULT_DB_PATH = join(homedir(), ".infu", "infu.db");

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

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(join(homedir(), ".infu"), { recursive: true });
    this.db = new DatabaseSync(dbPath);
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

  /** 追加事件（返回 seq），同步更新 updated_at */
  appendEvent(sessionId: string, event: AgentEvent): number {
    const seqRow = this.db
      .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?`)
      .get(sessionId) as { next: number };
    this.db
      .prepare(`INSERT INTO events (session_id, seq, ts, event_json) VALUES (?, ?, ?, ?)`)
      .run(sessionId, seqRow.next, Date.now(), JSON.stringify(event));
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
    return seqRow.next;
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
    this.db.prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
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
  rewind(id: string, seq: number): boolean {
    const s = this.getSession(id);
    if (!s) return false;
    this.db.prepare(`DELETE FROM events WHERE session_id = ? AND seq >= ?`).run(id, seq);
    this.updateStatus(id, "stopped");
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
}

/** 单例（服务端 / CLI 共用；模块加载时惰性创建） */
let _store: SessionStore | null = null;
export function getStore(): SessionStore {
  if (!_store) _store = new SessionStore();
  return _store;
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
