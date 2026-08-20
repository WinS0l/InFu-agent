/**
 * InFu 上下文管理（v2.2）— 估算与压缩
 *
 * 触发条件按模型因地制宜（用户明确要求）：预算 = 当前活动模型的
 * contextWindow（resolveContextWindow：显式配置 > 模型名 > provider > 兜底），
 * 估算超窗口 ×80% 才压缩（长会话才触发），压到 ×60% 以内（留生成空间）；
 * 降级切模型后预算自动跟随新模型。
 *
 * 压缩只作用于运行时 messages，DB 事件流始终无损（重建可恢复全量历史）。
 */

import type { ChatMessageLike } from "../providers/chat.js";

/** 压缩触发阈值（窗口占比；长会话才压缩） */
export const COMPRESS_TRIGGER_RATIO = 0.8;
/** 压缩目标阈值（窗口占比；留生成空间） */
export const COMPRESS_TARGET_RATIO = 0.6;

// ── v6.0（P1 D1/S2）上下文 usage 校准（主流双轨制）──
// API 真实 usage（prompt_tokens）是事实基准，本地估算（estimateTokens）用于触发预测——
// 两者比值漂移时（reasoning 长/工具结果大/tokenizer 差异），压缩触发时机失真：
// 估算偏低 → 压缩过晚（依赖 400 强制压缩兜底）；估算偏高 → 压缩过早（浪费上下文）。
// 每成功一轮模型调用记录 ratio = actual / estimate，按会话 EWMA 平滑（α=0.3），
// 触发判定时把估算乘到与真实用量一致的量纲。零依赖、无 tokenizer。
const EWMA_ALPHA = 0.3;
/** 单次比值钳制（防单轮异常样本把因子带飞） */
const CALIB_CLAMP: [number, number] = [0.25, 4];
const CALIB = new Map<string, { factor: number; n: number; touched: number }>();
const CALIB_MAX = 4096;
const CALIB_TTL_MS = 60 * 60 * 1000;

/** 记录一轮真实用量 vs 本地估算的比值（loop 成功轮调用） */
export function recordUsageCalibration(sessionId: string, actualTokens: number, estimatedTokens: number): void {
  if (!Number.isFinite(actualTokens) || actualTokens <= 0) return;
  const est = Math.max(1, estimatedTokens);
  const ratio = Math.min(CALIB_CLAMP[1], Math.max(CALIB_CLAMP[0], actualTokens / est));
  const now = Date.now();
  const prev = CALIB.get(sessionId);
  if (!prev) {
    if (CALIB.size >= CALIB_MAX) {
      const oldest = [...CALIB.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
      if (oldest) CALIB.delete(oldest[0]);
    }
    CALIB.set(sessionId, { factor: ratio, n: 1, touched: now });
    return;
  }
  const factor = EWMA_ALPHA * ratio + (1 - EWMA_ALPHA) * prev.factor;
  CALIB.set(sessionId, { factor, n: prev.n + 1, touched: now });
}

/** 当前校准因子（无记录 = 1） */
export function contextCalibrationFactor(sessionId: string): number {
  const entry = CALIB.get(sessionId);
  if (!entry || Date.now() - entry.touched > CALIB_TTL_MS) {
    CALIB.delete(sessionId);
    return 1;
  }
  entry.touched = Date.now();
  return entry.factor;
}

/** 测试专用：清空校准状态 */
export function resetContextCalibration(): void {
  CALIB.clear();
}

/** 图片 part 固定 token 成本（审计修复：base64 原文数百 KB 按 4 字符/token 计
 *  会虚增 ~25 万 token——视觉会话每步误触发全量压缩、历史被整段清空、校准因子被
 *  钳死 0.25 下限。视觉模型每图实际消耗 ~1000-2500 token，取 1500 近似） */
export const IMAGE_PART_TOKENS = 1500;

/** 单条消息内容提取（string 或 content 数组） */
function contentText(msg: ChatMessageLike): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => {
        if (typeof p?.text === "string") return p.text;
        // 图片 part：base64 正文不得按文本估算（长度由 estimateTokens 固定计），
        // 摘要求序列化/裁剪等场景对图片原文也无意义
        if (p && typeof p === "object" && (p as { type?: string }).type === "image") return "";
        return JSON.stringify(p);
      })
      .join("\n");
  }
  return "";
}

/**
 * token 粗估（不引 tokenizer 依赖）：中文 1 字符≈1 token、其他≈4 字符 1 token；
 * 工具调用参数/结果按内容计入。
 */
export function estimateTokens(messages: ChatMessageLike[]): number {
  let total = 0;
  for (const m of messages) {
    const text = contentText(m);
    let cn = 0;
    let other = 0;
    for (const ch of text) {
      if (/[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch)) cn++;
      else other++;
    }
    total += cn + Math.ceil(other / 4);
    // 图片 part 固定计（base64 原文已排除，见 contentText）
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p && typeof p === "object" && (p as { type?: string }).type === "image") total += IMAGE_PART_TOKENS;
      }
    }
    // 消息结构开销（role/字段名等，粗估）
    total += 4;
    // v3.9 审计修复（C1）：tool_calls 的 arguments JSON 正文计入估算（原实现只计固定
    // 每条 16 token——工具参数数千字符时上下文实际占用被系统性低估，400 恢复判断失真）
    if (m.tool_calls?.length) {
      total += 16 * m.tool_calls.length;
      for (const tc of m.tool_calls) {
        total += Math.ceil((tc.function?.arguments?.length ?? 0) / 4);
      }
    }
    if (m.reasoning_content) total += Math.ceil(m.reasoning_content.length / 3);
  }
  return total;
}

