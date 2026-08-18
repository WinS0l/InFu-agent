# InFu 技术选型方案

> 版本：v0.1 ｜ 日期：2026-08-12 ｜ 状态：评审稿
> 关联文档：`InFu_产品需求调研报告`（用户/问题/一期范围）、`InFu_产品需求说明书`（PRD）

---

## 一、设计目标

1. **任意大模型可接入**：InFu 不绑定任何模型供应商。OpenAI、Anthropic、Google、DeepSeek、智谱 GLM、通义 Qwen，以及任意 OpenAI 兼容端点、本地模型（Ollama/vLLM）均可即插即用。
2. **软件工程全流程闭环**：理解仓库 → 规划任务 → 修改代码 → 执行测试 → 审查交付。
3. **对小白友好**：自然语言优先、过程可视化、失败可解释。
4. **安全第一**：沙箱隔离、高风险操作审批、真实路径展示（吸收 2026 年 Agent 安全漏洞教训）。

## 二、总体架构

```
┌─────────────────────────────────────────────────┐
│ 前端层（MVP：Web React；后期可套 Electron 壳）      │
│  IDE+Chat 三栏：任务树 | 对话/过程 | Diff/测试      │
└──────────────┬──────────────────────────────────┘
               │ HTTP / SSE（流式）
┌──────────────▼──────────────────────────────────┐
│ Agent 服务层（Node + TypeScript）                 │
│  Planner（规划） → Executor（执行） → Reviewer（审查）│
│  ┌────────────────────────────────────────────┐  │
│  │ 模型接入层：任意 Provider（见第四节）          │  │
│  │ 工具系统：read/write/edit/search/list/       │  │
│  │   run_command/git_status/git_diff/run_test/ │  │
│  │   project_scan + MCP 扩展                    │  │
│  └────────────────────────────────────────────┘  │
└──────────────┬──────────────────────────────────┘
               │ 沙箱边界（Docker 容器 / 进程隔离 + 审批流）
┌──────────────▼──────────────────────────────────┐
│ 执行环境：本地文件系统 / 沙箱容器 / Git / 测试运行器  │
└─────────────────────────────────────────────────┘
```

## 三、技术栈选型（对齐 ZCode + InFu 差异）

ZCode（`@zcode/desktop`）技术栈经安装包解析确认：Electron + TypeScript + React + Redux/zustand + Tailwind/shadcn + Vercel AI SDK + xterm.js + node-pty + remark 全家桶 + echarts + @modelcontextprotocol + playwright-core + ripgrep/ugrep。

| 层 | 选型 | 对齐 ZCode | 说明 |
|---|---|---|---|
| 语言 | TypeScript（全栈） | ✅ | 前后端共享类型定义 |
| 桌面壳 | 一期 Web（Vite），二期 Electron | 部分 | MVP 快速验证；Electron 壳降低开发成本 |
| 前端框架 | React 19 + Vite | ✅ | |
| 状态管理 | zustand（轻量） | ✅（ZCode 双用） | 一期避免 Redux 样板 |
| 样式 | Tailwind CSS v4 + shadcn/ui | ✅ | |
| 流式/SSE | Server-Sent Events | ✅ | Agent 过程逐条推送 |
| 终端 | @xterm/xterm + node-pty | ✅ | 二期桌面端；一期用命令输出回显 |
| Markdown 渲染 | remark/unified + rehype-sanitize | ✅ | AI 回复渲染 |
| 代码高亮/Diff | diff + shiki | ✅ | Diff 视图 |
| 图表 | echarts（可选） | ✅ | 测试结果可视化 |
| MCP | @modelcontextprotocol/sdk | ✅ | 工具生态扩展 |
| 代码搜索 | ripgrep（集成，不内置二进制） | ✅ | `rg` 系统依赖 |
| HTTP 服务 | Hono（轻量） | ✅（ZCode 同用） | Agent 服务层 |
| 校验 | zod | ✅ | 工具参数 schema |
| 沙箱 | Docker（一期进程级+审批兜底） | 差异 | 对齐 GPT/Codex 的容器隔离要求 |

