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
}

/** 风险级别（审批挂钩） */
export type RiskLevel = "low" | "medium" | "high";

/** 分层编排的阶段 */
export type PhaseId = "planner" | "executor" | "reviewer";

/** 分层编排模式：off=单 Agent；plan=Planner→Executor；full=Planner→Executor→Reviewer */
export type OrchestrateMode = "off" | "plan" | "full";

/** Agent 过程事件（CLI 打印 / SSE 推送前端；v2.1 起全量落库 ~/.infu/infu.db） */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "step-start"; step: number }
  | { type: "phase-start"; phase: PhaseId; label: string; /** v2.2：该阶段实际使用的模型（角色路由后） */ model?: string }
  | { type: "tool-start"; tool: string; args: Record<string, unknown>; risk: RiskLevel; callId?: string }
  | { type: "tool-result"; tool: string; ok: boolean; summary: string; callId?: string }
  | { type: "approval-required"; id: string; description: string; risk: RiskLevel }
  | { type: "approval-result"; id: string; approved: boolean }
  | { type: "report"; content: string }
  | { type: "review"; content: string }
  | { type: "plan"; id: string; content: string }
  | { type: "done"; text: string; toolCount: number; steps: number }
  | { type: "error"; message: string }
  // ── v2.2 模型可靠性新增 ──
  /** 模型降级切换（主模型失败 → 备用模型；Timeline 展示与审计） */
  | { type: "model-fallback"; from: string; to: string; reason: string }
  /** 上下文压缩（v2.2：历史超预算时摘要化，before/after 为估算 token；DB 事件流无损） */
  | { type: "context-compressed"; before: number; after: number; summary: string }
  // ── v2.1 会话持久化新增 ──
  /** SSE 首帧：回传新会话 id（Web 端绑定 activeSessionId） */
  | { type: "session"; id: string }
  /** 用户消息（服务端落库/重放历史用；模型不消费） */
  | { type: "user-message"; text: string };

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
