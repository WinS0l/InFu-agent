import type { AgentEvent, TaskTemplate } from "@infu/shared";
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

/** 发起 Agent 任务（SSE 流式，支持停止） */
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
  }
}