**差异点**：
1. **模型接入层**（核心差异，见第四节）：ZCode 绑定国内大模型目录；InFu 任意模型。
2. **Agent 编排**：ZCode 的 host/scheduler 是通用客户端编排；InFu 实现面向软件工程任务的 Planner/Executor/Reviewer 三层编排与**交付报告**生成。
3. **沙箱策略**：ZCode 默认本机执行；InFu 默认沙箱 + 审批，高风险操作（删除/部署/写敏感路径）强制人工确认，且审批提示展示**解析后的真实绝对路径**（防 CWE-451 UI 误导）。

## 四、AI 接入层设计（与 ZCode 的差异详解）

### 4.1 ZCode 的做法

- **自研 OpenAI 兼容流式客户端**（v2.2 起替代 AI SDK v6 调用层——理由：① 所有模型统一走 OpenAI Chat Completions 协议，一个客户端覆盖全部；② 能拿到 DeepSeek 的 `reasoning_content`（AI SDK 不解析，思考过程丢失）；③ 完全可控：reasoning/工具调用增量聚合/错误细节透出。实现见 `packages/agent/src/providers/chat.ts`）。
- 模型目录固化：`resources/model-providers/models_catalog_china_llm_zcode_2026-06-03.json` —— 内置**中国大模型供应商目录**（DeepSeek、GLM 等），用户在目录内选择，端点是平台预配置的。
- 用户不需要（也不能）自由指定任意 baseURL / 模型标识。
- 结论：ZCode 底层已是"任意模型"架构（gateway 支持注册多 provider），但**产品层把目录固化了**——这是与 InFu 的唯一本质差异。

### 4.2 InFu 的做法：Provider Registry + 任意端点

**核心原则：模型是插件，不是产品的一部分。** 接入层设计为三层：

```
┌──────────────────────────────────────────────────┐
│ ① 用户模型配置（config/models.json / UI 表单）      │
│    { id, provider, model, baseURL?, apiKey?,      │
│      capabilities? }                             │
└────────────────────┬─────────────────────────────┘
┌────────────────────▼─────────────────────────────┐
│ ② Provider 适配层（Registry）                      │
│  ┌──────────────┬──────────────┬───────────────┐ │
│  │ OpenAI       │ Anthropic    │ Google        │ │
│  │ DeepSeek     │ 智谱 GLM     │ 通义 Qwen     │ │
│  │ Ollama/本地   │ 自定义 OpenAI 兼容端点          │ │
│  └──────────────┴──────────────┴───────────────┘ │
│  统一能力探测：toolCalling / streaming / vision   │
└────────────────────┬─────────────────────────────┘
┌────────────────────▼─────────────────────────────┐
│ ③ Agent 消费层（与具体模型解耦）                    │
│   流式请求 + tool calls（自研 OpenAI 兼容客户端）        │
└──────────────────────────────────────────────────┘
```

**与 ZCode 的差异对照**：

| 维度 | ZCode | InFu |
|---|---|---|
| 模型来源 | 内置中国大模型目录 | 任意：内置供应商 + 自定义 OpenAI 兼容端点 + 本地 Ollama |
| 自定义端点 | ❌ 不支持 | ✅ `baseURL + apiKey + model` 即插即用 |
| 能力探测 | 固定目录假设 | 运行时探测（是否支持工具调用/视觉/流式） |
| 供应商适配 | 自研客户端统一 OpenAI Chat Completions 协议 | 同左（DeepSeek/智谱/通义/Ollama/任意兼容网关一视同仁） |
| 密钥管理 | 平台托管 | 本地存储（用户本机 config，不进 git） |
| 多模型策略 | 单一默认 | 每任务可指定模型；无工具调用能力的模型自动降级为纯对话模式 |

