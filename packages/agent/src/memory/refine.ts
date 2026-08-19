/**
 * v3.5 记忆自动提炼（config.memory.autoRefine，默认开）：
 * 任务真实干活后，用当前 Executor 模型做一次轻量调用，把本次任务收获提炼为
 * 项目记忆条目（conventions/lessons/preferences），追加写入 .infu/memory/。
 *
 * 设计：
 * - 单次调用、无工具、短输入（指令 + 交付文本截断）——成本可控；
 * - 输出约束为 JSON 数组，topic 白名单过滤，entry 走 memory 敏感凭据检测；
 * - 任何失败静默（orchestrator 调用方已包 try/catch，不阻塞交付）；
 * - 未配置模型（config 缺失）直接跳过——提炼不触发配置报错。
 */

import { loadConfig, resolveModel, toRuntimeModel, resolveFallbackModels } from "../providers/registry.js";
import { ModelChain, streamChatWithFailover } from "../providers/gateway.js";
import { writeMemory } from "./store.js";
import type { AgentEvent } from "@infu/shared";

interface RefineResult {
  text: string;
  toolCount: number;
  steps: number;
  approvals: { required: number; approved: number; denied: number };
  toolLogs: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; summary: string }>;
}

export interface RefineOptions {
  root: string;
  prompt: string;
  result: RefineResult;
  emit: (e: AgentEvent) => void;
}

export interface RefineUsage {
  cacheHit: number;
  cacheMiss: number;
  promptTokens: number;
  completionTokens: number;
}

const ALLOWED_TOPICS = new Set(["conventions", "lessons", "preferences"]);

/** 解析提炼输出（容忍围栏/前后噪声），返回 [{topic, entry}]；解析失败返回 []（导出供测试） */
export function parseEntries(raw: string): Array<{ topic: string; entry: string }> {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is { topic: string; entry: string } => !!x && typeof x === "object" && typeof x.topic === "string" && typeof x.entry === "string" && ALLOWED_TOPICS.has(x.topic) && x.entry.trim().length > 0)
      .map((x) => ({ topic: x.topic, entry: x.entry.trim().slice(0, 500) }));
  } catch {
    return [];
  }
}

/**
 * 任务完成后自动提炼项目记忆。失败/未配置静默返回。
 */
export async function refineMemory(opts: RefineOptions): Promise<RefineUsage | undefined> {
  const { root, prompt, result, emit } = opts;
  if (result.toolCount <= 0) return; // 寒暄/纯文本回复不提炼
  const cfg = loadConfig();
  if (!cfg?.models?.length) return; // 未配置模型 → 跳过（提炼不触发配置报错）
  if (result.text.length < 60) return; // 交付过短（失败/中止）不提炼

  const role = cfg.roles?.executor;
  const modelId = role && typeof role === "object" ? role.model : undefined;
  const mc = resolveModel(cfg, modelId);
  const rt = toRuntimeModel(cfg, mc);
  const fallbacks = resolveFallbackModels(cfg, mc).map((f) => {
    const r = toRuntimeModel(cfg, f);
    return { provider: r.provider, model: r.model, baseURL: r.baseURL, apiKey: r.apiKey, contextWindow: r.contextWindow, thinkingLevels: r.thinkingLevels, thinkingOverride: r.thinkingOverride };
  });
  const chain = new ModelChain(
    [{ provider: rt.provider, model: rt.model, baseURL: rt.baseURL, apiKey: rt.apiKey, contextWindow: rt.contextWindow, thinkingLevels: rt.thinkingLevels, thinkingOverride: rt.thinkingOverride }, ...fallbacks],
    { onFallback: (from, to, reason) => emit({ type: "model-fallback", from, to, reason }) }
  );

  const taskHint = prompt.replace(/\s+/g, " ").slice(0, 200);
  const resultHint = result.text.replace(/\s+/g, " ").slice(0, 2000);
  const out: string[] = [];
  const usage: RefineUsage = { cacheHit: 0, cacheMiss: 0, promptTokens: 0, completionTokens: 0 };
  for await (const delta of streamChatWithFailover({
    chain,
    timeoutMs: 60000,
    messages: [
      {
        role: "system",
        content:
          "你是 InFu 的记忆提炼器。根据用户的任务指令与任务结果，提炼值得长期记住的项目知识。" +
          "输出严格 JSON 数组，元素形如 {\"topic\":\"conventions|lessons|preferences\",\"entry\":\"一句话知识\"}。" +
          "conventions=项目约定（技术栈/规范/命令）；lessons=踩坑教训；preferences=偏好。" +
          "没有值得记的返回 []。只输出 JSON，不要多余文字。",
      },
      { role: "user", content: `任务指令：${taskHint}\n\n任务结果：${resultHint}` },
    ],
  })) {
      if (delta.text) out.push(delta.text);
      if (delta.usage) {
        usage.cacheHit += delta.usage.cacheHit;
        usage.cacheMiss += delta.usage.cacheMiss;
        usage.promptTokens += delta.usage.promptTokens;
        usage.completionTokens += delta.usage.completionTokens;
      }
  }

  const entries = parseEntries(out.join(""));
  if (usage.promptTokens || usage.completionTokens) {
    emit({
      type: "model-call",
      model: rt.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cacheHit: usage.cacheHit,
      cacheMiss: usage.cacheMiss,
    });
  }
  if (!entries.length) return usage;
  for (const e of entries) {
    const w = writeMemory("project", e.topic, `- ${e.entry}`, "append", root);
    if (w.ok) emit({ type: "memory-sediment", path: `${root}/.infu/memory/${e.topic}.md`, summary: e.entry });
  }
  return usage;
}
