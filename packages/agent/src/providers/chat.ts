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

export interface ChatMessageLike {
  role: string;
  content: string | Array<Record<string, unknown>>;
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
  /** 调试：打印原始请求/响应 */
  debug?: boolean;
}

/** 解析 SSE 流，逐 delta 产出 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatDelta> {
  const { baseURL, apiKey, model, messages, tools, signal, timeoutMs = 120000, debug } = opts;

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    };
    if (debug) console.error(`[streamChat] → ${baseURL}/chat/completions body=${JSON.stringify(body).slice(0, 300)}`);

    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (debug) console.error(`[streamChat] ← ${res.status} ${errBody.slice(0, 300)}`);
      throw new Error(`模型 API 请求失败（${res.status}）：${errBody.slice(0, 200)}`);
    }
    if (!res.body) throw new Error("模型 API 无响应体");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // 工具调用增量聚合：index → {id, name, arguments}
    const toolAcc: Record<number, { id: string; name: string; arguments: string }> = {};

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
