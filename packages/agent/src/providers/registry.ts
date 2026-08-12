/**
 * InFu 模型接入层 — Provider Registry
 *
 * 设计目标：任意大模型即插即用。
 *  - 官方适配：OpenAI / Anthropic / Google（AI SDK v6 配套 3.x，返回 V3 兼容）
 *  - OpenAI 兼容端点（统一走 createOpenAI + baseURL）：
 *      DeepSeek / 智谱 GLM / 通义千问 / Ollama / 任意自定义网关
 *      （One API、New API、vLLM、本地代理等）
 *
 * 与 ZCode 差异：ZCode 固化国内模型目录；InFu 完全开放，用户配置即接入。
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { ModelConfig, ProviderKind } from "@infu/shared";

/** OpenAI 兼容供应商默认端点 */
const DEFAULT_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  deepseek: "https://api.deepseek.com/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ollama: "http://localhost:11434/v1",
};

/** 环境变量覆盖：INFU_<PROVIDER>_API_KEY（大写） */
export function resolveApiKey(cfg: ModelConfig): string {
  if (cfg.apiKey && cfg.apiKey.trim()) return cfg.apiKey.trim();
  const env = process.env[`INFU_${cfg.provider.toUpperCase()}_API_KEY`];
  if (env) return env;
  return "";
}

/** 根据用户配置创建 LanguageModel（AI SDK v6 统一协议） */
export function createModel(cfg: ModelConfig): LanguageModel {
  const apiKey = resolveApiKey(cfg);
  const baseURL = cfg.baseURL || DEFAULT_BASE_URLS[cfg.provider];

  // 调试：INFU_DEBUG_FETCH=1 时打印服务端真实请求与响应状态
  const debugFetch: typeof fetch | undefined = process.env.INFU_DEBUG_FETCH
    ? async (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = String(headers.authorization ?? headers.Authorization ?? "");
        console.error(`[debug-fetch] → ${String(url)}`);
        console.error(`[debug-fetch]   auth: ${auth.slice(0, 20)}...（len=${auth.length}）`);
        console.error(`[debug-fetch]   body: ${String(init?.body ?? "").slice(0, 200)}`);
        const res = await fetch(url, init);
        const body = await res.text().catch(() => "");
        console.error(`[debug-fetch] ← status=${res.status} type=${res.headers.get("content-type")} body=${body.slice(0, 200)}`);
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
    : undefined;

  switch (cfg.provider) {
    case "openai":
      // 官方 OpenAI：统一走 Chat Completions（与兼容端点行为一致，最通用）
      return createOpenAI({ apiKey, fetch: debugFetch }).chat(cfg.model);
    case "anthropic":
      return createAnthropic({ apiKey })(cfg.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(cfg.model);
    case "deepseek":
    case "zhipu":
    case "qwen":
    case "ollama":
    case "custom": {
      // OpenAI 兼容协议：DeepSeek/智谱/通义/Ollama/自建网关均提供 /v1 兼容接口
      // ⚠️ 必须用 .chat()（Chat Completions）——默认的 Responses API 兼容端点不支持
      if (cfg.provider === "custom" && !baseURL) {
        throw new Error(`模型 "${cfg.name}"（custom）缺少 baseURL，请配置任意 OpenAI 兼容端点`);
      }
      return createOpenAI({
        apiKey: apiKey || "not-needed",
        fetch: debugFetch,
        ...(baseURL ? { baseURL } : {}),
      }).chat(cfg.model);
    }
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`未知的模型供应商: ${String(_exhaustive)}`);
    }
  }
}

/** 按模型 ID 推断能力（粗粒度；精确探测后续实现） */
export function inferCapabilities(cfg: ModelConfig): NonNullable<ModelConfig["capabilities"]> {
  const id = cfg.model.toLowerCase();
  const vision = /vision|vl|4o|omni|gemini|gpt-4|gpt-5|claude/.test(id);
  return {
    toolCalling: true, // 现代模型均支持；不可用时 Agent 自动降级为建议模式
    streaming: true,
    vision,
  };
}

/** 读取用户配置（~/.infu/config.json） */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InfuConfig } from "@infu/shared";

export const CONFIG_PATH = join(homedir(), ".infu", "config.json");

export function loadConfig(): InfuConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as InfuConfig;
  } catch (e) {
    throw new Error(`模型配置文件解析失败 ${CONFIG_PATH}: ${(e as Error).message}`);
  }
}

/** 解析使用的模型：显式指定 > 配置默认 > 环境变量（INFU_MODEL_ID） */
export function resolveModel(cfg: InfuConfig | null | undefined, explicitId?: string): ModelConfig {
  if (cfg && cfg.models?.length) {
    const id = explicitId || cfg.defaultModelId || process.env.INFU_MODEL_ID;
    const found = cfg.models.find((m) => m.id === id);
    if (found) return found;
    if (id) {
      throw new Error(`未找到模型 "${id}"，可用模型: ${cfg.models.map((m) => m.id).join(", ")}`);
    }
    return cfg.models[0];
  }
  throw new Error(
    "未配置模型。请运行 infu --setup 生成配置模板，或设置环境变量 INFU_MODEL_ID / INFU_API_KEY。"
  );
}
