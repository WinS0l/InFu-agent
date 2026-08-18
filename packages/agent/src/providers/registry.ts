/**
 * InFu 模型接入层 — Provider Registry
 *
 * 设计目标：任意大模型即插即用。
 *  - 模型调用统一走自研 OpenAI 兼容流式客户端（providers/chat.ts streamChat）；
 *    本模块只负责配置解析（凭据/端点/上下文窗口/思考级别），不持有 AI SDK 适配
 *  - OpenAI 兼容端点（DeepSeek / 智谱 GLM / 通义千问 / Ollama / 任意自定义网关）
 *
 * 与 InFu 差异：InFu 固化国内模型目录；InFu 完全开放，用户配置即接入。
 */

import type { InfuConfig, ModelConfig, ProviderConfig, ProviderKind } from "@infu/shared";
import { PROVIDER_TEMPLATES, getProviderTemplate } from "./templates.js";

/** OpenAI 兼容供应商默认端点（v2：与供应商模板表统一数据源） */
const DEFAULT_BASE_URLS: Partial<Record<ProviderKind, string>> = {};
for (const t of PROVIDER_TEMPLATES) DEFAULT_BASE_URLS[t.kind] = t.baseURL;

/** 运行时端点解析：显式 baseURL > 供应商默认端点 */
export function resolveBaseURL(provider: ProviderKind, baseURL?: string): string {
  return baseURL || DEFAULT_BASE_URLS[provider] || "";
}

// ── v2.2 上下文窗口（上下文压缩预算依据：按模型因地制宜；2026-08 调研校准）──
/** provider 级默认（token）——与供应商模板表一致 */
const PROVIDER_CONTEXT_WINDOWS: Partial<Record<ProviderKind, number>> = {};
for (const t of PROVIDER_TEMPLATES) PROVIDER_CONTEXT_WINDOWS[t.kind] = t.contextWindow;
/** 模型名级覆盖（小写子串匹配，优先于 provider 级）——只列与默认差异大的 */
const MODEL_CONTEXT_WINDOWS: Array<{ match: RegExp; window: number }> = [
  { match: /qwen3\.6/i, window: 1_000_000 },          // 通义 3.6 系列 1M
  { match: /gemini.*(pro|ultra)/i, window: 1_000_000 },
  { match: /glm-5\.2/i, window: 1_000_000 },          // GLM-5.2 旗舰 1M
  { match: /kimi-k3/i, window: 1_000_000 },
  { match: /deepseek-v4/i, window: 1_000_000 },
  { match: /gpt-5\.6/i, window: 1_000_000 },
  { match: /claude.*(sonnet-5|opus)/i, window: 1_000_000 },
];
/** 兜底（未知模型/未配置） */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * 上下文窗口解析（v2.2 上下文压缩预算）：
 * 显式配置 contextWindow > 模型名匹配表 > provider 默认 > 兜底 128k。
 * 压缩触发/目标跟「当前活动模型」走——降级切模型后预算自动跟随。
 */
export function resolveContextWindow(cfg: {
  provider: ProviderKind;
  model: string;
  contextWindow?: number;
}): number {
  if (cfg.contextWindow && cfg.contextWindow > 0) return cfg.contextWindow;
  for (const { match, window } of MODEL_CONTEXT_WINDOWS) {
    if (match.test(cfg.model)) return window;
  }
  return PROVIDER_CONTEXT_WINDOWS[cfg.provider] ?? FALLBACK_CONTEXT_WINDOW;
}

/** 环境变量覆盖：INFU_<KIND>_API_KEY（大写） */
export function resolveApiKey(cfg: InfuConfig | null | undefined, model: ModelConfig): string {
  const p = resolveProvider(cfg, model);
  if (p?.apiKey && p.apiKey.trim()) return p.apiKey.trim();
  const kind = p?.kind ?? model.provider ?? "custom";
  const env = process.env[`INFU_${kind.toUpperCase()}_API_KEY`];
  if (env) return env;
  // v1 遗留：模型内嵌 key
  if (model.apiKey?.trim()) return model.apiKey.trim();
  return "";
}

/**
 * 模型 → 供应商凭据（v2）：经 providerId 查 providers[]；
 * v1 遗留模型（无 providerId）返回 undefined（凭据回退模型内嵌字段）。
 */
export function resolveProvider(
  cfg: InfuConfig | null | undefined,
  model: ModelConfig
): ProviderConfig | undefined {
  if (model.providerId && cfg?.providers?.length) {
    return cfg.providers.find((p) => p.id === model.providerId);
  }
  return undefined;
}

/** 模型所属供应商 kind（v2：provider.kind；v1 遗留：model.provider） */
export function resolveModelKind(cfg: InfuConfig | null | undefined, model: ModelConfig): ProviderKind {
  return resolveProvider(cfg, model)?.kind ?? model.provider ?? "custom";
}

