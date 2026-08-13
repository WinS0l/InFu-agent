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

/** 单条消息内容提取（string 或 content 数组） */
function contentText(msg: ChatMessageLike): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => (typeof p?.text === "string" ? p.text : JSON.stringify(p)))
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
    // 消息结构开销（role/字段名等，粗估）
    total += 4;
    if (m.tool_calls?.length) total += 16 * m.tool_calls.length;
    if (m.reasoning_content) total += Math.ceil(m.reasoning_content.length / 3);
  }
  return total;
}

/** 压缩指令（摘要生成用） */
const SUMMARIZE_PROMPT = `请把以下历史对话压缩为简洁摘要，必须保留：任务目标、关键决策与原因、文件改动清单、测试结果、遗留问题/未完成事项、用户最新要求。
要求：按时间顺序组织；保留具体文件名与命令；不要编造内容；用中文输出；400 字以内。
历史对话：
`;

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

/**
 * 超预算时压缩：把「最早的部分」调摘要生成器压缩为一条摘要消息，保留最近内容。
 * 摘要生成失败自动降级为「直接丢弃最老部分」（保最新，不阻塞任务）。
 * @param budget 当前活动模型的窗口预算（token）
 * @param summarize 摘要生成器（调模型；失败时抛错由本函数内部降级）
 */
export async function compressMessages(
  messages: ChatMessageLike[],
  budget: number,
  summarize: (history: ChatMessageLike[]) => Promise<string>
): Promise<CompressResult> {
  const before = estimateTokens(messages);
  // 预算换算：触发 = 窗口×80%，目标 = 窗口×60%
  const trigger = budget * COMPRESS_TRIGGER_RATIO;
  const target = budget * COMPRESS_TARGET_RATIO;
  if (before <= trigger) {
    return { messages, before, after: before, summary: "" };
  }

  // 找压缩边界：从后往前保留最近消息直到 ≤ target（system 消息不参与压缩）
  // 预留摘要消息自身开销（标题 + 400 字摘要正文 ≈ 512 token；保证压缩后整体 ≤ target）
  const RESERVED_FOR_SUMMARY = 512;
  let keepFrom = messages.length;
  let acc = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    acc += estimateTokens([messages[i]]);
    if (acc > target - RESERVED_FOR_SUMMARY) break;
    keepFrom = i;
  }
  // 至少要压缩掉一条（keepFrom 前进至少 1），且不能把 system 压缩掉
  if (keepFrom <= 1) keepFrom = 2; // 保底：压缩最老的一条非 system
  if (keepFrom >= messages.length) {
    // 全部在预算内（理论上不会走到）：不压缩
    return { messages, before, after: before, summary: "" };
  }

  const toCompress = messages.slice(0, keepFrom);
  const kept = messages.slice(keepFrom);
  // 摘要生成失败 → 降级为直接丢弃最老部分（保最新，不阻塞任务）
  let summary = "";
  try {
    summary = (await summarize(toCompress)).trim();
  } catch (e) {
    summary = "";
  }
  const compressed: ChatMessageLike[] = summary
    ? [{ role: "user", content: `【此前会话摘要（历史已压缩，原内容可从会话记录恢复）】\n${summary}` }, ...kept]
    : kept;
  return { messages: compressed, before, after: estimateTokens(compressed), summary };
}

/** 序列化历史给摘要生成器（context.ts 内部用） */
export { serializeHistory, SUMMARIZE_PROMPT };
