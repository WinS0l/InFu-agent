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

// ── v2 供应商凭据（模型管理重构）──

export interface ProviderInfo {
  id: string;
  name: string;
  kind: string;
  baseURL?: string;
  hasKey: boolean;
  modelCount: number;
}

/** 供应商列表 */
export async function fetchProviders(): Promise<ProviderInfo[]> {
  const res = await fetch("/api/providers");
  if (!res.ok) throw new Error(`供应商加载失败: ${res.status}`);
  const data = await res.json();
  return data.providers ?? [];
}

async function providerApi<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `请求失败: ${res.status}`);
  return data as T;
}

export const addProvider = (body: { id: string; name: string; kind: string; baseURL?: string; apiKey?: string }) =>
  providerApi("/api/providers", "POST", body);
export const updateProvider = (id: string, body: { name?: string; kind?: string; baseURL?: string; apiKey?: string }) =>
  providerApi(`/api/providers/${encodeURIComponent(id)}`, "PUT", body);
export const deleteProvider = (id: string) => providerApi(`/api/providers/${encodeURIComponent(id)}`, "DELETE");

/** 从上游获取模型列表（OpenAI 兼容 /models） */
export async function fetchProviderModels(id: string): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`/api/providers/${encodeURIComponent(id)}/models`, { method: "POST" });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `获取模型失败: ${res.status}`);
  return data.models ?? [];
}

// ── v2.3 角色路由（面板：每角色 模型 + 独立思考级别）──

export interface RoleConfig {
  role: "planner" | "executor" | "reviewer";
  modelId?: string;
  thinkingLevel?: number;
}

export async function fetchRoles(): Promise<RoleConfig[]> {
  const res = await fetch("/api/roles");
  if (!res.ok) throw new Error(`角色配置加载失败: ${res.status}`);
  const data = await res.json();
  return data.roles ?? [];
}

export async function saveRoles(body: Record<string, { model?: string; thinkingLevel?: number } | undefined>) {
  const res = await fetch("/api/roles", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `保存角色配置失败: ${res.status}`);
  return data;
}

// ── v2.3 MCP 服务器管理（MCP 客户端作为第一个插件类型：工具动态注入执行阶段）──

export interface McpServerInfo {
  id: string;
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  /** 环境变量键名（脱敏：值不回传，防密钥泄漏） */
  envKeys: string[];
  riskOverrides?: Record<string, RiskLevel>;
}

export async function fetchMcpServers(): Promise<McpServerInfo[]> {
  const res = await fetch("/api/mcp");
  if (!res.ok) throw new Error(`MCP 服务器加载失败: ${res.status}`);
  const data = await res.json();
  return data.servers ?? [];
}

export interface McpToolProbe {
  name: string;
  description: string;
  risk: RiskLevel;
}

export interface McpServerBody {
  id?: string;
  name?: string;
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
  env?: Record<string, string>;
  riskOverrides?: Record<string, RiskLevel>;
}

export const addMcpServer = (body: McpServerBody) => providerApi("/api/mcp", "POST", body);
export const updateMcpServer = (id: string, body: McpServerBody) =>
  providerApi(`/api/mcp/${encodeURIComponent(id)}`, "PUT", body);
export const deleteMcpServer = (id: string) => providerApi(`/api/mcp/${encodeURIComponent(id)}`, "DELETE");

/** 探测连接：拉取服务器工具列表（名称/描述/有效风险；15s 超时） */
export async function probeMcpTools(id: string): Promise<McpToolProbe[]> {
  const res = await fetch(`/api/mcp/${encodeURIComponent(id)}/tools`, { method: "POST" });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `探测失败: ${res.status}`);
  return data.tools ?? [];
}

// ── v2.3 批 2 插件管理（JS 模块插件：工具/钩子/技能）──

export interface PluginInfo {
  id: string;
  path: string;
  enabled?: boolean;
}

export async function fetchPlugins(): Promise<PluginInfo[]> {
  const res = await fetch("/api/plugins");
  if (!res.ok) throw new Error(`插件加载失败: ${res.status}`);
  const data = await res.json();
  return data.plugins ?? [];
}

export interface PluginProbeResult {
  tools: Array<{ name: string; risk: RiskLevel }>;
  hooks: { preToolUse: number; postToolUse: number };
}

