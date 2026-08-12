import type { AgentEvent, RiskLevel, SessionMeta, StoredEvent, TaskTemplate } from "@infu/shared";
import { useStore } from "./store";

/** 加载模型列表 */
export async function fetchModels() {
  const res = await fetch("/api/models");
  if (!res.ok) throw new Error(`模型列表加载失败: ${res.status}`);
  const data = await res.json();
  useStore.getState().setModels(data.models ?? []);
  return data;
}

/** 加载模板任务列表（小白引导） */
export async function fetchTemplates(): Promise<TaskTemplate[]> {
  const res = await fetch("/api/templates");
  if (!res.ok) throw new Error(`模板加载失败: ${res.status}`);
  return res.json();
}

/** SSE 事件分发 */
function handleEvent(ev: AgentEvent) {
  const st = useStore.getState();
  switch (ev.type) {
    case "session":
      // v2.1：SSE 首帧回传新会话 id，绑定当前会话
      st.setActiveSessionId(ev.id);
      // 立即刷新会话列表（任务运行中卡片即出现，带「运行中」徽标）
      fetchSessions().catch(() => {});
      break;
    case "text":
      st.appendText(ev.text);
      break;
    case "reasoning":
      st.appendReasoning(ev.text);
      break;
    case "step-start":
      st.beginStep(ev.step);
      break;
    case "phase-start":
      st.setPhase(ev);
      break;
    case "tool-start":
      st.startTool(ev);
      break;
    case "tool-result":
      st.finishTool(ev);
      break;
    case "approval-required":
      st.requestApproval(ev);
      break;
    case "approval-result":
      // 弹窗已由 resolveApproval 关闭
      break;
    case "report":
      st.setReport(ev.content);
      break;
    case "review":
      st.setReview(ev.content);
      break;
    case "plan":
      st.setPlan({ id: ev.id, content: ev.content });
      break;
    case "done":
      st.finishAssistant();
      break;
    case "error":
      st.addError(ev.message);
      break;
  }
}

/** worktree 操作 */
export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
}