/** 模型端点解析（v2：provider.baseURL > 供应商默认；v1 遗留：model.baseURL > 默认） */
export function resolveModelBaseURL(cfg: InfuConfig | null | undefined, model: ModelConfig): string {
  const kind = resolveModelKind(cfg, model);
  const p = resolveProvider(cfg, model);
  return resolveBaseURL(kind, p?.baseURL ?? model.baseURL);
}

/**
 * v3.6 审计修复：createModel（AI SDK 适配）已删除——自研 OpenAI 兼容流式客户端
 * （providers/chat.ts streamChat）才是实际模型调用路径，本函数自 v1 起无任何调用点
 * （含 createOpenAI/createAnthropic/createGoogleGenerativeAI 的 AI SDK 依赖随之移除）。
 */

/** 读取用户配置（~/.infu/config.json；zod schema 校验 + v1 在线迁移 + 损坏备份） */
import { readFileSync, existsSync, copyFileSync, mkdirSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseInfuConfig } from "@infu/shared";
import { resolveDataDir } from "../data-dir.js";

export function configPath(): string {
  return join(resolveDataDir(), "config.json");
}

/** 安全写入配置（v2.1 起带 schema 版本号；v2.4 统一收敛：server/cli/mcp-register/plugin-register 共用本实现） */
export function saveConfig(cfg: InfuConfig): void {
  const dir = resolveDataDir();
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "config.json");
  // v3.5：原子写（tmp + rename）——多进程并发（server/CLI/定时任务）直写会截断
  // 半写内容，读方 JSON.parse 失败 → 反复产生 .corrupt-* 备份
  const tmp = join(dir, `config.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify({ ...cfg, version: cfg.version ?? 1 }, null, 2), "utf-8");
  // v3.4 审计修复：配置文件含 API Key，落盘后收紧权限（win32 无 POSIX 权限位，
  // 靠用户目录 ACL 兜底；POSIX 下 0600 防同机其他用户读取密钥）
  try {
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
  } catch {
    /* 权限设置失败不影响写入（Windows 无此概念） */
  }
  renameSync(tmp, p);
}

export function loadConfig(): InfuConfig | null {
  const CONFIG_PATH = configPath();
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const r = parseInfuConfig(raw);
    if (r.ok) return r.config;
    // 格式错误：备份原文件（防数据丢失），返回 null 走"未配置"引导
    const backup = `${CONFIG_PATH}.broken-${Date.now()}`;
    try { copyFileSync(CONFIG_PATH, backup); } catch { /* 备份失败忽略 */ }
    console.error(`[infu] 配置文件格式错误（已备份到 ${backup}）：${r.error}`);
    return null;
  } catch (e) {
    // JSON 语法损坏：同样备份后走"未配置"引导
    const backup = `${CONFIG_PATH}.broken-${Date.now()}`;
    try { copyFileSync(CONFIG_PATH, backup); } catch { /* 备份失败忽略 */ }
    console.error(`[infu] 配置文件解析失败（已备份到 ${backup}）：${(e as Error).message}`);
    return null;
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

/**
 * 备用模型降级链解析（v2.2）：显式 id 列表（CLI --fallback-model / API body）优先，
 * 否则用模型自身的 fallbackModelIds；跳过自身与重复项；未知 id 跳过（由调用方警告）。
 */
export function resolveFallbackModels(
  cfg: InfuConfig | null | undefined,
  primary: ModelConfig,
  explicitIds?: string[]
): ModelConfig[] {
  const ids = explicitIds && explicitIds.length ? explicitIds : primary.fallbackModelIds ?? [];
  const seen = new Set([primary.id]);
  const out: ModelConfig[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const m = cfg?.models.find((x) => x.id === id);
    if (!m) continue; // 未知 id：跳过（防配置漂移拖垮降级链）
    seen.add(id);
    out.push(m);
  }
  return out;
}

/**
 * 按角色解析模型（v2.2 轻量模型选择；v2.3 支持角色独立思考级别）：
 * 显式指定（CLI --planner-model 等 / API body）> config roles.<role>（string 或 {model}）> 声明该角色的模型（首个）> 默认模型。
 */
export function resolveRoleModel(
  cfg: InfuConfig | null | undefined,
  defaultModel: ModelConfig,
  role: "planner" | "executor" | "reviewer",
  explicitId?: string
): ModelConfig {
  const ref = cfg?.roles?.[role];
  const id = explicitId || (typeof ref === "string" ? ref : ref?.model);
  if (id) {
    const m = cfg?.models.find((x) => x.id === id);
    if (m) return m;
    // 配置指向未知模型：警告由调用方打，回退默认
  }
  const declared = cfg?.models.find((m) => m.roles?.includes(role));
  return declared ?? defaultModel;
}

/** 角色独立思考级别（v2.3 Web 角色路由面板）：roles.<role> 为 {model, thinkingLevel} 时返回；否则 undefined（跟随全局） */
export function resolveRoleThinking(
  cfg: InfuConfig | null | undefined,
  role: "planner" | "executor" | "reviewer"
): number | undefined {
  const ref = cfg?.roles?.[role];
  if (ref && typeof ref === "object" && ref.thinkingLevel) {
    return Math.max(1, Math.min(4, Math.round(ref.thinkingLevel)));
  }
  return undefined;
}

/** 模型配置 → 运行时形态（端点解析 + API Key 解析；server/cli 组装共用；v2 经 providerId 取凭据） */
export function toRuntimeModel(cfg: InfuConfig | null | undefined, m: ModelConfig): {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  contextWindow?: number;
  thinkingLevels?: number;
  thinkingOverride?: Array<Record<string, unknown> | null>;
} {
  return {
    provider: resolveModelKind(cfg, m),
    model: m.model,
    baseURL: resolveModelBaseURL(cfg, m),
    apiKey: resolveApiKey(cfg, m),
    contextWindow: m.contextWindow,
    thinkingLevels: m.thinkingLevels,
    thinkingOverride: m.thinkingOverride,
  };
}

// ── v2 思考级别（4 档 UI → 每模型实际级别自动映射 + provider 参数注入）──

/** 4 档 UI 级别 → 模型实际级别（1..N）：
 *  UI 1 → 模型 1（最弱）；UI 2..4 → 按比例映射到 2..N。
 *  例：N=2（DeepSeek）→ 1→1（非思考）、2-4→2（深度思考）；N=4 → 直通；N=1 → 恒 1。 */
export function mapThinkingLevel(uiLevel: number, modelLevels: number): number {
  const ui = Math.max(1, Math.min(4, Math.round(uiLevel)));
  const n = Math.max(1, Math.round(modelLevels));
  if (n === 1) return 1;
  if (ui === 1) return 1;
  return Math.min(n, Math.ceil(((ui - 1) / 3) * (n - 1)) + 1);
}

/** 模型实际推理级别数（显式配置 > 供应商模板默认 > 1） */
export function resolveThinkingLevels(cfg: InfuConfig | null | undefined, model: ModelConfig): number {
  if (model.thinkingLevels && model.thinkingLevels > 0) return model.thinkingLevels;
  const tpl = getProviderTemplate(resolveModelKind(cfg, model));
  return tpl?.thinkingLevels ?? 1;
}

/**
 * 构建思考参数（注入 streamChat 请求体；按供应商协议映射）。
 * @param mappedLevel 模型实际级别（mapThinkingLevel 输出，1..N）
 * @param modelLevels 模型实际级别总数
 * @returns 请求体附加字段；undefined = 不注入（无思考参数）
 */
export function buildThinkingParams(
  kind: ProviderKind,
  mappedLevel: number,
  modelLevels: number
): Record<string, unknown> | undefined {
  const lvl = Math.max(1, Math.round(mappedLevel));
  const n = Math.max(1, Math.round(modelLevels));
  switch (kind) {
    case "deepseek":
      if (lvl === 1) return { thinking: { type: "disabled" } };
      if (n >= 3 && lvl >= 3) return { thinking: { type: "enabled" }, reasoning_effort: "max" };
      return { thinking: { type: "enabled" } };
    case "openai":
      return { reasoning_effort: ["low", "medium", "high", "xhigh", "max"][Math.min(n, lvl) - 1] };
    case "anthropic":
      // Sonnet 5 起自适应思考 + effort（OpenAI 兼容端点同名参数；待 probe 实测校准）
      return { reasoning_effort: ["low", "medium", "high", "xhigh", "max"][Math.min(n, lvl) - 1] };
    case "zhipu":
      if (lvl === 1) return { thinking: { type: "disabled" } };
      return { thinking: { type: "enabled" }, reasoning_effort: ["low", "medium", "high", "max"][Math.min(n, lvl) - 1] };
    case "qwen":
      return { enable_thinking: lvl > 1 };
    case "google":
      return { thinkingConfig: { thinkingLevel: ["minimal", "low", "medium", "high"][Math.min(n, lvl) - 1] } };
    case "custom":
      // Kimi K3 用 reasoning_effort（low/high/max）；其他自定义端点无通用思考参数
      return undefined;
    case "ollama":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * 模型级思考参数（v2 小众模型场景）：模型配置了 thinkingOverride 时优先于供应商协议映射；
 * 第 i 档为 null = 不注入；越界/非法回退协议映射。
 */
export function buildThinkingParamsForModel(
  kind: ProviderKind,
  mappedLevel: number,
  modelLevels: number,
  override?: Array<Record<string, unknown> | null>
): Record<string, unknown> | undefined {
  if (override?.length) {
    const idx = Math.max(1, Math.round(mappedLevel)) - 1;
    const custom = override[idx];
    if (custom !== undefined) return custom ?? undefined; // null = 该档不注入
  }
  return buildThinkingParams(kind, mappedLevel, modelLevels);
}
