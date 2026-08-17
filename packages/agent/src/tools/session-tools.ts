/**
 * v2.12 session 查询工具（给 Agent 检索历史会话用）
 * - session_search：按关键词/最近会话搜索历史（id/标题/时间/状态/模型/事件数）
 * - session_trace：查看指定会话的执行轨迹（关键事件摘要：文本/工具调用与结果/错误/完成）
 * 数据源 = InFu SQLite 会话库（~/.infu/infu.db，只读访问，无副作用）。
 */

import { z } from "zod";
import { getStore, type SessionStore } from "../db/store.js";
import type { ToolDef, StoredEvent } from "@infu/shared";

/** 会话库访问（默认全局单例；测试可注入临时库，避免污染真实会话数据） */
let storeProvider: () => SessionStore = getStore;
export function setSessionStoreProvider(p: () => SessionStore): void {
  storeProvider = p;
}

/** 轨迹只挑关键事件（跳过 reasoning/tool 内部噪音/审批过程——复盘看结论与动作） */
const TRACE_KEY_TYPES = new Set(["user-message", "text", "tool-start", "tool-result", "error", "done", "plan", "review", "subagent-start", "subagent-done"]);

function fmtEvent(e: StoredEvent): string {
  const ev = e.event as any;
  switch (ev.type) {
    case "user-message":
      return `👤 ${String(ev.text ?? "").slice(0, 200)}`;
    case "text":
      return `💬 ${String(ev.text ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
    case "tool-start":
      return `⚙ ${ev.tool} ${JSON.stringify(ev.args ?? {}).slice(0, 120)}`;
    case "tool-result":
      return `  ↳ ${ev.ok ? "✓" : "✗"} ${String(ev.summary ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
    case "error":
      return `⛔ 错误：${String(ev.message ?? "").slice(0, 200)}`;
    case "done":
      return `🏁 完成（${ev.steps} 步 / ${ev.toolCount} 次工具）`;
    case "plan":
      return `📋 计划：${String(ev.content ?? "").slice(0, 150)}`;
    case "review":
      return `🔍 审查：${String(ev.content ?? "").slice(0, 150)}`;
    case "subagent-start":
      return `◇ 委派子智能体 ${ev.name}（${ev.id}）：${String(ev.prompt ?? "").slice(0, 120)}`;
    case "subagent-done":
      return `◇ 子智能体完成（${ev.id}）：${ev.ok ? "正常" : "异常"} ${ev.steps}步/${ev.toolCount}次工具`;
    default:
      return "";
  }
}

export const sessionTools: Record<string, ToolDef> = {
  session_search: {
    name: "session_search",
    description:
      "搜索历史会话（关键词匹配标题/项目根目录；省略关键词 = 最近会话）。返回：会话 id/标题/时间/状态/事件数/项目。用于回顾之前任务、复用会话（配合 --session 继续）。",
    risk: "low",
    schema: z.object({
      query: z.string().optional().describe("关键词（匹配标题与项目根目录；省略 = 列出最近会话）"),
      limit: z.number().int().min(1).max(20).optional().describe("返回条数（默认 10）"),
    }),
    async execute(args) {
      const q = String(args.query ?? "").trim().toLowerCase();
      const limit = (args.limit as number | undefined) ?? 10;
      const sessions = storeProvider().listSessions(200);
      const hits = sessions
        .filter((s) => !q || s.title.toLowerCase().includes(q) || s.root.toLowerCase().includes(q))
        .slice(0, limit);
      if (!hits.length) return q ? `未找到匹配 "${q}" 的会话（关键词匹配标题与项目根目录）` : "当前还没有历史会话";
      const lines = hits.map((s) => {
        const d = new Date(s.createdAt);
        const proj = s.root.split(/[\\/]/).filter(Boolean).pop() ?? s.root;
        const st = s.status === "running" ? " [运行中]" : s.status === "error" ? " [异常]" : s.status === "stopped" ? " [已停止]" : "";
        return `· ${s.id}${st} ${d.toLocaleDateString()} ${d.toLocaleTimeString()} — ${s.title}（${proj}，${s.eventCount} 事件${s.modelId ? `，${s.modelId}` : ""}）`;
      });
      return `历史会话（${hits.length} 条${q ? `，匹配 "${q}"` : ""}）：\n${lines.join("\n")}\n\n查看执行轨迹: session_trace(session_id)`;
    },
  },

  session_trace: {
    name: "session_trace",
    description:
      "查看历史会话的执行轨迹（关键事件摘要：用户消息/模型文本/工具调用与结果/错误/计划/完成）。用于复盘之前任务怎么做的、复用经验。",
    risk: "low",
    schema: z.object({
      session_id: z.string().describe("会话 id（session_search 查看）"),
      limit: z.number().int().min(1).max(300).optional().describe("最多展示关键事件数（默认 80，从尾部取）"),
    }),
    async execute(args) {
      const id = String(args.session_id ?? "");
      const store = storeProvider();
      const meta = store.getSession(id);
      if (!meta) return `错误：会话不存在 ${id}（用 session_search 查找）`;
      const events = store.getEvents(id);
      const limit = (args.limit as number | undefined) ?? 80;
      const picked = events.filter((e) => TRACE_KEY_TYPES.has(e.event.type)).slice(-limit);
      if (!picked.length) return `会话 ${id}「${meta.title}」没有可展示的关键事件`;
      const lines = picked.map(fmtEvent).filter(Boolean);
      return `会话 ${id}「${meta.title}」执行轨迹（${picked.length} 条关键事件${picked.length < events.length ? `，共 ${events.length} 条原始事件` : ""}）：\n${lines.join("\n")}`;
    },
  },
};
