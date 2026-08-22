import { readSseData, takeSseFrames, type AgentEvent, type JobAuditRecord, type RiskLevel, type SessionMeta, type StoredEvent, type TaskDependency, type TaskSnapshot } from "@infu/shared";
import { useStore } from "./store";

/**
 * v3.0 桌面端：API 基址——桌面 dev 模式前端跑在 vite（5199）、后端在 agent 端口
 * （常驻 4317 可能被占用自动递增）→ 主进程 loadURL 带 ?infuAgentPort= 传实际端口，
 * 这里拼绝对地址跨域直连；生产模式（同端口静态托管）与 Web 版无 query → 保持同源零改动。
 */
const API_BASE = (() => {
  if (typeof window === "undefined") return "";
  const port = new URLSearchParams(window.location.search).get("infuAgentPort");
  return port ? `http://127.0.0.1:${port}` : "";
})();
// v4.0 审计修复（L12）：令牌一次性读取后从 window 全局删除——缩短 DOM 暴露面
// （任何后续注入的脚本/XSS 无法再读 window.__INFU_TOKEN__；HTML 每次加载仍会注入，
// 但读取发生在模块加载第一时间，暴露窗口 = 页面加载到 JS 执行之间）
const LOCAL_TOKEN = (() => {
  const g = globalThis as { __INFU_TOKEN__?: string };
  const t = g.__INFU_TOKEN__ ?? new URLSearchParams(globalThis.location?.search).get("infuAgentToken") ?? undefined;
  if (t) {
    try { delete g.__INFU_TOKEN__; } catch { /* 只读全局（罕见）降级 */ }
  }
  return t;
})();
async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" && input.startsWith("/") ? API_BASE + input : input;
  // v3.1 审计修复：本地令牌——生产模式（同端口静态托管）服务端注入
  // window.__INFU_TOKEN__（见 server.ts），所有 API 请求带 X-InFu-Token；
  // Vite/desktop development receives the same token in the launch URL.
  const token = LOCAL_TOKEN;
  if (token) {
    const headers = new Headers(init?.headers);
    headers.set("X-InFu-Token", token);
    return fetch(url, { ...init, headers });
  }
  return fetch(url, init);
}
// v3.0 审计修复（S7）：导出供 store/组件复用（裸 fetch 绕过 API_BASE，桌面 dev 端口错）
export { apiFetch };

export interface HealthInfo {
  ok: boolean;
  name: string;
  version?: string;
  uptimeSeconds?: number;
  tools?: number;
  sessions?: number;
  diagnostics?: { database: "ready" | "degraded"; models: "configured" | "missing"; configuredModels: number; sandbox: "ready" | "unavailable"; browser: "ready" | "available" | "stopped" | "disabled" };
}

/**
 * v3.4 审计修复：资源 URL 生成（img/audio 等浏览器原生加载无法带 header）——
 * 生产模式（同端口）下 /api/* 有本地令牌校验，img 不带 X-InFu-Token 会 401；
 * 这里把 token 挂到 query（服务端同时接受 ?token= 与 header），桌面 dev 模式拼绝对地址。
 */
export function apiUrl(p: string): string {
  const base = API_BASE + p;
  const token = LOCAL_TOKEN;
  if (!token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/** 读取本地 Agent 状态；统一走 apiFetch 以兼容桌面开发端口和令牌鉴权。 */
export async function fetchHealth(): Promise<HealthInfo> {
  const res = await apiFetch("/api/health", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`健康检查失败: ${res.status}`);
  const data = await res.json() as Partial<HealthInfo>;
  if (data.ok !== true) throw new Error("Agent 服务未就绪");
  return {
    ok: true,
    name: typeof data.name === "string" ? data.name : "infu-agent",
    version: typeof data.version === "string" ? data.version : undefined,
    uptimeSeconds: typeof data.uptimeSeconds === "number" ? data.uptimeSeconds : undefined,
    tools: typeof data.tools === "number" ? data.tools : undefined,
    sessions: typeof data.sessions === "number" ? data.sessions : undefined,
    diagnostics: typeof data.diagnostics === "object" && data.diagnostics !== null ? data.diagnostics as HealthInfo["diagnostics"] : undefined,
  };
}

export async function fetchTaskSnapshot(sessionId: string): Promise<TaskSnapshot> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/task-status`);
  if (!res.ok) throw new Error(`任务状态加载失败: ${res.status}`);
  return (await res.json() as { task: TaskSnapshot }).task;
}

export async function fetchJobAudits(sessionId: string): Promise<JobAuditRecord[]> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/jobs`);
  if (!res.ok) throw new Error(`任务审计加载失败: ${res.status}`);
  return (await res.json() as { jobs: JobAuditRecord[] }).jobs ?? [];
}

