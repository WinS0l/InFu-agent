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

/** 用户可配置的模型（存 ~/.infu/config.json，API Key 不入库） */
export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderKind;
  /** 模型 ID，如 gpt-5、claude-sonnet-4.5、deepseek-v3.2、glm-4.6 */
  model: string;
  /** 自定义端点（custom 必需；ollama 默认 http://localhost:11434/v1） */
  baseURL?: string;
  /** 可选；为空时读环境变量 INFU_<PROVIDER>_API_KEY */
  apiKey?: string;
  /** 能力探测结果（可选，运行时推断） */
  capabilities?: {
    toolCalling?: boolean;
    vision?: boolean;
    streaming?: boolean;
  };
}

/** 全局配置（v2.1 schema 基础：version 字段 + 未知字段保留前向兼容） */
export interface InfuConfig {
  models: ModelConfig[];
  defaultModelId?: string;
  /** 配置 schema 版本（v2.1 起写入；v2.4 权限/沙箱设置升级时递增） */
  version?: number;
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
  | { type: "phase-start"; phase: PhaseId; label: string }
  | { type: "tool-start"; tool: string; args: Record<string, unknown>; risk: RiskLevel; callId?: string }
  | { type: "tool-result"; tool: string; ok: boolean; summary: string; callId?: string }
  | { type: "approval-required"; id: string; description: string; risk: RiskLevel }
  | { type: "approval-result"; id: string; approved: boolean }
  | { type: "report"; content: string }
  | { type: "review"; content: string }
  | { type: "plan"; id: string; content: string }
  | { type: "done"; text: string; toolCount: number; steps: number }
  | { type: "error"; message: string }
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
  maxSteps?: number;
  /** 分层编排模式（默认 full） */
  orchestrate?: OrchestrateMode;
  /** Planner 计划是否需用户确认后执行（默认 true） */
  planApproval?: boolean;
  /** 建议模式：模型只出方案，不执行任何工具 */
  suggestOnly?: boolean;
}

// ── v2.1 配置 schema（zod 校验 + 默认值合并；passthrough 保留未知字段，前向兼容 v2.4 权限/沙箱设置）──
import { z } from "zod";

const modelConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.enum(["openai", "anthropic", "google", "deepseek", "zhipu", "qwen", "ollama", "custom"]),
    model: z.string().min(1),
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
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

/** InfuConfig 校验 schema（未知字段保留；version 缺省补 1） */
export const infuConfigSchema = z
  .object({
    models: z.array(modelConfigSchema).default([]),
    defaultModelId: z.string().optional(),
    version: z.number().int().positive().default(1),
  })
  .passthrough();

/** 校验并归一化配置：返回 { ok:true, config } 或 { ok:false, error }（损坏文件不抛异常，由调用方备份处理） */
export function parseInfuConfig(raw: unknown): { ok: true; config: InfuConfig } | { ok: false; error: string } {
  const r = infuConfigSchema.safeParse(raw);
  if (!r.success) {
    // 只报第一条错误，消息保持简洁（zod v4 的 issues 数组）
    const issue = r.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${issue?.message ?? "配置格式错误"}` };
  }
  return { ok: true, config: r.data as unknown as InfuConfig };
}
