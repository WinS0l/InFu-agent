/**
 * InFu 模型网关 — 降级链（v2.2 可靠性）
 *
 * 分工：
 *  - streamChat（chat.ts）：单模型瞬时故障重试（429/5xx/网络/超时，指数退避）
 *  - 本模块：主模型重试耗尽 → 切换到备用模型的降级链
 *
 * 关键语义：
 *  - ModelChain 保存跨步骤的活动模型状态（降级后本任务内保持，不自动回主模型，防抖动）
 *  - streamChatWithFailover 对当前活动模型调用 streamChat；
 *    未产出任何内容时的失败 → 降级到下一个候选重试；
 *    已产出内容后的失败 → 直接抛（内容已 emit 无法撤回，与重试语义一致）
 */

import { streamChat, ModelApiError, type ChatDelta, type ChatMessageLike, type RetryPolicy } from "./chat.js";
import type { StreamChatOptions } from "./chat.js";
import { resolveBaseURL } from "./registry.js";

/** 运行时模型配置（主/备用候选；来自 config 模型解析） */
export interface ModelCandidate {
  /** 展示/审计用 id（config 中模型 id；无则回退 model 名） */
  id?: string;
  provider: string;
  model: string;
  baseURL?: string;
  apiKey: string;
  /** 上下文窗口（v2.2 压缩预算；压缩预算跟随当前活动模型） */
  contextWindow?: number;
  /** 实际推理级别数（v2 思考级别映射；1=无思考） */
  thinkingLevels?: number;
  /** 思考参数覆盖（v2 小众模型：每档级别自定义请求参数；优先于供应商协议映射） */
  thinkingOverride?: Array<Record<string, unknown> | null>;
}

/** 模型链：降级状态跨调用保持（同一任务内不自动回主模型） */
export class ModelChain {
  private activeIdx = 0;
  private onFallback?: (from: string, to: string, reason: string) => void;

  constructor(
    public readonly candidates: ModelCandidate[],
    opts: { onFallback?: (from: string, to: string, reason: string) => void } = {}
  ) {
    if (!candidates.length) throw new Error("模型链为空（至少需要一个候选模型）");
    this.onFallback = opts.onFallback;
  }

  /** 当前活动模型 */
  get active(): ModelCandidate {
    return this.candidates[this.activeIdx];
  }

  /** 展示名（id 优先，用于事件/审计） */
  name(c: ModelCandidate): string {
    return c.id ?? c.model;
  }

  /**
   * 降级到下一个候选。
   * @returns 新活动模型；链已耗尽返回 null（保持原活动模型）
   */
  fallbackToNext(reason: string): ModelCandidate | null {
    if (this.activeIdx >= this.candidates.length - 1) return null;
    const from = this.name(this.active);
    this.activeIdx++;
    this.onFallback?.(from, this.name(this.active), reason);
    return this.active;
  }
}

export interface FailoverOptions {
  /** 模型链（活动模型状态跨调用保持） */
  chain: ModelChain;
  messages: ChatMessageLike[];
  tools?: StreamChatOptions["tools"];
  toolChoice?: StreamChatOptions["toolChoice"];
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: RetryPolicy;
  /** v3.2：退避重试回调透传（前端重试可见性） */
  onRetry?: StreamChatOptions["onRetry"];
  /** 附加请求体字段（v2 思考级别参数；按当前活动模型计算——降级切模型后参数跟随） */
  extraBody?: (candidate: ModelCandidate) => Record<string, unknown> | undefined;
  debug?: boolean;
}

/** 带降级链的流式调用：当前模型重试耗尽 → 依次切换备用模型 */
export async function* streamChatWithFailover(opts: FailoverOptions): AsyncGenerator<ChatDelta> {
  const { chain, messages, tools, toolChoice, signal, timeoutMs, retry, extraBody, debug, onRetry } = opts;

  let started = false;
  while (true) {
    const active = chain.active;
    try {
      for await (const delta of streamChat({
        baseURL: resolveBaseURL(active.provider as any, active.baseURL),
        apiKey: active.apiKey,
        model: active.model,
        messages,
        tools,
        toolChoice,
        signal,
        timeoutMs,
        retry,
        onRetry,
        extraBody: extraBody?.(active),
        debug,
      })) {
        started = true;
        yield delta;
      }
      return; // 正常完成
    } catch (e) {
      if (signal?.aborted) throw e; // 用户中止：不透出降级逻辑
      if (started) throw e; // 已产出内容后失败：不降级（内容无法撤回）
      // Credentials and other terminal client errors cannot be recovered by trying every fallback.
      if (e instanceof ModelApiError && !e.retryable && e.status !== 400) throw e;
      // 未产出任何内容：尝试降级链
      const next = chain.fallbackToNext(`模型失败：${(e as Error).message.slice(0, 120)}`);
      if (!next) throw e; // 链耗尽：透出原始错误
      started = false;
      // 用新模型重试当前轮（从头生成）
    }
  }
}