/** 压缩指令（摘要生成用；v2.10 作为「消息前缀 + 末尾指令」的最后一条 user 消息——复用 provider warm KV cache） */
const SUMMARIZE_PROMPT = `请把以上对话压缩为简洁摘要，必须保留：任务目标、关键决策与原因、文件改动清单、测试结果、遗留问题/未完成事项、用户最新要求。
要求：按时间顺序组织；保留具体文件名与命令；不要编造内容；用中文输出；400 字以内。`;

/**
 * v2.10 压缩前先剪超长工具结果（借鉴 主流 compaction-tool-result-pruner）：
 * 单条 tool 消息文本 > 8K 时保留 head 4096 + 标记 + tail 1024——纯文本操作零模型成本，
 * 剪完可能不再超预算（避免不必要的摘要调用）。
 */
export function pruneToolResults(messages: ChatMessageLike[]): ChatMessageLike[] {
  const HEAD = 4096;
  const TAIL = 1024;
  const THRESHOLD = 8000;
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== "tool") return m;
    const text = contentText(m);
    if (text.length <= THRESHOLD) return m;
    changed = true;
    const pruned =
      text.slice(0, HEAD) +
      `\n[... 工具结果中间部分已剪（原 ${text.length} 字符）；如需完整内容请用会话记录或重新执行工具 …]\n` +
      text.slice(-TAIL);
    return { ...m, content: pruned };
  });
  return changed ? next : messages;
}

/** 历史文本序列化（v2.10 已由「消息前缀 + 末尾指令」取代摘要输入；保留给测试与工具链） */

