/**
 * @infu/shared — 共享类型定义（前后端 + Agent 单一来源）
 */

/** 模型供应商类型（InFu 支持任意大模型） */
export type ProviderKind =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "zhipu"      // 智谱 GLM（OpenAI 兼容端点）
  | "qwen"       // 通义千问（OpenAI 兼容端点）
  | "ollama"     // 本地模型
  | "custom";    // 任意 OpenAI 兼容端点

/**
 * 供应商凭据（v2 模型管理重构）：一份 API Key 挂多个模型。
 * providers[] 存凭据与端点，models[] 通过 providerId 引用。
 */
export interface ProviderConfig {
  /** 唯一标识（如 "deepseek"；custom 多端点时 "custom-1"） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 供应商类型（模板/默认端点/思考参数映射依据） */
  kind: ProviderKind;
  /** 自定义端点（custom 必需；其余缺省走默认端点） */
  baseURL?: string;
  /** 可选；为空时读环境变量 INFU_<KIND>_API_KEY */
  apiKey?: string;
}

/** 用户可配置的模型（v2：经 providerId 引用供应商凭据；存 ~/.infu/config.json，Key 只在 providers[]） */
export interface ModelConfig {
  id: string;
  name: string;
  /** 上游模型 ID，如 deepseek-v4-flash、gpt-5.6-luna、glm-5.2 */
  model: string;
  /** v2：所属供应商 id（providers[]）；v1 旧配置迁移后必有 */
  providerId?: string;
  /** v1 遗留：内嵌供应商信息（未迁移的旧配置兼容读取；新配置勿用） */
  provider?: ProviderKind;
  /** v1 遗留：内嵌端点 */
  baseURL?: string;
  /** v1 遗留：内嵌 API Key（v2 起凭据只存 providers[]） */
  apiKey?: string;
  /** 上下文窗口大小（token，上下文压缩预算依据；缺省按 kind/模型名推断） */
  contextWindow?: number;
  /** 实际推理级别数（思考级别 4 档 UI 的映射依据；1=无思考；模板自动填可改） */
  thinkingLevels?: number;
  /**
   * 思考参数覆盖（小众/自定义模型专用）：每档级别对应的请求体参数，
   * 数组第 i 项 = 第 i 级注入的字段（null = 该级不注入）；长度与 thinkingLevels 对齐，
   * 缺省走供应商协议自动映射。示例：[{"thinking":{"type":"disabled"}},{"thinking":{"type":"enabled"}},null]
   */
  thinkingOverride?: Array<Record<string, unknown> | null>;
  /** 备用模型 id 列表（v2.2 降级链：主模型失败时依次切换；引用 config 中其他模型） */
  fallbackModelIds?: string[];
  /** 适配角色（v2.2 轻量模型选择：声明该模型可担任的角色；低于 config 级 roles 显式指定） */
  roles?: Array<"planner" | "executor" | "reviewer">;
  /** 能力探测结果（可选，运行时推断） */
  capabilities?: {
    toolCalling?: boolean;
    vision?: boolean;
    streaming?: boolean;
  };
}

/** 角色模型引用：模型 id，或 {model, thinkingLevel}（角色独立思考级别） */
export type RoleModelRef = string | { model: string; thinkingLevel?: number };

// ── v2.3 MCP 服务器（扩展机制：MCP 客户端作为第一个插件类型）──

/** MCP 服务器传输类型：stdio = 本地子进程；http = 远程 Streamable HTTP 端点 */
export type McpServerType = "stdio" | "http";

/**
 * MCP 服务器配置（v2.3：工具动态注入 Agent 循环）。
 * 安全：MCP 工具默认 medium 审批（防 prompt 注入投毒），riskOverrides 可按工具名/前缀覆盖。
 */
export interface McpServerConfig {
  /** 唯一标识（如 "filesystem"） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 传输类型：stdio（本地命令）/ http（远程端点） */
  type: McpServerType;
  /** stdio 模式：启动命令（如 "npx"；Windows 下 npx 需写 npx.cmd，或用完整 node 路径） */
  command?: string;
  /** stdio 模式：命令参数（如 ["-y", "@modelcontextprotocol/server-filesystem", "C:\\workspace"]） */
  args?: string[];
  /** http 模式：Streamable HTTP 端点 URL */
  url?: string;
  /** 传给 MCP 服务器进程的环境变量（可选；敏感值会随 config.json 存储，仅 0600 本地） */
  env?: Record<string, string>;
  /** 是否启用（默认 true；禁用时不连接不注入） */
  enabled?: boolean;
  /**
   * 风险覆盖：工具名（精确）或前缀 + "*"（通配）→ 风险级别；未命中默认 medium。
   * 示例：{"read*": "low", "write_file": "high"}
   */
  riskOverrides?: Record<string, RiskLevel>;
}

