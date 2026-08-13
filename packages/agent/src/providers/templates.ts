/**
 * InFu 供应商模板表（v2 模型管理重构）
 *
 * 数据来源：2026-08 联网调研各厂商最新规格（上下文窗口/推理级别/模型名）——
 * 选供应商时自动填入 baseURL / 默认窗口 / 推理级别数；常见模型预设供「从上游获取模型」勾选时匹配。
 *
 * 注意：窗口与级别均为保守默认，上游获取后可逐模型颗粒化修改；
 * Anthropic/Google 为 OpenAI 兼容端点（InFu 自研客户端只走 OpenAI Chat Completions 协议）。
 */

import type { ProviderKind } from "@infu/shared";

export interface ModelPreset {
  /** 上游模型 ID（/models 返回的 id） */
  id: string;
  /** 该模型上下文窗口（缺省用模板默认） */
  contextWindow?: number;
  /** 该模型实际推理级别数（缺省用模板默认；1=无思考） */
  thinkingLevels?: number;
}

export interface ProviderTemplate {
  kind: ProviderKind;
  /** 展示名（Web 供应商选择菜单） */
  label: string;
  /** 默认 API 地址（OpenAI 兼容端点，选供应商自动填入） */
  baseURL: string;
  /** 默认上下文窗口（token） */
  contextWindow: number;
  /** 默认实际推理级别数（思考级别 4 档 UI 的映射依据） */
  thinkingLevels: number;
  /** 常见模型预设（上游获取后勾选时自动匹配窗口/级别） */
  models: ModelPreset[];
}

/** 8 家供应商模板（2026-08 调研定稿） */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    kind: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    contextWindow: 1_000_000,
    thinkingLevels: 3, // v4 系列三档：non-think / think high / think max（官方文档 + vLLM 实测）
    models: [
      { id: "deepseek-v4-flash", contextWindow: 1_000_000, thinkingLevels: 3 },
      { id: "deepseek-v4-pro", contextWindow: 1_000_000, thinkingLevels: 3 },
    ],
  },
  {
    kind: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    contextWindow: 1_000_000,
    thinkingLevels: 4, // reasoning_effort low/medium/high/xhigh（max 仅 Sol）
    models: [
      { id: "gpt-5.6-luna", contextWindow: 1_000_000, thinkingLevels: 4 },
      { id: "gpt-5.6-terra", contextWindow: 1_000_000, thinkingLevels: 4 },
      { id: "gpt-5.6-sol", contextWindow: 1_000_000, thinkingLevels: 5 }, // 含 max
    ],
  },
  {
    kind: "anthropic",
    label: "Anthropic（Claude）",
    baseURL: "https://api.anthropic.com/v1", // OpenAI 兼容端点
    contextWindow: 1_000_000,
    thinkingLevels: 4, // 自适应思考 effort（low/medium/high/xhigh；Sonnet 5 起不再支持 budget_tokens）
    models: [
      { id: "claude-sonnet-5", contextWindow: 1_000_000, thinkingLevels: 4 },
      { id: "claude-opus-4-8", contextWindow: 1_000_000, thinkingLevels: 4 },
      { id: "claude-opus-5", contextWindow: 1_000_000, thinkingLevels: 4 },
    ],
  },
  {
    kind: "google",
    label: "Google（Gemini）",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    contextWindow: 1_000_000,
    thinkingLevels: 4, // thinkingConfig.thinkingLevel minimal/low/medium/high
    models: [
      { id: "gemini-3.6-flash", contextWindow: 1_000_000, thinkingLevels: 4 },
      { id: "gemini-3.6-pro", contextWindow: 1_000_000, thinkingLevels: 2 }, // Pro 仅 low/high
      { id: "gemini-3.6-ultra", contextWindow: 192_000, thinkingLevels: 2 }, // Deep Think
    ],
  },
  {
    kind: "zhipu",
    label: "智谱（GLM）",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    contextWindow: 1_000_000,
    thinkingLevels: 4, // thinking.type + reasoning_effort（7 档映射）
    models: [
      { id: "glm-5.2", contextWindow: 1_000_000, thinkingLevels: 4 },
      { id: "glm-5.1", contextWindow: 200_000, thinkingLevels: 3 },
      { id: "glm-5", contextWindow: 200_000, thinkingLevels: 3 },
    ],
  },
  {
    kind: "qwen",
    label: "通义千问（Qwen）",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    contextWindow: 256_000,
    thinkingLevels: 1, // Coder 系列纯非思考
    models: [
      { id: "qwen3-coder-plus", contextWindow: 256_000, thinkingLevels: 1 },
      { id: "qwen3-coder-flash", contextWindow: 256_000, thinkingLevels: 1 },
      { id: "qwen3.6-flash", contextWindow: 1_000_000, thinkingLevels: 2 }, // enable_thinking 控制
    ],
  },
  {
    kind: "custom",
    label: "自定义（Kimi 等 OpenAI 兼容）",
    baseURL: "https://api.moonshot.cn/v1",
    contextWindow: 256_000,
    thinkingLevels: 3, // kimi-k3 reasoning_effort low/high/max
    models: [
      { id: "kimi-k3", contextWindow: 1_000_000, thinkingLevels: 3 },
      { id: "kimi-k2.7-code", contextWindow: 256_000, thinkingLevels: 2 },
    ],
  },
  {
    kind: "ollama",
    label: "本地（Ollama）",
    baseURL: "http://localhost:11434/v1",
    contextWindow: 128_000,
    thinkingLevels: 1,
    models: [], // 本地模型任意，靠 /models 获取
  },
];

/** 按 kind 查模板 */
export function getProviderTemplate(kind: ProviderKind): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.kind === kind);
}

/** 按模型 id 查预设（上游获取勾选时匹配窗口/级别） */
export function findModelPreset(kind: ProviderKind, modelId: string): ModelPreset | undefined {
  const tpl = getProviderTemplate(kind);
  return tpl?.models.find((m) => m.id === modelId);
}