**技术实现**：
- 自研 OpenAI 兼容流式客户端（`providers/chat.ts`）——所有模型统一走 Chat Completions 协议（DeepSeek/智谱/通义/Ollama/自定义网关均提供兼容接口；OpenAI/Anthropic/Google 经兼容端点验证）。
- Provider 注册逻辑（网关注册表，产品层开放）：
  1. 全部 provider 统一 OpenAI Chat Completions 协议（`stream: true` SSE），差异在接入层消化（思考字段 `reasoning_content`/`reasoning` 双识别、工具调用按 index 聚合）；
  2. `provider === 'custom'` → OpenAI 兼容端点（`baseURL + apiKey + model`，任何 OpenAI Chat Completions 网关：One API、New API、vLLM、本地代理等）；
  3. `provider === 'ollama'` → 本地模型（qwen、llama 等）。
- **能力探测**（`capabilities`）：尝试一次极短调用或按模型名规则推断 `toolCalling/streaming/vision`；无工具调用能力的模型走纯对话路径（Agent 输出 JSON 指令由执行器解析，降级策略）。
- **降级策略**：模型不支持工具调用时直接纯文本收尾（等价"不调用工具"）；视觉降级（图片附件 → 文本提示重试一次）；上下文超限自动压缩重试。原「建议模式」已随 v2.6.5 移除。

### 4.3 密钥与配置安全

- 模型配置存 `~/.infu/config.json`（用户级，`0600` 权限），**不入库**。
- UI 提供模型管理表单：名称、供应商、模型 ID、baseURL（可选）、API Key（可选）。
- 支持环境变量覆盖：`INFU_OPENAI_API_KEY` 等，便于 CI/无 UI 场景。

## 五、模块划分（monorepo）

```
infu/
├── package.json            # npm workspaces 根
├── docs/                   # 本文档与后续设计
├── packages/
│   ├── shared/             # 共享类型与常量（ChatMessage/ToolCall/Task/ModelConfig…）
│   ├── agent/              # Agent 服务层
│   │   ├── src/
│   │   │   ├── providers/  # 模型接入 Registry（4.2）
│   │   │   ├── tools/      # 基础 10 工具 + MCP 适配
│   │   │   ├── agent/      # Planner/Executor/Reviewer 循环
│   │   │   ├── server.ts   # Hono HTTP + SSE
│   │   │   └── cli.ts      # 命令行入口（调试/演示）
│   │   └── tests/
│   └── web/                # React 前端（三栏 UI）
│       ├── src/pages/      # 对话、任务、Diff
│       └── src/components/
```

## 六、数据流（一次任务）

```
用户输入（自然语言）
  → Planner：项目扫描 + 任务拆解（工具调用序列规划）
  → Executor：逐工具执行，每一步：
      流式推送「思考 → 工具名 → 参数 → 结果摘要」到前端
      高风险操作（删除/写敏感路径/外部命令）→ 审批钩子 → 用户确认
  → 测试/验证：run_test 收集结果
  → Reviewer：只读审查（结论/问题清单/风险）→ 汇总交付文本（交付报告已随 v3.0 移除——执行摘要 + 审查意见直接进对话流）
  → 前端 Diff 视图展示所有变更
```

## 七、MVP 里程碑

| 里程碑 | 内容 | 产出 |
|---|---|---|
| M1（本次） | monorepo 骨架 + AI 接入层 + 10 工具 + Agent 循环 + CLI | CLI 端到端跑通"分析项目" |
| M2 | Hono 服务 + SSE 流式 + 前端三栏 UI（对话/工具过程/Diff） | Web 可交互 demo |
| M3 | 审批流 + 沙箱（进程级→Docker）+ 测试闭环 | 完成 PRD 一期 7 项功能 |
| M4 | 模板任务引导 + 模型管理 UI + 分层编排（交付报告已移除——任务摘要与审查意见进对话流） | MVP 验收（登录功能示例任务） |

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| 任意模型能力参差（无工具调用） | 能力探测 + 降级为建议模式 |
| 沙箱逃逸类漏洞 | 数据层审计、真实路径展示、审批钩子（吸收 GhostApproval/CVE-2026-48124 教训） |
| OpenAI 兼容端点行为不一致 | 以 AI SDK 统一协议 + openai-compatible 兜底，兼容性测试集 |
| 前端与 Agent 流式协议漂移 | shared 包统一类型 + SSE 事件 schema 单一来源 |