export async function probePlugin(id: string): Promise<PluginProbeResult> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/probe`, { method: "POST" });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `探测失败: ${res.status}`);
  return data;
}

export const addPlugin = (body: { id: string; path: string }) => providerApi("/api/plugins", "POST", body);
export const updatePlugin = (id: string, body: { path?: string; enabled?: boolean }) =>
  providerApi(`/api/plugins/${encodeURIComponent(id)}`, "PUT", body);
export const deletePlugin = (id: string) => providerApi(`/api/plugins/${encodeURIComponent(id)}`, "DELETE");

/** 生成带钩子的插件（v2.4：设置界面「新建钩子」——钩子是插件属性；写入 ~/.infu/plugins/<id>.mjs 并注册） */
export async function generatePlugin(body: { id: string; code: string; path?: string }): Promise<{ plugin: string; path: string }> {
  return providerApi("/api/plugins/generate", "POST", body);
}

// ── v2.3 批 2 技能管理（SKILL.md 社区标准）──

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  level: "user" | "project" | "config";
}

export async function fetchSkills(): Promise<SkillInfo[]> {
  const res = await fetch("/api/skills");
  if (!res.ok) throw new Error(`技能加载失败: ${res.status}`);
  const data = await res.json();
  return data.skills ?? [];
}

export const addSkill = (body: { name: string; path?: string }) => providerApi("/api/skills", "POST", body);
export const deleteSkill = (name: string) => providerApi(`/api/skills/${encodeURIComponent(name)}`, "DELETE");

// ── v2.5 子智能体（agent 文件化定义：内置 > ~/.infu/agents > 项目 .infu/agents，文件系统即注册）──

export interface AgentInfo {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  maxSteps?: number;
  thinkingLevel?: number;
  permission?: "allow" | "ask";
  sandbox?: "off" | "soft" | "restricted";
  body: string;
  path: string;
  level: "user" | "project" | "builtin";
}

export async function fetchAgents(): Promise<AgentInfo[]> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error(`子智能体加载失败: ${res.status}`);
  const data = await res.json();
  return data.agents ?? [];
}

/** 保存（创建/更新）agent 文件：level = user（~/.infu/agents）| project（项目 .infu/agents） */
export const saveAgent = (body: { name: string; level: "user" | "project"; content: string }) =>
  providerApi("/api/agents", "POST", body) as Promise<{ ok: boolean; path: string }>;

export const deleteAgent = (name: string) => providerApi(`/api/agents/${encodeURIComponent(name)}`, "DELETE");

// ── v2.4 设置界面（配置系统 UI 化：权限等级 / 沙箱等级 / 常规 / 外观）──

export type ApprovalMode = "auto" | "smart" | "confirm";
export type SandboxModeValue = "auto" | "off" | "soft" | "restricted" | "docker";

export interface ToolRiskOverrideInput {
  tool: string;
  risk?: RiskLevel;
  disabled?: boolean;
}

export interface SettingsConfig {
  approvalPolicy: {
    mode?: ApprovalMode;
    toolOverrides?: ToolRiskOverrideInput[];
    commandAllowlist?: string[];
  };
  sandbox: {
    mode?: SandboxModeValue;
    /** 沙箱可用性（服务端检测；UI 标注「当前机器不可用」） */
    dockerAvailable?: boolean;
    winRestrictedOk?: boolean;
  };
  general: { defaultRoot?: string };
  appearance: { fontSize?: "xs" | "sm" | "base"; streamCursor?: boolean };
  defaultModelId: string | null;
}

/** 读取设置四节（权限/沙箱/常规/外观 + 默认模型） */
export async function fetchConfig(): Promise<SettingsConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`设置加载失败: ${res.status}`);
  return res.json();
}

/** 保存设置（服务端白名单：只接受四节 + defaultModelId；写入后落盘 ~/.infu/config.json） */
export async function updateConfig(
  body: Partial<Pick<SettingsConfig, "approvalPolicy" | "sandbox" | "general" | "appearance">> & { defaultModelId?: string | null }
) {
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `保存设置失败: ${res.status}`);
  return data;
}

// ── v2.4 批 2 Web 交互式终端（node-pty；高危命令审批 + 全量审计）──

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  shell: string;
  pid: number;
}

/** 创建终端会话（cwd = 项目根；shell 可选 cmd/powershell/bash） */
export async function terminalStart(cwd?: string, shell?: string): Promise<TerminalSessionInfo> {
  const res = await fetch("/api/terminal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, shell }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `终端创建失败: ${res.status}`);
  return data;
}

export interface TerminalInputResult {
  ok: boolean;
  /** 高危命令拦截：true 表示需人工确认后带 confirmed 重发 */
  requireApproval?: boolean;
  risk?: RiskLevel;
  description?: string;
  message?: string;
}

/** 写入输入（命令级：command 字段供服务端高危检测与审计） */
export async function terminalInput(
  id: string,
  body: { data: string; command?: string; confirmed?: boolean }
): Promise<TerminalInputResult> {
  const res = await fetch(`/api/terminal/${encodeURIComponent(id)}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 404) throw new Error(data.message || "终端会话不存在");
  return data;
}

/** 同步 PTY 尺寸（xterm fit 后调用） */
export async function terminalResize(id: string, cols: number, rows: number) {
  await fetch(`/api/terminal/${encodeURIComponent(id)}/resize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols, rows }),
  });
}

/** 终止会话（kill 进程树） */
export async function terminalKill(id: string) {
  await fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 模板任务列表（小白引导） */
export async function fetchTemplates(): Promise<TaskTemplate[]> {
  const res = await fetch("/api/templates");
  if (!res.ok) throw new Error(`模板加载失败: ${res.status}`);
  return res.json();
}

/** SSE 事件分发 */
function handleEvent(ev: AgentEvent) {
  const st = useStore.getState();
  // v2.5：子智能体内部过程事件（带 subagentId）→ 路由进委派卡片的迷你时间线，不进主消息流
  if (ev && "subagentId" in ev && ev.subagentId) {
    st.updateSubagent(ev);
    // 子智能体内部的高危审批也必须进同一审批队列（否则服务端挂起死等）
    if (ev.type === "approval-required") st.requestApproval(ev);
    return;
  }
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
    case "model-fallback":
      st.appendFallback(ev.from, ev.to, ev.reason);
      break;
    case "context-compressed":
      st.appendCompressed(ev.before, ev.after, ev.summary);
      break;
    case "subagent-start":
      st.startSubagent(ev);
      break;
    case "subagent-done":
      st.finishSubagent(ev);
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

/** 计划确认（v2.3 计划卡片：提交 = {plan 编辑后文本, feedback 用户回复}；取消 = cancelled） */
export async function postPlanDecision(id: string, body: { plan?: string; feedback?: string } | { cancelled: true }) {
  const res = await fetch(`/api/plan/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
        // v2 思考级别（4 档，按模型实际级别数自动映射）
        thinkingLevel: st.thinkingLevel,
        // v2.2 动态步数启发式参考（模板任务）
        templateId: st.templateId ?? undefined,
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