export async function fetchTaskGraph(sessionId: string): Promise<TaskDependency[]> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/task-graph`);
  if (!res.ok) throw new Error(`任务依赖图加载失败: ${res.status}`);
  return (await res.json() as { nodes: TaskDependency[] }).nodes ?? [];
}

export async function fetchCapabilities() {
  const res = await apiFetch("/api/capabilities");
  if (!res.ok) throw new Error(`能力声明加载失败: ${res.status}`);
  return (await res.json() as { capabilities: import("@infu/shared").CapabilityDeclaration[] }).capabilities ?? [];
}

/** 加载模型列表 */
export async function fetchModels() {
  const res = await apiFetch("/api/models");
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
  const res = await apiFetch("/api/providers");
  if (!res.ok) throw new Error(`供应商加载失败: ${res.status}`);
  const data = await res.json();
  return data.providers ?? [];
}

async function providerApi<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await apiFetch(url, {
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
  const res = await apiFetch(`/api/providers/${encodeURIComponent(id)}/models`, { method: "POST" });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `获取模型失败: ${res.status}`);
  return data.models ?? [];
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
  const res = await apiFetch("/api/mcp");
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
  const res = await apiFetch(`/api/mcp/${encodeURIComponent(id)}/tools`, { method: "POST" });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `探测失败: ${res.status}`);
  return data.tools ?? [];
}

// ── v2.3 批 2 插件管理（JS 模块插件：工具/钩子/技能）──

export interface PluginInfo {
  id: string;
  path: string;
  enabled?: boolean;
  name?: string;
  version?: string;
  source?: string;
  builtin?: boolean;
}

export async function fetchPlugins(): Promise<PluginInfo[]> {
  const res = await apiFetch("/api/plugins");
  if (!res.ok) throw new Error(`插件加载失败: ${res.status}`);
  const data = await res.json();
  return data.plugins ?? [];
}

export interface PluginProbeResult {
  tools: Array<{ name: string; risk: RiskLevel }>;
  hooks: { preToolUse: number; postToolUse: number };
}

export async function probePlugin(id: string): Promise<PluginProbeResult> {
  const res = await apiFetch(`/api/plugins/${encodeURIComponent(id)}/probe`, { method: "POST" });
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
  const res = await apiFetch("/api/skills");
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
  const res = await apiFetch("/api/agents");
  if (!res.ok) throw new Error(`子智能体加载失败: ${res.status}`);
  const data = await res.json();
  return data.agents ?? [];
}

export interface AgentToolInfo {
  name: string;
  description: string;
  risk: "low" | "medium" | "high";
}

export async function fetchAgentTools(): Promise<AgentToolInfo[]> {
  const res = await apiFetch("/api/agents/tools");
  if (!res.ok) throw new Error(`子智能体工具目录加载失败: ${res.status}`);
  const data = await res.json();
  return data.tools ?? [];
}

/** 保存（创建/更新）agent 文件：level = user（~/.infu/agents）| project（项目 .infu/agents） */
export const saveAgent = (body: { name: string; level: "user" | "project"; content: string }) =>
  providerApi("/api/agents", "POST", body) as Promise<{ ok: boolean; path: string }>;

export const deleteAgent = (name: string) => providerApi(`/api/agents/${encodeURIComponent(name)}`, "DELETE");

// ── v2.4 设置界面（配置系统 UI 化：权限等级 / 沙箱等级 / 常规 / 外观）──

export type ApprovalMode = "auto" | "smart" | "confirm" | "full";
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
  general: {
    defaultRoot?: string;
    terminalShell?: "auto" | "cmd" | "powershell" | "bash";
    autoLaunch?: boolean;
    // v3.5 常规设置：通知、托盘、防休眠、提问自动继续、显示开关、自动归档和保留期。
    taskNotifications?: boolean;
    notificationSound?: boolean;
    closeToTray?: boolean;
    preventSleep?: boolean;
    autoContinueQuestions?: boolean;
    showThinking?: boolean;
    showTodos?: boolean;
    autoCommit?: boolean;
    autoVerify?: boolean;
    autoArchive?: boolean;
    archiveRetentionDays?: number;
    quickModelId?: string;
    compressArchivedEvents?: boolean;
    compressArchivedAfterDays?: number;
    taskTokenBudget?: number;
  };
  appearance: { fontSize?: "xs" | "sm" | "base"; streamCursor?: boolean; theme?: "light" | "dark" | "system" };
  browser?: { headless?: boolean; executablePath?: string };
  memory?: { autoSediment?: boolean; autoRefine?: boolean };
  defaultModelId: string | null;
}

/** v2.7 浏览器状态（browser-use 插件 + chromium 探测） */
export interface BrowserStatus {
  available: boolean;
  chromiumPath: string | null;
  headless: boolean;
  executablePath: string;
  pluginEnabled: boolean;
}
export async function fetchBrowserStatus(): Promise<BrowserStatus> {
  const res = await apiFetch(`/api/browser/status`);
  if (!res.ok) throw new Error(`浏览器状态加载失败: ${res.status}`);
  return res.json();
}

/** v2.7 记忆查看（全局/项目主题 + 指令文件） */
export interface MemoryTopicInfo { name: string; hint: string; content: string; }
export interface MemoryInfo {
  globalDir: string;
  projectDir: string;
  global: MemoryTopicInfo[];
  project: MemoryTopicInfo[];
  instruction: { path: string; content: string } | null;
}
export async function fetchMemory(root?: string): Promise<MemoryInfo> {
  // v3.3 补 25：传当前项目 root——项目记忆按会话项目读取（原固定启动目录 → 空）
  const res = await apiFetch(`/api/memory${root ? `?root=${encodeURIComponent(root)}` : ""}`);
  if (!res.ok) throw new Error(`记忆加载失败: ${res.status}`);
  return res.json();
}

/** v2.7 使用统计（v3.0 UI 审查：dailyTrend 加 byModel——按天×模型真实 token） */
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
    byModel: Array<{ model: string; tokens: number }>;
  }>;
}
export async function fetchStats(days: number): Promise<UsageStats> {
  const res = await apiFetch(`/api/stats?days=${days}`);
  if (!res.ok) throw new Error(`统计加载失败: ${res.status}`);
  return res.json();
}

/** v2.7 索引库状态 */
export interface IndexStatus {
  built: boolean;
  fileCount: number;
  builtAt: number | null;
  sizeBytes: number;
  path: string | null;
}
export async function fetchIndexStatus(): Promise<IndexStatus> {
  const root = useStore.getState().root;
  const res = await apiFetch(`/api/index/status?root=${encodeURIComponent(root ?? "")}`);
  if (!res.ok) throw new Error(`索引状态加载失败: ${res.status}`);
  return res.json();
}
export async function rebuildIndex(): Promise<{ fileCount: number }> {
  const root = useStore.getState().root;
  const res = await apiFetch("/api/index/rebuild", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `重建失败: ${res.status}`);
  return data;
}

/** 清除浏览器数据（cache=保留 Cookie 与站点数据；all=全部清除） */
export async function clearBrowserData(scope: "cache" | "all"): Promise<string> {
  const res = await apiFetch(`/api/browser/clear`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `清理失败: ${res.status}`);
  return data.message;
}

/** 读取设置四节（权限/沙箱/常规/外观 + 默认模型） */
export async function fetchConfig(): Promise<SettingsConfig> {
  const res = await apiFetch("/api/config");
  if (!res.ok) throw new Error(`设置加载失败: ${res.status}`);
  return res.json();
}

/** 保存设置（服务端白名单：只接受四节 + defaultModelId；写入后落盘 ~/.infu/config.json） */
export async function updateConfig(
  body: Partial<Pick<SettingsConfig, "approvalPolicy" | "sandbox" | "general" | "appearance" | "browser" | "memory">> & { defaultModelId?: string | null }
) {
  const res = await apiFetch("/api/config", {
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

/** 创建终端会话（服务端从持久化会话读取唯一可信工作目录） */
export async function terminalStart(sessionId: string, shell?: string): Promise<TerminalSessionInfo> {
  const res = await apiFetch("/api/terminal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, shell }),
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
  body: { sessionId: string; data: string; command?: string; confirmed?: boolean }
): Promise<TerminalInputResult> {
  const res = await apiFetch(`/api/terminal/${encodeURIComponent(id)}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 404) throw new Error(data.message || "终端会话不存在");
  return data;
}

