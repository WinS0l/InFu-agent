# InFu（Infinite Future）

软件工程智能体平台 — 让 AI 从"代码补全工具"升级为能理解项目、规划任务并执行工程工作的开发伙伴。

> 状态：M1 开发中（Agent 核心已可用，Web UI 开发中）
> 相关文档：[技术选型方案](docs/TECHNICAL-SELECTION.md)

## 核心能力（一期 MVP）

- **AI 对话中心**：自然语言任务输入，流式输出
- **项目分析**：`project_scan` 自动识别技术栈（Node/Python/Go/Rust/Java…）与项目结构
- **文件修改引擎**：读/写/精确编辑（带路径越界防护与审批钩子）
- **Terminal 执行**：shell 命令运行（高风险命令强制审批）
- **测试运行**：自动检测测试框架（npm test / pytest / go test / cargo test）
- **Diff 查看**：Git 工作区/暂存区 diff
- **Git 工作流**：status / diff
- **分层编排（M4 + v2.3）**：Planner（只读规划 + **计划确认三态**：用户自由回复 → AI 判断 执行/修订/中止，如"先不做"立即停止）→ Executor（执行）→ Reviewer（只读审查），Web 顶栏/CLI 可一键关闭回退单 Agent；**回滚按钮在用户消息上**（撤销该条指令及其后的内容，微信撤回式）
- **模板任务引导（M4）**：一键初始化项目 / 修复测试失败 / 分析项目 / 添加功能（Web 空态欢迎面板 + CLI `--template`）
- **任意大模型接入**：OpenAI / Anthropic / Google / DeepSeek / 智谱 GLM / 通义千问 / Ollama / 任意 OpenAI 兼容网关

## 项目结构

```
packages/
├── shared/   # 共享类型（ModelConfig / AgentEvent / ToolDef…）
└── agent/    # Agent 服务层
    ├── src/providers/  # 模型接入 Registry（任意模型）
    ├── src/tools/      # 10 个基础工具
    ├── src/agent/      # Agent 循环（工具调用 + 审批）
    ├── src/server.ts   # Hono HTTP + SSE 服务
    └── src/cli.ts      # 命令行入口
```

## 快速开始

### Windows 一键启动（推荐小白）

双击根目录的 **`start-infu.bat`**：
1. 首次运行自动安装依赖
2. 自动打开**交互式配置向导**（选择模型供应商 → 填入 API Key）
3. 启动 Agent 服务

### 命令行方式

```bash
npm install          # 1. 安装依赖

npm run config       # 2. ★ 交互式配置模型与 API Key（推荐）
                     #    选择供应商 → 填模型 ID → 填 API Key → 自动保存

npm run infu -- "分析这个项目的技术栈和结构" --root .   # 3. 使用 CLI
npm run start        #    或启动服务（http://127.0.0.1:4317，Web UI 后端）
```

### 手动配置（进阶）

编辑 `~/.infu/config.json`（**API Key 只存 `providers`，模型不再存 Key**；v1 旧格式自动迁移）：

```json
{
  "version": 2,
  "defaultModelId": "deepseek-v4-flash",
  "roles": { "planner": "deepseek-v4-flash", "reviewer": "local-qwen" },
  "providers": [
    { "id": "deepseek", "name": "DeepSeek", "kind": "deepseek", "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-xxx" },
    { "id": "local-qwen", "name": "本地 Ollama", "kind": "ollama" }
  ],
  "models": [
    { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "providerId": "deepseek", "model": "deepseek-v4-flash", "contextWindow": 1000000, "thinkingLevels": 2, "fallbackModelIds": ["local-qwen"] },
    { "id": "local-qwen", "name": "本地 Ollama", "providerId": "local-qwen", "model": "qwen3:8b" }
  ]
}
```

**供应商模板机制（v2）**：Web 模型管理 → 供应商 Tab → 添加供应商 → 选类型（DeepSeek/OpenAI/Claude/Gemini/智谱/通义/Kimi/Ollama）自动填 API 地址与上下文窗口 → 填 Key →「获取模型」从上游 `/models` 拉取列表 → 勾选启用（窗口/思考级别按模板预设，可逐模型改）。

**思考级别（v2）**：4 档 UI（快速/标准/深度/极限）按模型实际级别数自动映射——如 DeepSeek V4 3 级：第 1 级 = 非思考、第 2 级 = 思考（high）、3-4 级 = 极限思考（max）；GPT-5.6 4 级直通（low/medium/high/xhigh）。CLI `--thinking 1-4`，Web 输入框左下方选择器。**小众模型**：模型编辑表单的「思考参数覆盖」可为每档级别自定义请求字段（JSON 数组，优先级高于供应商自动映射），如 `[{"thinking":{"type":"disabled"}},{"thinking":{"type":"enabled"}},null]`。

**支持任意 OpenAI 兼容端点**：`provider: "custom"` + `baseURL`，可用于 One API、New API、vLLM、本地代理等一切实现 OpenAI Chat Completions 协议的服务。

也可用环境变量代替 apiKey：`INFU_DEEPSEEK_API_KEY`、`INFU_OPENAI_API_KEY`、`INFU_ZHIPU_API_KEY` 等。

