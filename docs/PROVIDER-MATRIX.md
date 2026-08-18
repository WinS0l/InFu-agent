# provider 兼容矩阵（v2.2）

> 实测记录：`npm run probe -- <modelId>` 对每个模型跑统一探针（流式/思考字段/工具调用/长输出），结果回填下表。
> 目的：多模型接入的差异处理约定——InFu 的 Agent 循环按 OpenAI Chat Completions 协议工作，各 provider 的差异必须在**接入层**消化，不改循环。

## 矩阵（✅=探针通过 ⚠️=部分支持/有差异 ❌=不支持，右侧为差异说明）

| Provider | 模型 | 流式生成 | 思考字段 reasoning_content | 单轮工具调用 | 多轮工具调用 | 中文长输出 | 上下文窗口（InFu 默认） |
|---|---|---|---|---|---|---|---|
| deepseek | deepseek-v4-flash | ✅ | ✅ 1078 字符 | ✅ | ✅ | ✅ | 1M（模型名匹配） |
| zhipu（GLM） | glm-5.2 | ⏳ 待实测 | ⏳ | ⏳ | ⏳ | ⏳ | 1M（模型名匹配） |
| qwen（通义） | qwen3-coder | ⏳ 待实测 | ⏳ | ⏳ | ⏳ | ⏳ | 256k（模型名匹配） |
| custom（Kimi） | kimi-k3 | ⏳ 待实测 | ⏳ | ⏳ | ⏳ | ⏳ | 1M（模型名匹配） |
| ollama（本地） | qwen3:8b | ⏳ 待实测 | ⏳ | ⏳ | ⏳ | ⏳ | 128k |
| openai | gpt-5.6-luna | ⏳ 待实测 | ⏳ | ⏳ | ⏳ | ⏳ | 1M（模型名匹配） |
| anthropic | claude-sonnet-5 | ⏳ 待实测 | ⏳ | ⏳ | ⏳ | ⏳ | 1M（模型名匹配） |
| google | gemini-3.6-flash | ⏳ 待实测 | ⏳ | ⏳ | ⏳ | ⏳ | 1M |

> ⏳ 实测延后（2026-08-13 决策）：等你配好对应 API Key / 本地 Ollama 后，`npm run probe -- <modelId>` 逐个跑，结果回填。

## 差异处理约定（InFu 接入层的统一规则）

1. **协议**：全部走 OpenAI Chat Completions（`stream: true` SSE）——DeepSeek/智谱/通义/Ollama/自定义网关均提供 `/v1` 兼容接口；OpenAI/Anthropic/Google 未实测前先经兼容端点或官方适配器验证。
2. **思考字段**：`reasoning_content`（DeepSeek 原生）/ `reasoning`（部分兼容网关）都识别；其他模型无该字段则忽略（不报错）。重建消息时保留 `reasoning_content` 供 DeepSeek 续传。
3. **工具调用**：
   - 模型不发 `tool_calls` → Agent 正常收尾输出文本（等价"不调用工具"），不视为错误。
   - 若某 provider 实测**完全不支持工具调用**：模型直接输出文本收尾（等价"不调用工具"），不视为错误——原「建议模式」已随 v2.6.5 移除（主流语义：无工具能力的模型只能纯对话）。
   - 工具调用增量按 `index` 聚合（流式分片 arguments 拼接），坏帧跳过。
4. **错误语义**：非 2xx 统一抛 `ModelApiError{status, retryable}`——429/5xx/408 可重试（指数退避），其他 4xx 不重试；主模型重试耗尽走 `fallbackModelIds` 降级链。
5. **上下文窗口**：按模型 `contextWindow`（显式配置 > 模型名匹配表 > provider 默认 > 128k）触发压缩；实测可据此校准 `MODEL_CONTEXT_WINDOWS`（`packages/agent/src/providers/registry.ts`）。
6. **长文本/中文**：SSE 分帧对 UTF-8 安全（TextDecoder 流式解码），中文无需特殊处理；长输出时注意**两段式超时**（v3.5）：首帧前 min(timeoutMs, 60s) 无数据判「等待响应超时」、首帧后 timeoutMs（默认 300s）无数据判「响应中断」——长思考链/长输出不会因总时长被误杀，服务端挂起才会中止（命中重试/降级属预期行为）。

## 新增 provider 的接入清单

1. `npm run config` 添加模型（或手改 `~/.infu/config.json`）
2. `npm run probe -- <modelId>` 跑探针
3. 差异处理：协议差异 → 看是否走 OpenAI 兼容端点；能力差异 → 标 `capabilities`；窗口差异 → 配 `contextWindow`
4. 结果回填本矩阵