/** 同步 PTY 尺寸（xterm fit 后调用） */
export async function terminalResize(id: string, sessionId: string, cols: number, rows: number) {
  await apiFetch(`/api/terminal/${encodeURIComponent(id)}/resize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, cols, rows }),
  });
}

/** 终止会话（kill 进程树） */
export async function terminalKill(id: string, sessionId: string) {
  await apiFetch(`/api/terminal/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

export async function killBackgroundJob(id: string, sessionId: string): Promise<string> {
  const res = await apiFetch(`/api/jobs/${encodeURIComponent(id)}/kill`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.message || `中断后台任务失败: ${res.status}`);
  return data.message ?? "已请求中断";
}

/** SSE 事件分发（v3.1：按连接会话路由——并行多会话时事件写各自缓存，不串扰） */
function handleEvent(ev: AgentEvent, connSid: string | null) {
  const st = useStore.getState();
  // 事件路由目标 = 本连接会话（与当前视图不同才切换，避免每次 set 触发订阅）
  if (connSid && connSid !== st.eventTarget) st.setEventTarget(connSid);
  // 聊天视图只保留可读摘要；检查器保存同一条原始事件流，实时与历史会话一致。
  st.appendTrace(ev, connSid ?? st.eventTarget ?? st.activeSessionId);
  // v2.5：子智能体内部过程事件（带 subagentId）→ 路由进委派卡片的迷你时间线，不进主消息流
  if (ev && "subagentId" in ev && ev.subagentId) {
    st.updateSubagent(ev);
    // 子智能体内部的高危审批/提问也必须进同一队列（否则服务端挂起死等）
    if (ev.type === "approval-required") st.requestApproval(ev, connSid ?? undefined);
    if (ev.type === "ask-user") st.setAskQuestion({ id: ev.id, question: ev.question, options: ev.options }, connSid ?? undefined);
    return;
  }
  switch (ev.type) {
    case "session":
      // v2.1：SSE 首帧回传新会话 id，绑定当前会话
      // A late response from a newly-created session must not steal the view
      // after the user has selected another session while the request started.
      if (st.activeSessionId === null) st.setActiveSessionId(ev.id);
      st.setEventTarget(ev.id);
      // v3.1：新建会话即进入运行态（runningIds 标记，侧栏徽标）
      st.setSessionRunning(ev.id, true);
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
      st.requestApproval(ev, connSid ?? undefined);
      break;
    case "ask-user":
      st.setAskQuestion({ id: ev.id, question: ev.question, options: ev.options }, connSid ?? undefined);
      break;
    case "approval-result":
      // 弹窗已由 resolveApproval 关闭
      break;
    case "report":
      st.setReport(ev.content);
      break;
    case "attachments":
      // v3.1：附件挂到当前用户消息（附件行展示）
      st.handleAttachments(ev);
      break;
    case "todo-write":
      // v2.10：任务清单（Todo 面板）
      st.setTodos(ev.items);
      break;
    case "review":
      st.setReview(ev.content);
      break;
    case "plan":
      st.setPlan({ id: ev.id, content: ev.content });
      break;
    case "done":
      st.finishAssistant();
      if (ev.delivery) st.setDelivery(ev.delivery);
      // v2.13：usage 按会话存（视图切换后 StatsLine 显示该会话自己的数字）；
      // 非当前视图会话完成 → 额外刷新列表（侧栏 done 提醒）
      if (ev.usage) st.setUsageFor(connSid ?? st.activeSessionId ?? "", ev.usage);
      if (connSid && connSid !== useStore.getState().activeSessionId) {
        fetchSessions().catch(() => {});
      }
      // v3.1：任务正常完成 → 自动消费该会话队列下一条（停止/异常不消费——队列保留待用户处理）
      void consumeQueue(connSid);
      break;
    case "model-fallback":
      st.appendFallback(ev.from, ev.to, ev.reason);
      break;
    case "retry":
      // v3.2：断网/瞬时故障重试 → 运行状态行倒计时显示（当前视图会话直接显示）
      st.setRetry(connSid ?? st.activeSessionId ?? "", { attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, message: ev.message });
      break;
    case "context-compressed":
      st.appendCompressed(ev.before, ev.after, ev.summary);
      break;
    case "task-notification":
      // v3.3 后台任务完成通知（EventRow 通知行）
      st.appendTaskNotification({ taskType: ev.taskType, taskId: ev.taskId, name: ev.name, status: ev.status, summary: ev.summary });
      break;
    case "subagent-start":
      st.startSubagent(ev);
      break;
    case "subagent-done":
      st.finishSubagent(ev);
      break;
    case "agent-waiting":
      // v2.13：后台子 Agent 暂停等父级消息 → 线程追加等待提示（前端状态不失真）
      st.agentWaiting(ev);
      break;
    case "agent-resumed":
      st.agentResumed(ev);
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
  const res = await apiFetch("/api/worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "创建工作树失败");
  return data;
}

export async function mergeWorktree(root: string, name: string) {
  const res = await apiFetch(`/api/worktree/${encodeURIComponent(name)}/merge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "合并失败");
  return data;
}

/** v3.3 补 17：丢弃任务工作树（不合并直接清理——v3.6 死代码清理时误删的前端入口；
 *  后端 /api/worktree/:name/discard 一直在） */
export async function discardWorktree(root: string, name: string) {
  const res = await apiFetch(`/api/worktree/${encodeURIComponent(name)}/discard`, {
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
  const res = await apiFetch(`/api/plan/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "计划确认失败");
  return data;
}

/** v3.2 会话级全权放行开关（审批弹窗「本会话全部放行」；enabled=false 关闭） */
export async function setApprovalBypass(sessionId: string, enabled: boolean) {
  const res = await apiFetch("/api/approvals/bypass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, enabled }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "切换全权放行失败");
  return data;
}

/** v5.0（C1）：会话级临时联网开关（默认断网策略的轻量出口——npm install 等高频外传命令
 *  不再每次被拦；到期自动失效，命令审计照常） */
export async function egressAllow(sessionId: string, minutes = 10) {
  const res = await apiFetch("/api/egress/allow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, minutes }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "开启临时联网失败");
  return data;
}
export async function egressDisallow(sessionId: string) {
  const res = await apiFetch("/api/egress/allow", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "关闭临时联网失败");
  return data;
}

// ── v2.1 会话管理 ──

/** 会话列表（刷新 store） */
export async function fetchSessions(): Promise<SessionMeta[]> {
  const res = await apiFetch("/api/sessions");
  if (!res.ok) throw new Error(`会话列表加载失败: ${res.status}`);
  const data = await res.json();
  const sessions: SessionMeta[] = data.sessions ?? [];
  useStore.getState().setSessions(sessions);
  return sessions;
}

/** 会话详情（全量事件流 → 重放历史） */
export async function fetchSessionEvents(id: string): Promise<{ session: SessionMeta; events: StoredEvent[] }> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`会话加载失败: ${res.status}`);
  return res.json();
}

/** 删除会话 */
export async function deleteSession(id: string) {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "删除失败");
}

/** Rewind：回滚到检查点（seq 及之后的事件删除） */
/** v2.14 批 10：marker=false = 编辑截断（不落回滚标记，AI 无需感知）；默认 true = 回滚（AI 感知） */
export async function rewindSession(id: string, seq: number, marker = true) {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/rewind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seq, marker }),
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
    const res = await apiFetch("/api/sessions");
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
    const created = await apiFetch("/api/sessions", {
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
    const imported = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/events`, {
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

/**
 * 发起 Agent 任务（SSE 流式，支持停止；v2.1 绑定当前会话；v3.1 事件按连接会话路由）。
 * opts.sessionId：指定目标会话（后台队列消费用）；缺省 = 当前视图会话。
 * opts.root：后台队列消费用该会话自己的 root。
 * opts.attachments/files/images：v3.1 附件（文件内容 base64 上传暂存；图片 dataURL 走视觉）。
 */
export interface ChatAttachmentInput {
  name: string;
  kind: "file" | "dir" | "image";
  size?: number;
}
export interface ChatFileInput {
  name: string;
  rel: string; // 相对路径（文件夹内文件带目录结构）
  data: string; // base64 内容
}
export async function sendChat(
  prompt: string,
  opts?: {
    sessionId?: string | null;
    root?: string;
    attachments?: ChatAttachmentInput[];
    files?: ChatFileInput[];
    images?: string[];
    /** v3.0 批 12：桌面版附件路径引用（真实绝对路径，不复制内容） */
    paths?: string[];
    /** v5.1 补 4：临时联网剩余分钟数（随请求交给服务端对本会话生效——欢迎界面
     *  无会话时先选好时长，发送时原子绑定，无竞态） */
    egressMinutes?: number;
  }
): Promise<boolean> {
  const st = useStore.getState();
  // v3.1：本连接的目标会话（续跑 = 当前会话；新建 = 待 session 事件回传后绑定）
  let connSid: string | null = opts?.sessionId ?? st.activeSessionId ?? null;
  st.setEventTarget(connSid);
  st.addUserMsg(prompt);
  st.ensureAssistant();

  // v5.1 补 4：临时联网剩余分钟数（未显式传时从 store 取——排队消费/后台续跑同享；
  // 欢迎界面无会话时药丸先本地开启，发送时随本请求生效）
  const egressMinutes = opts?.egressMinutes ??
    (st.egressUntil && st.egressUntil > Date.now()
      ? Math.max(1, Math.ceil((st.egressUntil - Date.now()) / 60000))
      : undefined);

  // 停止支持：AbortController 存入 store，点击停止按钮时 abort
  const controller = new AbortController();
  st.setAbortController(controller);

  // 任务工作树模式：为每个任务创建独立 git worktree（主代码零污染）。
  // v3.1：后台队列消费用该会话自己的 root（opts.root），前台用当前视图 root
  let effectiveRoot = opts?.root ?? st.root;
  if (st.useWorktree) {
    try {
      const wt = await createWorktree(effectiveRoot);
      st.setWorktree(wt);
      effectiveRoot = wt.path;
    } catch (e) {
      st.addWorktreeNote(`工作树创建失败（${(e as Error).message}），已在原目录执行`);
      // v3.3 补 21：失败时清残留 worktree 状态——否则 persist 的旧路径（可能已删除）
      // 继续劫持代码/审查界面（查无效目录 → 空）
      st.setWorktree(null);
    }
  }

  try {
    const res = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        // v2.9：root = 会话归属目录（项目匹配/记忆）；execRoot = 执行目录（worktree 模式 = 临时工作树）
        // v2.13：续跑会话不传 root——服务端用会话自身 root（修复视图 root 与会话 root 脱钩时
        // 后台/续跑任务跑错目录；新会话才用视图 root）
        root: opts?.sessionId ? undefined : st.root,
        execRoot: effectiveRoot,
        modelId: st.modelId,
        // v2 思考级别（4 档，按模型实际级别数自动映射）
        thinkingLevel: st.thinkingLevel,
        // v2.1：绑定目标会话（null = 服务端新建并回传 session 事件）
        sessionId: opts?.sessionId ?? st.activeSessionId ?? undefined,
        // v3.1 附件：元数据（kind/name/size）+ 文件内容（base64，服务端暂存 ~/.infu/attachments/）+ 图片（dataURL 视觉）
        attachments: opts?.attachments,
        files: opts?.files,
        images: opts?.images,
        paths: opts?.paths,
        // v5.1 补 4：临时联网剩余分钟数（服务端对本会话 setEgressAllow——新会话/续跑均适用）
        egressMinutes,
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

       const parsed = takeSseFrames(buf);
       buf = parsed.remainder;
       const frames = parsed.frames;
       for (const frame of frames) {
         const data = readSseData(frame);
         if (data == null) continue;
         try {
           const ev = JSON.parse(data) as AgentEvent;
          // v3.1：session 事件绑定本连接会话 id（后续事件路由依据）
          if (ev.type === "session") connSid = ev.id;
          handleEvent(ev, connSid);
        } catch {
          /* 忽略坏帧 */
        }
      }
    }
    return true; // v2.13：成功（队列消费判断失败插回）
  } catch (e) {
    // v2.13：错误写入**本连接**会话（原实现读全局 eventTarget——并行时错误行写错会话）
    const errSid = connSid ?? st.activeSessionId ?? "";
    if ((e as Error).name === "AbortError") {
      useStore.getState().addErrorFor(errSid, "已手动停止任务");
    } else {
      useStore.getState().addErrorFor(errSid, (e as Error).message);
    }
    return false; // v2.13：失败（队列消费据此插回队首）
  } finally {
    // v2.13：只清理本连接的 controller/计划/收尾（原实现清全局——并行会话 stop 失效/计划卡被误清）
    if (connSid) useStore.getState().clearAbortController(connSid);
    useStore.getState().finishAssistantFor(connSid ?? st.activeSessionId ?? "");
    if (connSid) useStore.getState().clearPlanFor(connSid);
    // v4.0 审计修复（H1）：eventTarget 连接结束后重置——原实现只 set 从不 reset，
    // 任务结束后组件侧错误（审批失败/插件加载失败等 addError）永久路由到最后一个
    // 运行会话的缓存，用户无感知。重置后 targetId 回落 activeSessionId（当前视图）。
    // 安全：并行 run 的 SSE 事件每帧重新 setEventTarget（handleEvent 460 行），无影响。
    useStore.getState().setEventTarget(null);
    // 任务结束：重拉事件补全回滚锚点（实时流消息无 seqStart，重放后即可回滚）。
    // v2.13：被新 run 接管（队列连发 run2 已启动）→ 跳过重放（否则整体替换覆盖新 run 实时缓存）；
    // 后台会话 → 只写缓存（loadSessionCache，不污染视图全局字段）
    if (connSid && !useStore.getState().runningIds.includes(connSid)) {
      const cid = connSid; // 闭包内 let 收窄失效（.then 回调）——先固化
      fetchSessionEvents(cid)
        .then(({ events }) => {
          const stNow = useStore.getState();
          if (cid === stNow.activeSessionId) stNow.loadSession(events, cid);
          else stNow.loadSessionCache(events, cid);
        })
        .catch(() => {});
    }
    // 会话列表刷新（新会话/状态更新）
    fetchSessions().catch(() => {});
    // v3.1：队列消费只由 done 事件驱动（正常完成才消费；停止/异常保留队列）
  }
}

/** v3.1 排队消费：会话空闲时取队首自动发送（连续消费直到队列空） */
async function consumeQueue(sid: string | null) {
  if (!sid) return;
  const st = useStore.getState();
  if (st.runningIds.includes(sid)) return; // 仍在跑（如旧连接刚 abort 新连接已接管）不重复消费
  const item = st.shiftQueue(sid);
  if (item) {
    // 用该会话自己的 root（后台消费时视图 root 可能指向其他会话）
    const meta = st.sessions.find((s) => s.id === sid);
    const ok = await sendChat(item.text, { sessionId: sid, root: meta?.root ?? undefined });
    // v2.13：发送失败（网络/异常）→ 队列项插回队首（原实现 shift 后即丢，失败永久丢失）
    if (!ok && !useStore.getState().runningIds.includes(sid)) {
      useStore.getState().unshiftQueue(sid!, item);
    }
  }
}

// ── v2.6.1 项目注册表 + 会话管理（侧栏会话中枢数据源）──

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  sessionCount: number;
  recentSessions: SessionMeta[];
}

/** 项目列表（注册表 + 各项目未归档会话统计与最近会话） */
export async function fetchProjects(): Promise<ProjectInfo[]> {
  const res = await apiFetch("/api/projects");
  if (!res.ok) throw new Error(`项目列表加载失败: ${res.status}`);
  const data = await res.json();
  return data.projects ?? [];
}

/** 创建项目（注册文件夹；root 必须为已存在目录） */
export async function createProjectApi(root: string, name?: string): Promise<void> {
  const res = await apiFetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root, name }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "创建项目失败");
}

/** 移除项目（只删注册；会话保留为自由会话，文件夹不删） */
export async function removeProjectApi(id: string): Promise<void> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "移除项目失败");
}

/** 会话管理：重命名 / 顶置 / 归档（PATCH /api/sessions/:id） */
export async function updateSessionApi(
  id: string,
  body: { title?: string; pinned?: boolean; archived?: boolean }
): Promise<void> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "更新会话失败");
}

// ── v2.9 审查（审查式：文件列表 + 行级 diff）──

export interface ReviewFileInfo {
  path: string;
  added: number;
  removed: number;
}

/** 审查文件列表（改动文件 + 增删行数；含未跟踪新文件） */
// v3.3 补 21：返回 { files, git }——git=false（非 git 仓库）供前端提示「无 diff 可看」
export async function fetchReviewFiles(root: string): Promise<{ files: ReviewFileInfo[]; git: boolean }> {
  const res = await apiFetch(`/api/review/files?root=${encodeURIComponent(root)}`);
  const data = await res.json();
  // v3.3 补 21：root 无效（400）抛错（ReviewPane catch 回退项目根）；
  // 非 git 仓库是 ok:true + git:false（200），正常返回不抛
  if (!res.ok || data.ok === false) throw new Error(data.message || "审查文件列表加载失败");
  return { files: data.files ?? [], git: data.git !== false };
}

/** v3.3 补 23：一键初始化 git 仓库（审查界面非 git 提示按钮） */
export async function gitInitProject(root: string): Promise<{ ok: boolean; message: string }> {
  const res = await apiFetch("/api/git-init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || "git init 失败");
  return data;
}

/** 单文件 unified diff 文本（未跟踪文件 = 全新增行） */
export async function fetchReviewFileDiff(root: string, path: string): Promise<string> {
  const res = await apiFetch(`/api/review/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  const data = await res.json();
  // v4.0 审计修复（L3）：失败必须抛错——原返回 "" 使 ReviewPane 的 catch 分支永不
  // 命中，401/400 显示为「该文件无改动」（误导）
  if (!res.ok || data.ok === false) throw new Error(data.message || `diff 加载失败: ${res.status}`);
  return data.diff ?? "";
}

// ── v2.9 代码界面（项目代码浏览器：文件树 + 内容预览）──

export interface FsTreeFile {
  path: string;
  added: number;
  removed: number;
  untracked: boolean;
}

/** 项目文件树（git 已跟踪 + 未跟踪 + 改动统计；非 git 递归扫描） */
export async function fetchFsTree(root: string): Promise<FsTreeFile[]> {
  const res = await apiFetch(`/api/fs/tree?root=${encodeURIComponent(root)}`);
  const data = await res.json();
  // v3.3 补 21：root 无效（400）必须抛错——CodeView 靠 catch 回退项目根；
  // 返回 [] 会让回退逻辑静默失效（用户实测代码界面仍空）
  if (!res.ok || data.ok === false) throw new Error(data.message || "文件树加载失败");
  return data.files ?? [];
}

/** 文件内容（超大/二进制提示） */
export async function fetchFsFile(
  root: string,
  path: string
): Promise<{ content: string; binary?: boolean; size?: number; truncated?: boolean }> {
  const res = await apiFetch(`/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  const data = await res.json();
  // v4.0 审计修复（L3）：失败必须抛错（与 fetchFsTree 同款）——原返回空内容使
  // CodeView 的 catch 分支永不命中，401/400 显示为「空文件」（误导）
  if (!res.ok || data.ok === false) throw new Error(data.message || `文件加载失败: ${res.status}`);
  return data;
}
