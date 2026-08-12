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

/** 全局配置 */
export interface InfuConfig {
  models: ModelConfig[];
  defaultModelId?: string;
  /**
   * 网络出站控制（M6，Windows）——`infu sandbox-net setup` 写入：
   * 沙箱命令默认以断网账号运行（WFP 拦截出站），联网需审批放行
   */
  sandboxNet?: {
    /** 是否启用（默认 true；INFU_SANDBOX_NET=0 或 false 时沙箱命令走当前用户受限令牌） */
    enabled?: boolean;
  };
}

/** 风险级别（审批挂钩） */
export type RiskLevel = "low" | "medium" | "high";

/** 分层编排的阶段 */
export type PhaseId = "planner" | "executor" | "reviewer";

/** 分层编排模式：off=单 Agent；plan=Planner→Executor；full=Planner→Executor→Reviewer */
export type OrchestrateMode = "off" | "plan" | "full";

/** Agent 过程事件（CLI 打印 / SSE 推送前端） */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "step-start"; step: number }
  | { type: "phase-start"; phase: PhaseId; label: string }
  | { type: "tool-start"; tool: string; args: Record<string, unknown>; risk: RiskLevel }
  | { type: "tool-result"; tool: string; ok: boolean; summary: string }
  | { type: "approval-required"; id: string; description: string; risk: RiskLevel }
  | { type: "approval-result"; id: string; approved: boolean }
  | { type: "report"; content: string }
  | { type: "review"; content: string }
  | { type: "plan"; id: string; content: string }
  | { type: "done"; text: string; toolCount: number; steps: number }
  | { type: "error"; message: string };

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
