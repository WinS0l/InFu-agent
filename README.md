# InFu（Infinite Future）

软件工程智能体平台 — 让 AI 从"代码补全工具"升级为能理解项目、规划任务并执行工程工作的开发伙伴。

> 状态：v4.0（Agent 核心 + Web UI + Windows 桌面端 + 嵌入式浏览器均可用；43 套测试套件 1329 断言全绿）
> 相关文档：[技术选型方案](docs/TECHNICAL-SELECTION.md)、[路线图](docs/ROADMAP.md)

## 核心能力

- **AI 对话中心**：自然语言任务输入，流式输出（思考过程/工具调用/审批请求实时可见）
- **52 个内置工具**：文件读写（read-before-edit 三层门禁）、shell 命令（沙箱分派）、Git、测试、搜索、语义检索、LSP 诊断、记忆、子智能体委派（并行/后台）、异步任务编排、计算机操作（桌面截图/点击/输入）等
- **任意大模型接入**：DeepSeek / OpenAI / Anthropic / Google / 智谱 GLM / 通义千问 / Ollama / 任意 OpenAI 兼容网关；备用模型降级链 + 上下文自动压缩
- **分层编排（可选）**：Planner（只读规划 + 计划确认三态）→ Executor → Reviewer（只读审查）；默认单一 Agent 循环直接执行（主流做法），`--orchestrate` 显式开启
- **Windows 桌面端（Electron）**：嵌入式真浏览器（Agent 可驱动网页操作）、computer-use 桌面控制、系统通知/托盘、开机自启（可选）
- **会话持久化**：SQLite 全量事件流 + 消息级重建续跑 + 回滚 + 自动归档；使用统计（活跃热力图/Token 趋势）
- **扩展生态**：MCP 服务器、JS 插件（工具/钩子/技能）、SKILL.md 技能、定时任务、模板任务引导
- **安全纵深**：审批档位（auto/smart/confirm/full）+ 沙箱分级（软/L1.5 受限令牌/Docker）+ 断网默认 + SSRF 防护 + 本地令牌鉴权

## 项目结构

```
packages/
├── shared/      # 共享类型 + 网络地址判定工具（ModelConfig / AgentEvent / ToolDef…）
├── agent/       # Agent 服务层
│   ├── src/providers/  # 模型配置注册表 + OpenAI 兼容流式客户端
│   ├── src/tools/      # 52 个工具（文件/Git/命令/网络/记忆/子智能体/computer-use）
│   ├── src/agent/      # Agent 循环（工具调用 + 审批 + 上下文压缩）+ 分层编排
│   ├── src/sandbox/    # 沙箱（软/L1.5 受限令牌/Docker/断网策略）
│   ├── src/server.ts   # Hono HTTP + SSE 服务（本地令牌鉴权）
│   └── src/cli.ts      # 命令行入口
├── web/         # React 19 + Vite 前端（对话/审批/设置/统计/终端）
├── desktop/     # Electron 桌面壳（宿主后端 + 嵌入式真浏览器 + CDP 桥）
└── sandbox-rs/  # Rust N-API 原生模块（Windows 受限令牌 + Job Object 硬沙箱）
```

## 快速开始

### Windows 一键启动（推荐小白）

双击根目录的 **`start-infu.bat`**：
1. 首次运行自动安装依赖
2. 自动打开**交互式配置向导**（选择模型供应商 → 填入 API Key）
3. 启动 Agent 服务

### 桌面端（Electron，嵌入式真浏览器 + computer-use）

```bash
npm run dev:desktop -w @infu/web   # 开发：前端 vite 专用端口 5199
npm run start -w @infu/desktop     # 启动桌面应用（开发模式）
npm run pack -w @infu/desktop      # 打包 NSIS 安装程序（详见 docs/DESKTOP.md）
```

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

**上下文压缩（v2.2，按模型因地制宜）**：`contextWindow`（token）配置模型上下文极限；缺省按 provider/模型名推断（2026-08 校准：DeepSeek/GLM-5.2/GPT-5.6/Claude Sonnet-5/Kimi K3/Qwen 3.6 均 1M、Gemini 1M、兜底 128k）。历史估算超窗口 ×80% 时自动压缩为摘要（压到 ×60%），**只影响发给模型的上下文，会话记录无损**；降级切模型后预算自动跟随新模型。