/** 历史文本序列化（摘要输入；每消息与总长都截断防爆） */
function serializeHistory(messages: ChatMessageLike[], perMsgLimit = 800, totalLimit = 30000): string {
  const parts: string[] = [];
  let total = 0;
  for (const m of messages) {
    const role = m.role;
    let body = contentText(m);
    if (m.tool_calls?.length) {
      body += `\n[工具调用] ` + m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments.slice(0, 200)})`).join("; ");
    }
    if (body.length > perMsgLimit) body = body.slice(0, perMsgLimit) + "…";
    if (!body) continue;
    const part = `${role}: ${body}`;
    total += part.length;
    if (total > totalLimit) break; // 摘要输入预算上限（防小窗口模型摘要调用本身爆窗）
    parts.push(part);
  }
  return parts.join("\n---\n");
}

export interface CompressResult {
  /** 压缩后的消息（摘要消息 + 保留的最近消息） */
  messages: ChatMessageLike[];
  /** 压缩前估算 token */
  before: number;
  /** 压缩后估算 token */
  after: number;
  /** 生成的摘要文本 */
  summary: string;
}

/** 摘要必须小于被替换内容的比例阈值（对齐 主流 compaction：摘要自身 ≥ 被替换内容即拒绝，
 *  降级为直接丢弃最老部分——摘要若比原文还大就毫无意义且浪费 KV cache） */
const SUMMARY_MUST_BE_SMALLER = true;

/**
 * v3.2 压缩边界工具对平衡（借鉴 主流 compaction region.ts toolPairingBalancedBefore）：
 * 压缩边界 keepFrom 若落在「assistant(tool_calls) 与其 tool 结果」之间，会把结果留在
 * 保留区而调用被压缩掉（或反之）→ 工具消息引用不存在的 call_id → API 400。
 * 这里把边界向前回溯到配对起点（assistant 消息或 user 边界），保证工具对完整保留。
 */
export function balanceToolPairs(messages: ChatMessageLike[], keepFrom: number): number {
  let kf = keepFrom;
  // kept 区第一条是 tool 结果消息 → 其配对 assistant 也必须留在 kept
  const firstKept = messages[kf];
  if (!firstKept || firstKept.role !== "tool" || !firstKept.tool_call_id) return kf;
  const callId = firstKept.tool_call_id;
  for (let i = kf - 1; i >= 1; i--) {
    const mm = messages[i];
    if (mm.role === "user") break; // 工具对不跨 user 消息边界
    if (mm.role === "assistant" && mm.tool_calls?.some((tc) => tc.id === callId)) {
      return i; // 前移到配对 assistant：整个调用/结果对完整保留
    }
  }
  return kf; // 找不到配对（历史畸形数据），保持原边界
}

/**
 * 超预算时压缩：把「最早的部分」调摘要生成器压缩为一条摘要消息，保留最近内容。
 * 摘要生成失败自动降级为「直接丢弃最老部分」（保最新，不阻塞任务）。
 * @param budget 当前活动模型的窗口预算（token）
 * @param summarize 摘要生成器（调模型；失败时抛错由本函数内部降级）
 * @param force v3.9 审计修复（C1）：强制压缩——API 400 上下文超限恢复路径用
 *        （估算可能低估），跳过 trigger 阈值早退直接压到 target；默认 false 保持
 *        常规「超 80% 才压缩」语义
 */
export async function compressMessages(
  messages: ChatMessageLike[],
  budget: number,
  summarize: (history: ChatMessageLike[]) => Promise<string>,
  force = false,
  // v6.0（D1/S2）：usage 校准因子（本地估算 × 因子 ≈ API 真实用量；缺省 1 保持旧语义）
  calibrationFactor = 1
): Promise<CompressResult> {
  // v2.10：先剪超长工具结果（零模型成本；剪完可能不再超预算）
  const pruned = pruneToolResults(messages);
  const beforeRaw = estimateTokens(pruned);
  // 校准后的估算（乘性缩放不改变 keep 边界的相对决策，只校准与窗口的绝对比较）
  const before = beforeRaw * calibrationFactor;
  // 预算换算：触发 = 窗口×80%，目标 = 窗口×60%
  const trigger = budget * COMPRESS_TRIGGER_RATIO;
  const target = budget * COMPRESS_TARGET_RATIO;
  if (!force && before <= trigger) {
    return { messages: pruned, before: beforeRaw, after: beforeRaw, summary: "" };
  }

  // system 消息（角色提示词/INFU.md/技能/工具纪律）永不参与压缩——提取出来，
  // 压缩只作用于其余消息，结果头部始终保留全部 system（v3.4 审计修复 H2：
  // 原实现 keepFrom 保底=2 会把 messages[0] system 压进摘要，长任务二次压缩后
  // 模型失去全部工具纪律与角色指令；compress.test.ts 弱断言恰好掩盖）
  const systemMsgs = pruned.filter((m) => m.role === "system");
  const others = pruned.filter((m) => m.role !== "system");
  const othersBefore = estimateTokens(others) * calibrationFactor;
  if (!force && othersBefore <= trigger) {
    return { messages: pruned, before: beforeRaw, after: beforeRaw, summary: "" };
  }

  // 找压缩边界：从后往前保留最近消息直到 ≤ target
  // 预留摘要消息自身开销（标题 + 400 字摘要正文 ≈ 512 token；保证压缩后整体 ≤ target）
  const RESERVED_FOR_SUMMARY = 512;
  let keepFrom = others.length;
  let acc = 0;
  for (let i = others.length - 1; i >= 1; i--) {
    acc += estimateTokens([others[i]]) * calibrationFactor;
    if (acc > target - RESERVED_FOR_SUMMARY) break;
    keepFrom = i;
  }
  // 至少要压缩掉一条（keepFrom 前进至少 1）
  if (keepFrom <= 1) keepFrom = 2; // 保底：压缩最老的一条（system 已剔除，此处必为非 system）
  if (keepFrom >= others.length) {
    // v6.0（D1/S2）修复：已过触发线但边界回退仍装不下（预算过小，或校准因子放大后
    // 单条消息估算 > target-RESERVED）——原实现直接返回未压缩，压缩在「估算低估 +
    // 小窗口」时系统性失效（恰是 400 恢复最需要的场景）。触发后保证至少压缩最老一条。
    keepFrom = others.length - 1;
  }
  // v3.2：工具对平衡——边界前移保证 assistant(tool_calls)/tool 结果对完整（防 API 400）
  keepFrom = balanceToolPairs(others, keepFrom);

  const toCompress = others.slice(0, keepFrom);
  const kept = others.slice(keepFrom);
  // 摘要生成失败 → 降级为直接丢弃最老部分（保最新，不阻塞任务）
  let summary = "";
  try {
    summary = (await summarize(toCompress)).trim();
  } catch (e) {
    summary = "";
  }
  // v3.2：摘要合理性检查——摘要自身估算 ≥ 被替换内容时拒绝（对齐 主流 framedSummary
  // 检查）；压缩后整体未变小也拒绝。两种情况都降级为直接丢弃最老部分。
  const summaryMsg: ChatMessageLike[] = summary
    ? [{ role: "user", content: `【此前会话摘要（历史已压缩，原内容可从会话记录恢复）】\n${summary}` }]
    : [];
  // 摘要对比是相对决策（摘要 vs 被替换内容），因子乘性缩放后对比不变，无需校准
  if (SUMMARY_MUST_BE_SMALLER && summaryMsg.length && estimateTokens(summaryMsg) >= estimateTokens(toCompress)) {
    summary = ""; // 摘要不比原文小：丢弃，用 kept 裸保留
  }
  const compressed: ChatMessageLike[] = summary
    ? [...systemMsgs, summaryMsg[0], ...kept]
    : [...systemMsgs, ...kept];
  return { messages: compressed, before: beforeRaw, after: estimateTokens(compressed), summary };
}

/** 序列化历史给摘要生成器（context.ts 内部用） */
export { serializeHistory, SUMMARIZE_PROMPT };
