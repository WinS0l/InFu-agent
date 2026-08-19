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
  /** v3：流式 usage（DeepSeek 末尾 chunk：prompt_cache_hit/miss tokens → 命中率统计；v2.12 加四桶） */
  usage?: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number };
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

/**
 * v3.2 上下文窗口超限识别（对齐 主流 CONTEXT_WINDOW_EXCEEDED）：
 * 400 且消息含上下文/长度/token 超限特征 → 调用方自动压缩后重试一次（估算可能低估）。
 */
export function isContextWindowExceeded(e: unknown): boolean {
  if (!(e instanceof ModelApiError)) return false;
  if (e.status !== 400) return false;
  return /context|上下文|window|exceed|太长|too (long|large)|maximum|limit|token/i.test(e.message);
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
  /** 工具选择策略。摘要等基础设施调用保留稳定的工具前缀，但禁止模型再发起工具。 */
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 重试策略（瞬时故障指数退避；默认 3 次尝试） */
  retry?: RetryPolicy;
  /** v3.2：每次退避重试前回调（前端重试倒计时/审计；断网可见性） */
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void;
  /** 附加请求体字段（v2 思考级别参数等，按供应商协议透传） */
  extraBody?: Record<string, unknown>;
  /** 调试：打印原始请求/响应 */
  debug?: boolean;
}

