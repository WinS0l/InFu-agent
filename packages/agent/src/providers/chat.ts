/**
 * InFu 自研 OpenAI 兼容流式客户端
 *
 * 为什么自研（替代 AI SDK v6 调用层）：
 *  1. 所有模型统一走 OpenAI Chat Completions 协议——一个客户端覆盖全部
 *  2. 能拿到 DeepSeek 的 reasoning_content（AI SDK 不解析，导致思考过程丢失）
 *  3. 完全可控：reasoning / 工具调用增量聚合 / 错误细节透出
 *
 * 流式 SSE 格式（OpenAI 兼容，DeepSeek/智谱/通义/Ollama 均同）：
 *  data: {"choices":[{"delta":{"reasoning_content":"...","content":"...","tool_calls":[...]}}]}
 *
 * v2.2 可靠性：单次请求抽为 requestOnce()；streamChat 外层做指数退避重试——
 *   可重试 = 429（尊重 Retry-After）/ 5xx / 408 / 网络失败 / 首帧前超时与断流；
 *   不可重试 = 其他 4xx / 用户中止 / 已产出 delta 后的断流（内容已 emit，无法撤回）。
 */

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string; // 增量片段，需聚合
}

export interface ChatDelta {
  reasoning?: string;
  text?: string;
  toolCalls?: ToolCallDelta[];
  /** 流结束标记 */
  finishReason?: string;
}

/** OpenAI wire 格式消息（含 tool 调用/结果与 DeepSeek 思考字段） */
export interface ChatMessageLike {
  role: string;
  content: string | Array<Record<string, unknown>>;
  /** tool 消息（role="tool" 时）：配对的工具调用 id */
  tool_call_id?: string;
  /** assistant 消息（role="assistant" 时）：模型发起的工具调用 */
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  /** assistant 消息（DeepSeek 兼容）：思考过程 */
  reasoning_content?: string;
}

/** 模型 API 结构化错误（重试/降级判定依据） */
export class ModelApiError extends Error {
  /** HTTP 状态码（网络/超时/流中断时为 undefined） */
  status?: number;
  /** 是否可安全重试（瞬时故障：429/5xx/408/网络/超时/首帧前断流） */
  retryable: boolean;
  /** 429 时服务端建议的等待时长（ms，来自 Retry-After） */
  retryAfterMs?: number;
  constructor(message: string, opts: { status?: number; retryable: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = "ModelApiError";
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface RetryPolicy {
  /** 最大尝试次数（含首次），默认 3（= 失败后重试 2 次） */
  maxAttempts?: number;
  /** 基础退避（ms），指数增长 1s/2s/4s…，默认 1000 */
  baseDelayMs?: number;
}

export interface StreamChatOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessageLike[];
  /** 工具定义（OpenAI tools 格式） */
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 重试策略（瞬时故障指数退避；默认 3 次尝试） */
  retry?: RetryPolicy;
  /** 附加请求体字段（v2 思考级别参数等，按供应商协议透传） */
  extraBody?: Record<string, unknown>;
  /** 调试：打印原始请求/响应 */
  debug?: boolean;
}

/** 睡眠（可被 signal 中止——重试退避期间停止按钮立即生效） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ModelApiError("任务已停止（用户中止）", { retryable: false }));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new ModelApiError("任务已停止（用户中止）", { retryable: false }));
      },
      { once: true }
    );
  });
}

/** 解析 Retry-After（秒或 HTTP 日期；失败返回 undefined） */
function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const t = Date.parse(v);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return undefined;
}

/** 单次请求（fetch + SSE 解析；不重试——重试由 streamChat 外层负责） */
async function* requestOnce(opts: {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessageLike[];
  tools?: StreamChatOptions["tools"];
  signal?: AbortSignal;
  timeoutMs: number;
  extraBody?: Record<string, unknown>;
  debug?: boolean;
}): AsyncGenerator<ChatDelta> {
  const { baseURL, apiKey, model, messages, tools, signal, timeoutMs, extraBody, debug } = opts;

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      ...(extraBody ?? {}),
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    };
    if (debug) console.error(`[streamChat] → ${baseURL}/chat/completions body=${JSON.stringify(body).slice(0, 300)}`);