export async function createWorktree(root: string): Promise<WorktreeInfo> {
  const res = await fetch("/api/worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "创建工作树失败");
  return data;
}

export async function mergeWorktree(root: string, name: string) {
  const res = await fetch(`/api/worktree/${encodeURIComponent(name)}/merge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "合并失败");
  return data;
}

export async function discardWorktree(root: string, name: string) {
  const res = await fetch(`/api/worktree/${encodeURIComponent(name)}/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "丢弃失败");
  return data;
}

/** 计划确认（Web 计划卡片：批准/拒绝，plan 为编辑后的计划文本） */
export async function postPlanDecision(id: string, approved: boolean, plan?: string) {
  const res = await fetch(`/api/plan/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved, plan }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "计划确认失败");
  return data;
}

// ── v2.1 会话管理 ──

/** 会话列表（刷新 store） */
export async function fetchSessions(): Promise<SessionMeta[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`会话列表加载失败: ${res.status}`);
  const data = await res.json();
  const sessions: SessionMeta[] = data.sessions ?? [];
  useStore.getState().setSessions(sessions);
  return sessions;
}

/** 会话详情（全量事件流 → 重放历史） */
export async function fetchSessionEvents(id: string): Promise<{ session: SessionMeta; events: StoredEvent[] }> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`会话加载失败: ${res.status}`);
  return res.json();
}

/** 删除会话 */
export async function deleteSession(id: string) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "删除失败");
}

/** Rewind：回滚到检查点（seq 及之后的事件删除） */
export async function rewindSession(id: string, seq: number) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/rewind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seq }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "回滚失败");
}

/**
 * v1 数据迁移：DB 尚无会话且 localStorage 有旧对话时，一次性导入为历史会话。
 * 幂等：已迁移（localStorage messages 已清空）或 DB 已有会话时无操作。
 */
export async function maybeMigrateV1(): Promise<boolean> {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    if ((data.sessions ?? []).length > 0) return false; // DB 已有会话，不迁移
    const raw = localStorage.getItem("infu-chat");
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const msgs: Array<{ role: string; text?: string; reasoning?: string; report?: string; review?: string; tools?: Array<{ tool: string; args?: Record<string, unknown>; risk?: string; status?: string; summary?: string; output?: string }> }> =
      parsed?.state?.messages;
    if (!Array.isArray(msgs) || !msgs.length) return false;

    // 旧消息 → 事件流（尽力还原；v1 只有最终态数据）
    const events: AgentEvent[] = [];
    for (const m of msgs) {
      if (m.role === "user") {
        events.push({ type: "user-message", text: String(m.text ?? "") });
        events.push({ type: "step-start", step: 1 });
      } else if (m.role === "assistant") {
        for (const t of m.tools ?? []) {
          if (!t.tool || t.status === "running") continue;
          events.push({ type: "tool-start", tool: t.tool, args: t.args ?? {}, risk: (t.risk ?? "low") as RiskLevel });
          events.push({ type: "tool-result", tool: t.tool, ok: t.status === "ok", summary: t.output ?? t.summary ?? "" });
        }
        if (m.reasoning) events.push({ type: "reasoning", text: m.reasoning });
        if (m.text) events.push({ type: "text", text: m.text });
        if (m.report) events.push({ type: "report", content: m.report });
        if (m.review) events.push({ type: "review", content: m.review });
        events.push({ type: "done", text: "", toolCount: (m.tools ?? []).length, steps: 1 });
      }
    }
    if (!events.length) return false;

    const firstUser = msgs.find((m) => m.role === "user");
    const created = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: String(firstUser?.text ?? "v1 历史对话").slice(0, 40),
        root: parsed?.state?.root || "",
        modelId: parsed?.state?.modelId || undefined,
      }),
    });
    const { id } = await created.json();
    if (!id) return false;
    const imported = await fetch(`/api/sessions/${encodeURIComponent(id)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    const imp = await imported.json();
    if (!imp.ok) return false;

    // 迁移完成：清空 localStorage 里的旧 messages（其余设置保留）
    parsed.state.messages = [];
    localStorage.setItem("infu-chat", JSON.stringify(parsed));
    return true;
  } catch {
    return false; // 迁移失败不阻塞启动
  }
}

/** 发起 Agent 任务（SSE 流式，支持停止；v2.1 绑定当前会话） */
export async function sendChat(prompt: string) {
  const st = useStore.getState();
  st.addUserMsg(prompt);
  st.ensureAssistant();

  // 停止支持：AbortController 存入 store，点击停止按钮时 abort
  const controller = new AbortController();
  st.setAbortController(controller);

  // 任务工作树模式：为每个任务创建独立 git worktree（主代码零污染）
  let effectiveRoot = st.root;
  if (st.useWorktree) {
    try {
      const wt = await createWorktree(st.root);
      st.setWorktree(wt);
      effectiveRoot = wt.path;
    } catch (e) {
      st.addWorktreeNote(`工作树创建失败（${(e as Error).message}），已在原目录执行`);
    }
  }

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        root: effectiveRoot,
        modelId: st.modelId,
        // 三档模式：分层编排（full + 计划确认）/ 直接执行（off）/ 只出方案（suggestOnly）
        orchestrate: st.mode === "orchestrate" ? "full" : "off",
        suggestOnly: st.mode === "ask",
        planApproval: true,
        // v2.1：绑定当前会话（null = 服务端新建并回传 session 事件）
        sessionId: st.activeSessionId ?? undefined,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`请求失败: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE 按空行分帧，取 data: 行
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const ev = JSON.parse(dataLine.slice(5).trim()) as AgentEvent;
          handleEvent(ev);
        } catch {
          /* 忽略坏帧 */
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      useStore.getState().addError("已手动停止任务");
    } else {
      useStore.getState().addError((e as Error).message);
    }
  } finally {
    useStore.getState().setAbortController(null);
    useStore.getState().finishAssistant();
    // 计划未确认就中断（停止/异常/断流）时清理计划卡片，避免残留
    useStore.getState().clearPlan();
    // 任务结束：重拉事件补全回滚锚点（实时流消息无 seqStart，重放后即可回滚）
    const sid = useStore.getState().activeSessionId;
    if (sid) {
      fetchSessionEvents(sid)
        .then(({ events }) => useStore.getState().loadSession(events))
        .catch(() => {});
    }
    // 会话列表刷新（新会话/状态更新）
    fetchSessions().catch(() => {});
  }
}