**按角色路由（v2.2+ 轻量模型选择）**：规划/执行/审查 可分别指定模型**与独立思考级别**——Web 模型管理 → 模型 Tab → 「角色路由」面板（三行各选模型 + 思考级别 1-4，未设置跟随默认/全局）；config 层 `roles` 支持 `"模型id"` 或 `{"model": "id", "thinkingLevel": 3}`；CLI `--planner-model` / `--executor-model` / `--reviewer-model` 最高优先。各角色自带独立降级链。

### 3. 使用 CLI

```bash
# 分析项目
npm run infu -- "分析这个项目的技术栈和结构" --root .

# 修改代码（-y 自动批准所有操作）
npm run infu -- "把 README 的标题改成 InFu" --root . -y

# 模板任务（M4 小白引导）
npm run infu -- --template fix-tests --root . -y        # 一键修复测试失败
npm run infu -- --template init-project --root . -y     # 一键初始化新项目

# 分层编排（显式开启：Planner→计划确认→Executor→Reviewer；默认单一循环直接执行）
npm run infu -- "任务" --root . --orchestrate           # 显式启用分层编排（计划确认后执行）
npm run infu -- "任务" --root . --orchestrate --no-plan-approval   # 编排但不弹计划确认

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

- **审批档位**：auto（低中自动）/ smart（低自动）/ confirm（全人工）/ full（完全信任，红线也放行，**默认档位**——2026-08-18 用户拍板「最大审批权限，全自主不弹窗」）——工具级覆盖 + 命令白名单 + 会话级「已批准记忆」；**安全红线不降级**（受保护路径/SSRF/路径作用域/显式禁用工具在任何档位下都拦截）
- **路径越界防护**：所有文件操作限制在项目根目录内（词法 + realpath 双检防符号链接逃逸）；敏感路径写保护（~/.ssh、~/.infu、~/.aws 等）
- **read-before-edit**：写文件/编辑前必须已读取（未读/截断视图/文件被外部修改均拒绝），写后刷新指纹
- **高风险命令检测**：`rm -rf` / `Remove-Item` / `format` / `dd if=` 等多分支变体强制 requireExplicit 审批；命令白名单命中仍过组合符与高危双检
- **沙箱（L1 软沙箱，默认）**：环境变量消毒（API Key 不进命令环境）、敏感路径写保护、命令审计（~/.infu/logs/commands.log，5MB×3 轮转）
- **沙箱（L1.5 Windows 硬沙箱）**：Windows 下命令以受限令牌 + Job Object 执行（Rust 原生，借鉴 OpenAI Codex）——写系统目录/提权被 OS 级拒绝、资源上限、超时杀进程树
- **沙箱（L2 Docker）**：检测到 Docker 自动启用——默认断网、项目只读挂载、资源限制、非 root、任务后销毁、凭据不进容器
- **断网默认**：命令/工具默认断网执行，外传命令（curl/wget/ssh/python 网络调用等）需 `network=true` 人工审批
- **SSRF 防护**：webfetch 拒绝内网/回环/云元数据（IPv4 简写与 IPv6 变体完整归一化），重定向逐跳复查
- **本地令牌鉴权**：托管前端时随机 token 注入 index.html，`/api/*` 校验 X-InFu-Token；CORS + Origin/Host 白名单防 CSRF/DNS rebinding
- **凭据保护**：Key 只存 `~/.infu/config.json`（0600）或环境变量；命令输出/记忆写入前敏感凭据检测；MCP/终端子进程环境消毒
- **Key 不入库**：API Key 存 `~/.infu/config.json`（或环境变量），.gitignore 已排除

详细设计见 [docs/SANDBOX.md](docs/SANDBOX.md)。

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | monorepo + 模型接入 + 10 工具 + Agent 循环 + CLI + 服务层 | ✅ 完成 |
| M2 | Web 三栏 UI（对话/工具过程/Diff）+ SSE 流式 + 停止/审批队列 | ✅ 完成 |
| M3 | 沙箱（L1 软沙箱 + L2 Docker）+ 交付报告 + 模型管理 UI | ✅ 完成 |
| M4 | 模板任务引导 + Planner/Reviewer 分层编排 | ✅ 完成 |
| M5 | Windows 硬沙箱（restricted tokens + job objects，Rust 原生） | ✅ 完成 |
| M6 | 网络出站控制（命令级断网策略 + 联网审批） | ✅ 完成 |
| v2-v3.5 | 会话持久化/子智能体/MCP/插件/技能/记忆/定时任务/桌面端/computer-use/异步编排（见 docs/ROADMAP.md） | ✅ 完成 |