/** 睡眠（可被 signal 中止——重试退避期间停止按钮立即生效）
 *  v3.6：正常完成时移除 abort 监听器（原 once 注册后 resolve 路径不移除——多次退避
 *  在 signal 上累积监听器，长任务事件面膨胀） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ModelApiError("任务已停止（用户中止）", { retryable: false }));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(new ModelApiError("任务已停止（用户中止）", { retryable: false }));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
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
  toolChoice?: StreamChatOptions["toolChoice"];
  signal?: AbortSignal;
  timeoutMs: number;
  extraBody?: Record<string, unknown>;
  debug?: boolean;
}): AsyncGenerator<ChatDelta> {
  const { baseURL, apiKey, model, messages, tools, toolChoice, signal, timeoutMs, extraBody, debug } = opts;

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  // v3.0 审计修复（B3）：原 timeoutMs 为「总时长」——长输出任务（长文/思考链）中途无
  // 数据也正常，总时长会误杀已开始的流；改「空闲超时」——每次收到数据帧重置计时，
  // 只有长时间无任何数据（服务端挂起/连接死掉）才中止
  // v3.5 补：首字节超时——服务端挂起（connect 成功但无任何数据帧）不再死等空闲超时
  // 300s；60s 内无首个数据帧即中止 → 触发外层重试链（前端状态行可见「正在重试」倒计时）
  let timer: NodeJS.Timeout | undefined;
  let gotData = false;
  const firstByteMs = Math.min(timeoutMs, 60000);
  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), gotData ? timeoutMs : firstByteMs);
  };
  resetIdle();

  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      ...(extraBody ?? {}),
      ...(tools && tools.length ? { tools, tool_choice: toolChoice ?? "auto" } : {}),
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
        throw new ModelApiError(
          gotData
            ? `模型 API 响应中断（${timeoutMs}ms 无数据）`
            : `模型 API 等待响应超时（${firstByteMs}ms 内无任何数据，连接可能挂起）`,
          { retryable: true }
        );
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
    // v3.1 审计修复：usage 最终快照（累计值，流结束时 yield 一次，防倍乘）
    let lastUsage: ChatDelta["usage"] | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          // v3.0 审计修复（B3）：收到数据帧 → 重置空闲计时；v3.5：首个数据帧后进入空闲计时
          gotData = true;
          resetIdle();
          buf += decoder.decode(value, { stream: !done });
        }
        // EOF 并不保证以 SSE 空行结束。冲刷 TextDecoder，并把未分隔的尾帧作为完整帧解析，
        // 否则兼容网关会丢掉最后的正文、usage、finish_reason 或工具调用。
        if (done) buf += decoder.decode();

        // SSE 按空行分帧（v3.7：兼容 \r\n\r\n 分帧端点——自定义网关/代理常返回 CRLF，
        // 原只认 \n\n 时帧永不命中 → buf 无限累积 + 整轮零产出直到空闲超时）
        const frames = buf.split(/\r?\n\r?\n/);
        buf = frames.pop() ?? "";
        if (done && buf.trim()) {
          frames.push(buf);
          buf = "";
        }
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
          // v3.0 批 12：usage 解析从「仅末尾空 choices chunk」放宽为「任意 chunk 携带即收」
          // （部分端点如 agnes/OpenAI 兼容在最后一个正常 chunk 携带 usage，原逻辑会漏）。
          // v3.1 审计修复：usage 是**请求累计快照**而非增量——逐 chunk yield 会让 loop 累加倍乘
          // （Azure/LiteLLM/网关代理类端点每 chunk 带 usage 时统计失真）；改为记录**最后一次**
          // 快照，在流结束（finish/EOF）时统一 yield 一次。顺带修复「usage-only chunk 早产
          // 置 started → 可恢复断流不重试」的副作用。
          // v3.2：usage 语义对齐 主流 mapUsage——DeepSeek 系 wire 的 prompt_tokens **包含**缓存
          // 命中；部分端点只回 prompt_cache_hit_tokens 缺 miss 字段 → miss 推导为
          // prompt - hit（保证 cacheHit + cacheMiss == promptTokens 语义一致，命中率不虚高）
          const u = json.usage;
          if (u && (u.prompt_cache_hit_tokens || u.prompt_cache_miss_tokens || u.prompt_tokens || u.completion_tokens)) {
            // OpenAI 原生字段在 prompt_tokens_details.cached_tokens，DeepSeek 兼容字段在顶层。
            // 两者同时存在时优先顶层（供应商已明确给出 hit/miss）。
            const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
            let miss = u.prompt_cache_miss_tokens;
            if (miss == null && u.prompt_tokens) miss = Math.max(0, (u.prompt_tokens ?? 0) - hit);
            lastUsage = {
              cacheHit: hit,
              cacheMiss: miss ?? 0,
              promptTokens: u.prompt_tokens ?? 0,
              completionTokens: u.completion_tokens ?? 0,
            };
          }
          if (!choice) {
            continue;
          }
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
            if (lastUsage) {
              yield { usage: lastUsage };
              lastUsage = null;
            }
            yield { finishReason: finish };
          }
        }
        if (done) break;
      }
    } catch (e) {
      // 流读取中断：用户中止不可重试；其余（首帧前/流中）由外层按 started 决定
      if (signal?.aborted) {
        throw new ModelApiError("任务已停止（用户中止）", { retryable: false });
      }
      throw new ModelApiError(`模型 API 流中断：${(e as Error).message}`, { retryable: true });
    }

    // 流结束后输出聚合好的工具调用（无 finish 的流：usage 在此兜底 yield 一次）
    if (lastUsage) {
      yield { usage: lastUsage };
      lastUsage = null;
    }
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
  // v3.2：空闲超时 120s → 300s（对齐 主流 DEFAULT_STREAM_IDLE_TIMEOUT_MS）——
  // 深度思考模型思考阶段可能长时间不吐字，120s 会误杀已开始的流
  const { signal, timeoutMs = 300000, debug, retry: retryPolicy, onRetry } = opts;
  const maxAttempts = Math.max(1, retryPolicy?.maxAttempts ?? 3);
  const baseDelayMs = retryPolicy?.baseDelayMs ?? 1000;

  let started = false; // 已产出过 delta → 失败不再重试（内容无法撤回）

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      for await (const delta of requestOnce({
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools,
        toolChoice: opts.toolChoice,
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
      if (started) throw e; // 已产出内容后断流：不重试
      const err = e as ModelApiError;
      if (!(err instanceof ModelApiError) || !err.retryable || attempt >= maxAttempts) throw e;

      // 指数退避（429 尊重 Retry-After；加 0~200ms 抖动防惊群）
      let delay = baseDelayMs * 2 ** (attempt - 1);
      if (err.retryAfterMs != null) delay = Math.max(delay, err.retryAfterMs);
      delay += Math.random() * 200;
      // v3.2：重试可见性——回调通知（前端状态行「正在重试」/审计）
      onRetry?.({ attempt, maxAttempts, delayMs: Math.round(delay), message: err.message });
      if (debug) console.error(`[streamChat] 第 ${attempt}/${maxAttempts} 次尝试失败（${err.message}），${Math.round(delay)}ms 后重试`);
      await sleep(delay, signal);
    }
  }
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