/** MCP 工具元信息（探测/展示用：Web 工具列表与风险徽标） */
export interface McpToolMeta {
  name: string;
  description: string;
  risk: RiskLevel;
}

// ── v2.3 批 2 插件系统架构 v1（从 MCP 适配器实例反推的插件协议）──

/**
 * 插件配置（config.plugins[]）：引用 JS/TS 插件模块（opencode 式）。
 * 插件 = 可注册 工具/钩子/技能 的包；MCP 服务器是插件协议的另一个实例（独立通道）。
 */
export interface PluginConfig {
  /** 唯一标识（如 "my-plugin"） */
  id: string;
  /** 插件模块路径（目录或文件；.ts/.mjs/.js；动态 import） */
  path: string;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

/** 钩子输入（工具调用上下文；pre/postToolUse 通用） */
export interface ToolHookInput {
  tool: string;
  args: Record<string, unknown>;
  callId?: string;
  risk: RiskLevel;
  /** 编排阶段（直接模式无） */
  phase?: PhaseId;
}

/** PreToolUse 钩子结果：allow 放行（可改 args）/ block 拦截（reason 给模型） */
export interface PreToolUseResult {
  decision: "allow" | "block";
  reason?: string;
  args?: Record<string, unknown>;
}

/** PostToolUse 钩子结果：可改写返回给模型的工具结果文本 */
export interface PostToolUseResult {
  result?: string;
}

/** 钩子函数（插件内注册；抛错不阻塞主流程——emit 错误事件后放行） */
export type HookFn = (input: ToolHookInput) => Promise<PreToolUseResult | PostToolUseResult | void>;

/**
 * 插件定义（JS/TS 模块默认导出；opencode 式）。
 * tools 可为数组或函数（动态生成，便于引用 MCP 连接等运行时资源）。
 */
export interface PluginDef {
  id: string;
  name: string;
  description: string;
  version?: string;
  /** 注册的工具（ToolDef 数组或延迟生成函数）；工具 risk 缺失默认 medium */
  tools?: ToolDef[] | (() => ToolDef[]);
  /** 钩子（v2.3 批 2：preToolUse/postToolUse；插件级，对所有工具生效） */
  hooks?: {
    preToolUse?: HookFn;
    postToolUse?: HookFn;
  };
  /** 附加的 skill 目录（SKILL.md 所在目录的绝对路径列表） */
  skills?: string[];
}

/** SKILL.md 元信息（发现层：描述常驻 system；激活层：use_skill 读全文） */
export interface SkillMeta {
  name: string;
  description: string;
  /** SKILL.md 文件绝对路径 */
  path: string;
  /** 来源层级：用户级 > 项目级（同名首个胜出） */
  level: "user" | "project" | "config";
}

/** skill 显式配置（config.skills[]：引用项目内或任意路径的 skill 目录） */
export interface SkillConfig {
  name: string;
  /** skill 目录路径（含 SKILL.md；缺省 = 按 name 在用户/项目级目录查找） */
  path?: string;
}

// ── v2.4 设置界面（权限等级 / 沙箱等级 / 常规 / 外观；全部可选节，passthrough 兼容）──

/** 全局审批档位：auto=非人工必需全自动放行；smart=低风险自动、中/高人工（默认）；confirm=全部人工 */
export type ApprovalMode = "auto" | "smart" | "confirm";

/** 工具级风险/禁用覆盖（工具名精确 或 前缀*通配；与 MCP riskOverrides 同模式） */
export interface ToolRiskOverride {
  /** 工具名（如 "run_command"）或前缀通配（如 "git*"） */
  tool: string;
  /** 覆盖为指定风险（缺省 = 保留工具声明） */
  risk?: RiskLevel;
  /** 禁用该工具（命中即拒绝执行；对全部工具含 MCP/插件生效） */
  disabled?: boolean;
}

/** 权限等级配置（v2.4：审批模式/按工具覆盖/命令白名单） */
export interface ApprovalPolicyConfig {
  /** 全局审批档位（缺省 smart） */
  mode?: ApprovalMode;
  /** 工具级覆盖列表（精确名 > 前缀* > 默认；按声明顺序，首个命中生效） */
  toolOverrides?: ToolRiskOverride[];
  /** 命令白名单（通配符 * 匹配任意字符序列；命中白名单的命令跳过高危命令审批；联网 requireExplicit 永不豁免） */
  commandAllowlist?: string[];
}

/** 沙箱等级配置（v2.4：取代 INFU_SANDBOX 环境变量；off/L1/L1.5/L2/自动） */
export interface SandboxConfig {
  /** auto=按可用性自动选择（docker → win 受限 → 软沙箱）；off=直连；soft=L1 纯软；restricted=L1.5 Windows 受限；docker=L2 容器 */
  mode?: "auto" | "off" | "soft" | "restricted" | "docker";
}

/** 常规设置（v2.4：Web 默认值） */
export interface GeneralConfig {
  /** 默认项目根目录（Web 输入框初始值） */
  defaultRoot?: string;
}

/** 外观设置（v2.4：Web 界面偏好，随配置持久化） */
export interface AppearanceConfig {
  /** 界面字号（缺省 sm） */
  fontSize?: "xs" | "sm" | "base";
  /** 流式输出光标动画（缺省 true） */
  streamCursor?: boolean;
}

/** 全局配置（v2：providers[] 凭据 + models[] 引用；未知字段保留前向兼容） */
export interface InfuConfig {
  /** 配置 schema 版本（v2 = 供应商凭据两级结构） */
  version?: number;
  /** v2：供应商凭据列表（v1 配置自动迁移生成） */
  providers?: ProviderConfig[];
  models: ModelConfig[];
  defaultModelId?: string;
  /** 按角色指定模型（轻量模型选择：planner/executor/reviewer 可分别用不同模型与思考级别） */
  roles?: {
    planner?: RoleModelRef;
    executor?: RoleModelRef;
    reviewer?: RoleModelRef;
  };
  /** v2.3：MCP 服务器列表（工具动态注入 Agent 循环；默认 medium 审批，riskOverrides 可覆盖） */
  mcpServers?: McpServerConfig[];
  /** v2.3 批 2：JS/TS 插件列表（可注册工具/钩子/技能；配置即信任） */
  plugins?: PluginConfig[];
  /** v2.3 批 2：skill 显式引用（缺省按 name 在 ~/.infu/skills 与项目 .infu/skills 查找） */
  skills?: SkillConfig[];
  /** v2.4：权限等级设置（审批档位/工具覆盖/命令白名单） */
  approvalPolicy?: ApprovalPolicyConfig;
  /** v2.4：沙箱等级设置（取代 INFU_SANDBOX 环境变量） */
  sandbox?: SandboxConfig;
  /** v2.4：常规设置 */
  general?: GeneralConfig;
  /** v2.4：外观设置 */
  appearance?: AppearanceConfig;
}

/** 风险级别（审批挂钩） */
export type RiskLevel = "low" | "medium" | "high";

/** 分层编排的阶段 */
export type PhaseId = "planner" | "executor" | "reviewer";

/** 分层编排模式：off=单 Agent；plan=Planner→Executor；full=Planner→Executor→Reviewer */
export type OrchestrateMode = "off" | "plan" | "full";

/**
 * Agent 过程事件（CLI 打印 / SSE 推送前端；v2.1 起全量落库 ~/.infu/infu.db）。
 * v2.5：过程事件（text/step/tool/审批/降级/压缩）可携带可选 `subagentId`——
 * 子智能体委派（delegate_task 内部事件打标，用于审计归属；UI 不再内嵌展示内部过程）。
 */
export type AgentEvent =
  | { type: "text"; text: string; subagentId?: string }
  | { type: "reasoning"; text: string; subagentId?: string }
  | { type: "step-start"; step: number; subagentId?: string }
  | { type: "phase-start"; phase: PhaseId; label: string; /** v2.2：该阶段实际使用的模型（角色路由后） */ model?: string; subagentId?: string }
  | { type: "tool-start"; tool: string; args: Record<string, unknown>; risk: RiskLevel; callId?: string; subagentId?: string }
  | { type: "tool-result"; tool: string; ok: boolean; summary: string; callId?: string; subagentId?: string }
  | { type: "approval-required"; id: string; description: string; risk: RiskLevel; subagentId?: string }
  | { type: "approval-result"; id: string; approved: boolean; subagentId?: string }
  | { type: "report"; content: string }
  | { type: "review"; content: string }
  | { type: "plan"; id: string; content: string }
  | { type: "done"; text: string; toolCount: number; steps: number }
  | { type: "error"; message: string }
  // ── v2.2 模型可靠性新增 ──
  /** 模型降级切换（主模型失败 → 备用模型；Timeline 展示与审计） */
  | { type: "model-fallback"; from: string; to: string; reason: string; subagentId?: string }
  /** 上下文压缩（v2.2：历史超预算时摘要化，before/after 为估算 token；DB 事件流无损） */
  | { type: "context-compressed"; before: number; after: number; summary: string; subagentId?: string }
  // ── v2.5 子智能体委派新增 ──
  /** 子智能体启动（delegate_task 委派；parentCallId 关联父级委派工具调用的 callId；readOnly=只读委派免审批） */
  | { type: "subagent-start"; id: string; name: string; prompt: string; parentCallId?: string; model?: string; readOnly?: boolean }
  /** 子智能体完成（结果回收：最终摘要文本/步数/工具次数） */
  | { type: "subagent-done"; id: string; text: string; steps: number; toolCount: number; ok: boolean }
  // ── v2.1 会话持久化新增 ──
  /** SSE 首帧：回传新会话 id（Web 端绑定 activeSessionId） */
  | { type: "session"; id: string }
  /** 用户消息（服务端落库/重放历史用；模型不消费） */
  | { type: "user-message"; text: string };

/** 运行时模型信息（v2.5：ToolContext 携带，子智能体委派解析子模型用；结构同 registry toRuntimeModel 返回值） */
export interface RuntimeModelInfo {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey: string;
  contextWindow?: number;
  thinkingLevels?: number;
  thinkingOverride?: Array<Record<string, unknown> | null>;
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 项目根目录（工具操作边界） */
  root: string;
  /** 当前工作目录 */
  cwd: string;
  /**
   * 审批请求（Web UI 挂接；CLI 可自动批准）
   * requireExplicit：联网放行等必须人工确认的场景——-y 自动批准也不放行（默认 false）
   */
  requestApproval: (
    description: string,
    risk: RiskLevel,
    requireExplicit?: boolean
  ) => Promise<boolean>;
  /** 事件推送 */
  emit: (event: AgentEvent) => void;
  // ── v2.5 子智能体委派（runAgent 填充；delegate_task 解析子模型/深度限制）──
  /** 当前 Agent 的模型配置（子智能体缺省继承；modelId 显式指定时覆盖） */
  modelConfig?: RuntimeModelInfo;
  /** 备用模型降级链（子智能体继承父级） */
  fallbackModelConfigs?: RuntimeModelInfo[];
  /** 思考级别（4 档 UI；子智能体继承，agent 文件 thinkingLevel 可覆盖） */
  thinkingLevel?: number;
  /** 委派深度（0=顶层；子智能体 +1；超 MAX_DELEGATION_DEPTH 拒绝再委派） */
  delegationDepth?: number;
  /** 中止信号（子智能体循环跟随父级） */
  abortSignal?: AbortSignal;
  /** v2.5：当前工具调用的 callId（loop 每次 execute 前填充；delegate_task 作 subagent-start 的 parentCallId） */
  callId?: string;
}

/** 工具定义（统一接口） */
export interface ToolDef {
  name: string;
  description: string;
  /** zod schema：参数校验 */
  schema: import("zod").ZodType<any, any, any>;
  /** 风险级别：low=直接执行；medium/high=需审批 */
  risk: RiskLevel;
  /** 执行函数，返回给模型的文本结果 */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

/** 模板任务的参数占位字段（小白引导：填写后渲染进 prompt） */
export interface TemplateField {
  name: string;
  label: string;
  placeholder?: string;
  default?: string;
}

/** 模板任务定义（小白引导：一键初始化项目 / 修复测试失败等） */
export interface TaskTemplate {
  id: string;
  name: string;
  /** 分类：初始化 / 修复 / 分析 / 开发 */
  category: string;
  description: string;
  /** 提示词模板，支持 {fieldName} 占位符 */
  prompt: string;
  fields?: TemplateField[];
}

/** 渲染模板 prompt：替换 {fieldName} 占位符（缺失字段用默认值或空串） */
export function renderTemplate(tpl: TaskTemplate, values: Record<string, string>): string {
  let out = tpl.prompt;
  for (const f of tpl.fields ?? []) {
    const v = (values[f.name] ?? f.default ?? "").trim();
    out = out.split(`{${f.name}}`).join(v);
  }
  // 兜底：values 中未定义在 fields 里的键也直接替换，防残留占位符
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}

// ── v2.1 会话持久化（服务端 / Web 共享的 API 形状）──

/** 会话状态（Web 列表徽标 / 继续会话判断） */
export type SessionStatus = "running" | "done" | "error" | "stopped";

/** 会话元数据（列表项 / 详情） */
export interface SessionMeta {
  id: string;
  title: string;
  root: string;
  modelId?: string;
  mode?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  /** 统计（列表展示用） */
  eventCount: number;
  toolCount: number;
  promptCount: number;
}

/** 事件流条目（seq 全局有序；ts 为事件时间戳） */
export interface StoredEvent {
  seq: number;
  ts: number;
  event: AgentEvent;
}

/** /api/chat 任务请求体 */
export interface TaskRequest {
  prompt: string;
  /** 项目根目录（Agent 操作边界） */
  root?: string;
  modelId?: string;
  /** 思考级别（v2 模型管理：4 档 UI，按模型实际级别数自动映射；1-4，缺省 2） */
  thinkingLevel?: number;
  /** 备用模型 id 列表（v2.2 降级链，覆盖模型自身 fallbackModelIds） */
  fallbackModelIds?: string[];
  /** 按角色指定模型（v2.2 轻量模型选择：planner/executor/reviewer 模型 id，覆盖 config roles） */
  roleModelIds?: {
    planner?: string;
    executor?: string;
    reviewer?: string;
  };
  maxSteps?: number;
  /** 分层编排模式（默认 full） */
  orchestrate?: OrchestrateMode;
  /** Planner 计划是否需用户确认后执行（默认 true） */
  planApproval?: boolean;
  /** 建议模式：模型只出方案，不执行任何工具 */
  suggestOnly?: boolean;
}

// ── v2 配置 schema（供应商凭据两级结构；passthrough 保留未知字段）──
import { z } from "zod";

const providerConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["openai", "anthropic", "google", "deepseek", "zhipu", "qwen", "ollama", "custom"]),
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .passthrough();

const modelConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    model: z.string().min(1),
    providerId: z.string().optional(),
    // v1 遗留字段（兼容读取；新配置勿用）
    provider: z.enum(["openai", "anthropic", "google", "deepseek", "zhipu", "qwen", "ollama", "custom"]).optional(),
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    thinkingLevels: z.number().int().positive().optional(),
    thinkingOverride: z.array(z.record(z.string(), z.unknown()).nullable()).optional(),
    fallbackModelIds: z.array(z.string()).optional(),
    roles: z.array(z.enum(["planner", "executor", "reviewer"])).optional(),
    capabilities: z
      .object({
        toolCalling: z.boolean().optional(),
        vision: z.boolean().optional(),
        streaming: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const roleModelRefSchema = z.union([
  z.string().min(1),
  z.object({ model: z.string().min(1), thinkingLevel: z.number().int().min(1).max(4).optional() }).passthrough(),
]);

/** MCP 服务器配置 schema（v2.3：工具动态注入 Agent 循环；passthrough 保留未知字段） */
const mcpServerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["stdio", "http"]).default("stdio"),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    riskOverrides: z.record(z.string(), z.enum(["low", "medium", "high"])).optional(),
  })
  .passthrough();