**备用模型降级链（v2.2）**：`fallbackModelIds` 配置主模型失败时的备用模型列表（也可在 Web 模型管理弹窗或 CLI `--fallback-model` 指定）。API 瞬时故障（429/5xx/超时/网络中断）自动指数退避重试（1s/2s/4s），重试耗尽自动切换到备用模型，全程 `model-fallback` 事件可见。

**上下文压缩（v2.2，按模型因地制宜）**：`contextWindow`（token）配置模型上下文极限；缺省按 provider/模型名推断（deepseek/GLM 128k、Qwen/Kimi 256k、Claude 200k、Gemini 1M、兜底 128k）。历史估算超窗口 ×80% 时自动压缩为摘要（压到 ×60%），**只影响发给模型的上下文，会话记录无损**；降级切模型后预算自动跟随新模型。

**按角色路由（v2.2+ 轻量模型选择）**：规划/执行/审查 可分别指定模型**与独立思考级别**——Web 模型管理 → 模型 Tab → 「角色路由」面板（三行各选模型 + 思考级别 1-4，未设置跟随默认/全局）；config 层 `roles` 支持 `"模型id"` 或 `{"model": "id", "thinkingLevel": 3}`；CLI `--planner-model` / `--executor-model` / `--reviewer-model` 最高优先。各角色自带独立降级链。

### 3. 使用 CLI

```bash
# 分析项目
npm run infu -- "分析这个项目的技术栈和结构" --root .

# 修改代码（-y 自动批准所有操作）
npm run infu -- "把 README 的标题改成 InFu" --root . -y

# 方案模式（v2.3：只读分析 + 测试，绝不修改文件）
npm run infu -- "优化这个函数" --root . --suggest

# 模板任务（M4 小白引导，默认开启 Planner→Reviewer 分层编排）
npm run infu -- --template fix-tests --root . -y        # 一键修复测试失败
npm run infu -- --template init-project --root . -y     # 一键初始化新项目

# 编排控制
npm run infu -- "任务" --root . -y --no-orchestrate     # 关闭分层编排（单 Agent 直跑）
npm run infu -- "任务" --root . -y --no-plan-approval   # 不要求确认计划，直接执行

# 会话（v2.1+ 持久化，v2.2 消息级重建续跑）
npm run infu -- sessions                                # 会话历史列表
npm run infu -- --session <id> "继续的指令"               # 继续会话（完整恢复历史与进度，不重放工具副作用）

# 模型（v2.2+）
npm run infu -- "任务" --fallback-model <id> [--fallback-model <id>...]   # 备用模型降级链
npm run infu -- "任务" --thinking <1-4>                              # 思考级别（按模型实际级别数自动映射）
npm run infu -- "任务" --planner-model <id> --executor-model <id> --reviewer-model <id>   # 按角色指定模型
npm run probe -- <modelId>   # provider 兼容性探针（流式/思考字段/工具调用/长输出）
```

### 4. 启动服务（Web UI 后端）

```bash
npm run start -w @infu/agent
# 服务监听 http://127.0.0.1:4317
# GET  /api/health   健康检查
# GET  /api/models   模型列表（脱敏）
# POST /api/chat     Agent 任务（SSE 流式）
```

## 安全设计

- **路径越界防护**：所有文件操作限制在项目根目录内
- **审批钩子**：写文件/编辑/执行命令前请求用户确认（Web UI 挂接；CLI 可用 `-y` 自动批准），支持队列化处理
- **高风险命令检测**：`rm -rf` / `format` 等强制审批
- **沙箱（L1 软沙箱，默认）**：环境变量消毒（API Key 不进命令环境）、敏感路径写保护（~/.ssh、~/.infu 等）、命令审计（~/.infu/logs/commands.log）
- **沙箱（L1.5 Windows 硬沙箱）**：Windows 下命令以受限令牌 + Job Object 执行（Rust 原生，借鉴 OpenAI Codex）——写系统目录/提权被 OS 级拒绝、资源上限、超时杀进程树；透明降级（full→reduced→basic→仅Job），`INFU_SANDBOX_RESTRICTED=0` 禁用
- **沙箱（L2 Docker）**：检测到 Docker 自动启用——默认断网、项目只读挂载、资源限制（2g/2c/256pids）、非 root、任务后销毁、凭据不进容器；`INFU_SANDBOX=soft|docker|off` 可切换
- **交付报告**：任务结束自动生成结构化报告（改动清单/测试结果/命令执行/失败项/风险提示）
- **Key 不入库**：API Key 存 `~/.infu/config.json`（或环境变量），.gitignore 已排除

详细设计见 [docs/SANDBOX.md](docs/SANDBOX.md)。

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | monorepo + 模型接入 + 10 工具 + Agent 循环 + CLI + 服务层 | ✅ 完成（真实模型验证） |
| M2 | Web 三栏 UI（对话/工具过程/Diff）+ SSE 流式 + 停止/审批队列 | ✅ 完成 |
| M3 | 沙箱（L1 软沙箱 + L2 Docker）+ 交付报告 + 模型管理 UI | ✅ 完成 |
| M4 | 模板任务引导（小白一键开跑）+ Planner/Reviewer 分层编排 | ✅ 完成 |
| M5 | Windows 硬沙箱（restricted tokens + job objects，Rust 原生）+ `/best-of-n` 并行尝试（CLI） | ✅ 完成 |