    let res: Response;
    try {
      res = await fetch(`${baseURL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      // 网络层失败：先区分用户中止 / 超时 / 其他网络错误
      if (signal?.aborted) {
        throw new ModelApiError("任务已停止（用户中止）", { retryable: false });
      }
      if (controller.signal.aborted) {
        throw new ModelApiError(`模型 API 请求超时（${timeoutMs}ms）`, { retryable: true });
      }
      throw new ModelApiError(`模型 API 网络请求失败：${(e as Error).message}`, { retryable: true });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (debug) console.error(`[streamChat] ← ${res.status} ${errBody.slice(0, 300)}`);
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      throw new ModelApiError(`模型 API 请求失败（${res.status}）：${errBody.slice(0, 200)}`, {
        status: res.status,
        retryable,
        retryAfterMs: res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined,
      });
    }
    if (!res.body) throw new ModelApiError("模型 API 无响应体", { retryable: true });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // 工具调用增量聚合：index → {id, name, arguments}
    const toolAcc: Record<number, { id: string; name: string; arguments: string }> = {};

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE 按空行分帧
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // 坏帧跳过
          }

          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          const finish = choice.finish_reason;

          // 思考过程（DeepSeek reasoning_content；其他模型无此字段则忽略）
          if (delta.reasoning_content) {
            yield { reasoning: String(delta.reasoning_content) };
          }
          if (delta.reasoning) {
            yield { reasoning: String(delta.reasoning) };
          }
          // 正文
          if (delta.content) {
            yield { text: String(delta.content) };
          }
          // 工具调用增量
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const acc = (toolAcc[idx] ??= { id: "", name: "", arguments: "" });
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }
          if (finish) {
            yield { finishReason: finish };
          }
        }
      }
    } catch (e) {
      // 流读取中断：用户中止不可重试；其余（首帧前/流中）由外层按 started 决定
      if (signal?.aborted) {
        throw new ModelApiError("任务已停止（用户中止）", { retryable: false });
      }
      throw new ModelApiError(`模型 API 流中断：${(e as Error).message}`, { retryable: true });
    }

    // 流结束后输出聚合好的工具调用
    const finalCalls = Object.entries(toolAcc)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, v]) => ({
        index: Number(Object.keys(toolAcc).find((k) => toolAcc[Number(k)] === v)),
        id: v.id,
        name: v.name,
        arguments: v.arguments,
      }));
    if (finalCalls.length) {
      yield { toolCalls: finalCalls };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** 解析 SSE 流，逐 delta 产出（v2.2：瞬时故障指数退避重试） */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatDelta> {
  const { signal, timeoutMs = 120000, debug, retry: retryPolicy } = opts;
  const maxAttempts = Math.max(1, retryPolicy?.maxAttempts ?? 3);
  const baseDelayMs = retryPolicy?.baseDelayMs ?? 1000;

  let started = false; // 已产出过 delta → 失败不再重试（内容无法撤回）
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      for await (const delta of requestOnce({
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools,
        signal,
        timeoutMs,
        extraBody: opts.extraBody,
        debug,
      })) {
        started = true;
        yield delta;
      }
      return; // 正常完成
    } catch (e) {
      if (signal?.aborted) throw e; // 用户中止：立即透出
      lastError = e;
      if (started) throw e; // 已产出内容后断流：不重试
      const err = e as ModelApiError;
      if (!(err instanceof ModelApiError) || !err.retryable || attempt >= maxAttempts) throw e;

      // 指数退避（429 尊重 Retry-After；加 0~200ms 抖动防惊群）
      let delay = baseDelayMs * 2 ** (attempt - 1);
      if (err.retryAfterMs != null) delay = Math.max(delay, err.retryAfterMs);
      delay += Math.random() * 200;
      if (debug) console.error(`[streamChat] 第 ${attempt}/${maxAttempts} 次尝试失败（${err.message}），${Math.round(delay)}ms 后重试`);
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

/** 把 ToolDef 转成 OpenAI tools 格式（zod → JSON Schema） */
export function zodToJsonSchema(schema: any): Record<string, unknown> {
  // zod v4 原生支持 toJSONSchema；降级用 describe 提取
  try {
    if (typeof schema.toJSONSchema === "function") {
      const s = schema.toJSONSchema();
      return s as Record<string, unknown>;
    }
  } catch {
    /* 降级 */
  }
  return { type: "object", properties: {}, additionalProperties: false };
}