/** 插件配置 schema（v2.3 批 2：JS/TS 模块引用；配置即信任） */
const pluginConfigSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    enabled: z.boolean().optional(),
  })
  .passthrough();

/** skill 显式引用 schema（v2.3 批 2） */
const skillConfigSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().optional(),
  })
  .passthrough();

// ── v2.4 设置界面 schema（权限等级 / 沙箱等级 / 常规 / 外观；export 供 API 校验）──

const toolRiskOverrideSchema = z
  .object({
    tool: z.string().min(1),
    risk: z.enum(["low", "medium", "high"]).optional(),
    disabled: z.boolean().optional(),
  })
  .passthrough();

export const approvalPolicySchema = z
  .object({
    mode: z.enum(["auto", "smart", "confirm"]).optional(),
    toolOverrides: z.array(toolRiskOverrideSchema).optional(),
    commandAllowlist: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export const sandboxConfigSchema = z
  .object({
    mode: z.enum(["auto", "off", "soft", "restricted", "docker"]).optional(),
  })
  .passthrough();

export const generalConfigSchema = z
  .object({
    defaultRoot: z.string().optional(),
  })
  .passthrough();

export const appearanceConfigSchema = z
  .object({
    fontSize: z.enum(["xs", "sm", "base"]).optional(),
    streamCursor: z.boolean().optional(),
  })
  .passthrough();

/** InfuConfig 校验 schema（未知字段保留；version 缺省补 1） */
export const infuConfigSchema = z
  .object({
    models: z.array(modelConfigSchema).default([]),
    providers: z.array(providerConfigSchema).optional(),
    defaultModelId: z.string().optional(),
    roles: z
      .object({
        planner: roleModelRefSchema.optional(),
        executor: roleModelRefSchema.optional(),
        reviewer: roleModelRefSchema.optional(),
      })
      .passthrough()
      .optional(),
    mcpServers: z.array(mcpServerSchema).optional(),
    plugins: z.array(pluginConfigSchema).optional(),
    skills: z.array(skillConfigSchema).optional(),
    approvalPolicy: approvalPolicySchema.optional(),
    sandbox: sandboxConfigSchema.optional(),
    general: generalConfigSchema.optional(),
    appearance: appearanceConfigSchema.optional(),
    version: z.number().int().positive().default(1),
  })
  .passthrough();

/**
 * v1 → v2 迁移（模型管理重构）：旧 models[]（自带 provider/baseURL/apiKey）
 * 按 kind+baseURL 归并为 providers[]，模型条目经 providerId 引用。
 * - API Key 从模型层迁到供应商层（v2 起模型不再存 key）
 * - defaultModelId / roles / fallbackModelIds / contextWindow 等保留
 * - 幂等：已是 v2（providers 非空）时原样返回
 */
export function migrateConfigV1(raw: unknown): InfuConfig {
  const r = infuConfigSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    throw new Error(`${where}${issue?.message ?? "配置格式错误"}`);
  }
  const cfg = r.data as unknown as InfuConfig;
  if (cfg.providers?.length) return cfg; // 已是 v2

  const providers: ProviderConfig[] = [];
  const providerByKey = new Map<string, ProviderConfig>();
  const seenKinds = new Map<string, number>();
  for (const m of cfg.models) {
    const kind = m.provider ?? "custom";
    const baseURL = m.baseURL;
    const pkey = `${kind}|${baseURL ?? ""}`;
    let p = providerByKey.get(pkey);
    if (!p) {
      const n = (seenKinds.get(kind) ?? 0) + 1;
      seenKinds.set(kind, n);
      p = {
        id: n === 1 ? kind : `${kind}-${n}`,
        name: kind === "custom" ? `自定义 ${n}` : baseURL ? `${kind} (${baseURL})` : kind,
        kind: kind as ProviderKind,
        baseURL,
        apiKey: m.apiKey,
      };
      providerByKey.set(pkey, p);
      providers.push(p);
    } else if (!p.apiKey && m.apiKey) {
      p.apiKey = m.apiKey; // 同供应商内后出现的 key 补充
    }
  }

  const models: ModelConfig[] = cfg.models.map((m) => {
    const pkey = `${m.provider ?? "custom"}|${m.baseURL ?? ""}`;
    const p = providerByKey.get(pkey)!;
    const { provider: _p, baseURL: _b, apiKey: _k, ...rest } = m;
    return { ...rest, providerId: p.id };
  });
  return { ...cfg, version: 2, providers, models };
}

/** 校验并归一化配置：返回 { ok:true, config } 或 { ok:false, error }（损坏文件不抛异常，由调用方备份处理） */
export function parseInfuConfig(raw: unknown): { ok: true; config: InfuConfig } | { ok: false; error: string } {
  const r = infuConfigSchema.safeParse(raw);
  if (!r.success) {
    // 只报第一条错误，消息保持简洁（zod v4 的 issues 数组）
    const issue = r.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${issue?.message ?? "配置格式错误"}` };
  }
  try {
    // v1 旧结构（models 自带 provider/baseURL/apiKey）→ 在线迁移为 v2（providers + providerId 引用）
    return { ok: true, config: migrateConfigV1(r.data) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
