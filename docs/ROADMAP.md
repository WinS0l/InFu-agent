# InFu 待办路线图（ROADMAP）

> ⚠️ **AGENTS 强制指令**：每个新会话/新阶段开始，必须读取本文件，将**未完成**的高优先级项纳入本阶段计划并推进。完成一项即把状态改为 ✅，之后后续阶段不再需要关注该项。

## 状态图例
- ⏳ 未完成（需要持续推进）
- 🔄 进行中（当前阶段在做）
- ✅ 已完成（无需再关注）

---

## 高优先级（未完成前，每个阶段都要知道）

### ✅ 沙箱中期升级：Windows restricted tokens + job objects（借鉴 OpenAI Codex）【M5 完成 2026-08-12】
- **目标**：将 L1 软沙箱升级为硬沙箱——Agent 命令以受限令牌/作业对象运行，写不了系统目录、读不了敏感文件（OS 级强制，而非仅应用层检查）
- **实现**：Rust N-API 原生模块 `packages/sandbox-rs/`（CreateRestrictedToken 四标志 + CreateProcessWithTokenW/AsUserW 回退 + Job Object 资源上限/杀整树），win32 自动启用，透明降级阶梯 full→reduced→basic→job-only
- **验证**：`npm test` 的 win-sandbox 自测（令牌权限断言/超时杀进程树/消毒端到端）+ 文档 docs/SANDBOX.md「三·五」节

### ✅ 网络出站控制（M6 收尾版：命令级软控制）【完成 2026-08-12】
- **结论**：本机（Windows 11 25H2 build 26200，深度加固 + 未装 Docker）**实测全部 OS 级按进程断网路线不可行**：
  - WFP `ALE_USER_ID` 12 种值编码全被引擎拒绝（WFP 方案死）
  - LSA 特权数据库被加固删除 `SeImpersonate`/`SeAssignPrimaryToken`/`SeIncreaseQuota`，`LsaAddAccountRights` 返回"特权不存在"且**无法补授**（专用账号方案死；SYSTEM 有特权但不可被非提权触发，且 schtasks /SD、TaskScheduler COM、事件触发器全部被硬化封死——SYSTEM 辅助方案死）
  - AppContainer 低盒令牌 + `CreateProcessWithTokenW` = 1314（当前用户低盒方案死）
  - 机器未装 Docker（L2 容器断网暂不可用）
  - 均为**环境限制而非代码缺陷**；若未来落地云版/多租户（microVM 触发），网络隔离随 microVM 在可控环境一并解决
- **完成形态**：应用层命令策略（`net-policy.ts`）——外传命令（curl/wget/nc/ssh/powershell/python 网络调用等）默认拦截（断网语义），`network=true` 经人工审批放行（🌐，-y 不自动放行），审计 `sandbox=egress-blocked`；放行命令仍走 L1.5 受限令牌 + Job
- **验证**：`npm test` 的 win-sandbox-net 自测 21 项（检测/拦截/放行/审计）+ 文档 docs/SANDBOX.md「三·六」
- **OS 级断网的正确姿势**：装 Docker Desktop 后 `INFU_SANDBOX=docker`（L2 自带 `--network none`）；云版落地后 microVM

### ⏳ 沙箱长期升级：Docker microVM 模式（借鉴 Claude Code）【降级为条件触发】
- **目标**：L2 Docker 沙箱从共享内核容器升级为 microVM（独立内核，Docker Desktop 4.58+ 的 VM 模式）
- **完成标准**：`INFU_SANDBOX=docker` 时实际运行在独立内核 VM 中；不可信代码可安全执行
- **⚠️ 触发条件（2026-08-12 重定义）**：microVM 防的是**内核级逃逸**，威胁模型要求"执行不可信代码/多租户场景"（如云版 InFu 落地、执行第三方提交的代码）。**个人本机场景**（自己仓库 + 审批 + 受限令牌）该威胁概率≈0，L1.5 + Docker 容器已覆盖——**不再以"Docker Desktop 4.58+ 普及"作为立项理由**，仅作技术前提；触发时机 = 出现多租户/不可信代码需求

---

## v2 规划（单机个人化深耕，2026-08-12 定稿）

> 定位：v1 已收官（M1–M6）。v2 聚焦单机个人场景体验深度；团队/公司版（v3）触发条件见低优先级区。
> 分期原则：地基先于智能，智能先于生态；**阶段是路线图不是合同**——每期做完按实际体量校准下一期。
> UI 决策必须先讨论后动手（见 AGENTS.md 项目约定）。

### ✅ v2.1 持久化与会话【完成 2026-08-12】
- 会话/任务持久化（数据库层）——记忆/任务/统计/审计全部依赖
- 多会话、历史浏览、继续会话；断点恢复 + Rewind（会话回滚到检查点）
- 配置 schema 基础

### v2.2 模型适配与可靠性【批 1 ✅ 2026-08-13，批 2 ✅ 2026-08-13】
- ✅ **批 1 可靠性核心（2026-08-13）**：
  - API 失败自动重试（chat.ts 重构：`requestOnce` + `ModelApiError` 结构化错误；可重试 = 429（尊重 Retry-After）/5xx/408/网络/超时/首帧前断流，指数退避 1s/2s/4s+jitter；已产出 delta 后断流不重试——内容已 emit 无法撤回）
  - 降级备用模型链（新 `providers/gateway.ts`：`ModelChain` + `streamChatWithFailover`，重试耗尽依次切换，降级后本任务内保持；配置 `ModelConfig.fallbackModelIds` + CLI `--fallback-model`（可重复）+ Web 模型管理弹窗「备用模型」多选 + `model-fallback` 事件（Timeline 徽标/CLI 打印/落库））
  - 消息级上下文重建（新 `db/rebuild.ts`：事件流 → OpenAI wire messages，工具结果按 callId 消费式配对、缺失补占位、孤儿丢弃、reasoning_content 保留）
  - 断点恢复（继续会话 CLI `--session` / Web 带 sessionId 从「摘要注入」升级为「消息级重建续跑」，不重放工具副作用）
  - 顺手修复：loop.ts baseURL 硬编码 deepseek 兜底 bug（zhipu/qwen/ollama 未配 baseURL 打错端点）→ 统一 `resolveBaseURL`；CLI 参数值混入 prompt 的既有 bug
- ✅ **批 2（2026-08-13）**：
  - **上下文压缩按模型因地制宜**（新 `agent/context.ts`：`resolveContextWindow` 显式配置 > 模型名匹配表 > provider 默认 > 128k 兜底；估算超「当前活动模型窗口×80%」触发、压到×60%（预留摘要开销），降级切模型预算自动跟随；摘要失败降级为直接丢弃最老；**DB 事件流始终无损**；`context-compressed` 事件）
  - **动态步数**（新 `agent/steps.ts`：显式 `--max-steps` > Planner 建议（计划文本【建议步数】N，计划卡片可编辑）> 启发式 `estimateComplexity`（模板/长度/关键词）> 默认 30；Planner 12 / Reviewer 10 保持）
  - **轻量模型选择（按角色路由）**：`InfuConfig.roles` / `ModelConfig.roles`（模型声明适配角色）/ CLI `--planner-model|--executor-model|--reviewer-model` / API body `roleModelIds`；`phase-start` 事件带 `model` 字段（Timeline 显示当前阶段模型）；各角色独立降级链
  - **provider 兼容矩阵实测**（`npm run probe -- <modelId>` 探针脚本：流式/思考字段/单双轮工具调用/中文长输出，deepseek 5/5 实测通过；`docs/PROVIDER-MATRIX.md` 模板 + 差异处理约定；**GLM/通义/Kimi/Ollama 等 key 就绪后逐个实测回填**）
  - 验证：`npm test` 179 项全绿（新增 compress 24 / steps 17）+ 真实模型端到端（编排任务动态步数 Planner 建议 5 生效 / phase-start 模型字段 / 角色路由打到 glm-5.2 端点 401 正确失败）+ probe 实测
- ✅ **模型管理重构（v2 供应商凭据，2026-08-13）**：见 AGENTS.md 已完成区（config v2 迁移/供应商模板表 8 家/上游模型获取/思考级别 4 档/Web 双 Tab + 输入框旁选择器；`npm test` 226 项全绿 + 真实 DeepSeek 上游实测）。供应商模板数据 2026-08 联网调研校准（DeepSeek/GLM-5.2/GPT-5.6/Claude 5/Gemini/Kimi 均 1M 窗口）
- ✅ **角色路由面板（2026-08-13）**：Web 模型管理「角色路由」面板（三行模型+思考级别，PUT/GET /api/roles，config roles 支持对象形态，orchestrator 角色级 thinkingLevel 优先）——Web 角色 UI 讨论项已落地
- ✅ **阶段级精确续跑（v2.3 批 1 顺带落地，2026-08-13）**：继续会话时从事件流推断续跑起点——尾部 planner/executor 且有计划事件 → 跳过规划阶段直接 Executor 续跑（计划沿用上次确认的，不重跑 Planner）；无计划/reviewer 尾部/直接模式 → 从头。`inferResumePhase`（agent/resume.ts）+ orchestrator `startPhase`/`resumePlanText`
- ⏳ **遗留**：完整 codex 式模型选择流程（细节实施前讨论）

### v2.3 扩展机制与 MCP【批 1 ✅ 2026-08-13；批 2 待推进】
- ✅ **批 1 MCP 客户端（2026-08-13）**：
  - `@modelcontextprotocol/sdk` 1.30 + 新 `src/mcp/`：client（stdio 子进程 / Streamable HTTP 两种传输 + 20s 握手超时兜底）、schema（JSON Schema → zod 转换器，未知回退 z.any）、tools（ToolDef 适配器：默认 medium 审批防 prompt 注入投毒，`riskOverrides` 工具名精确 > 前缀*通配 > 默认）、index（`loadMcpTools`：只连 enabled、失败跳过不阻塞、重名工具加服务器前缀、任务结束统一 close 防残留子进程）
  - **注入范围**：仅 Executor 阶段与直接模式（Planner/Reviewer 架构级只读不暴露；suggestOnly / /best-of-n 不注入）——server / orchestrator / cli 三处统一 `executorTools` 注入
  - **审批/审计**：复用现有通道——approval-required/result 事件 + tool-start/tool-result 全量落库（会话回放 = 完整审计轨迹）；`commands.log` 仍为 run_command 专用
  - **CLI**：`infu mcp add/list/remove/status`（交互向导 + --type/--command/--args/--url 直传）；**API**：`/api/mcp` CRUD（env 脱敏只回键名）+ `POST /api/mcp/:id/tools` 探测（15s 超时）；**Web**：顶栏「MCP」按钮 → 独立弹窗（列表/启停开关/探测工具+风险徽标/添加表单/两段式删除）
  - **config**：`InfuConfig.mcpServers[]`（zod schema + passthrough 兼容，无需迁移）
  - 验证：`npm test` 290 项全绿（新增 tests/mcp.test.ts 58 项：schema/风险/适配器审批/加载去重/config/API/续跑推断）+ CLI 端到端实测（真实 stdio MCP server：greet 调用成功 / add_note medium 审批拒绝与批准 / 文件落盘 / 事件落库可回放）
  - 安全边界（docs/MCP.md）：MCP 服务器子进程**不受 L1.5 沙箱约束**（配置即信任，工具调用层审批兜底）；Windows 下 npx 需写 `npx.cmd`
  - ✅ **自注册闭环增强（同批，2026-08-13）**：新工具 `mcp_register`（第 11 个内置工具，opencode config-hook 模式）——Agent 可自主「编写 MCP server → 注册给 InFu 自己用」：白名单只写 `mcpServers` 节（models/providers/roles/apiKey 不可达，防自我提权/投毒）+ high 级 requireExplicit 审批（-y 不放行，与联网放行同级）+ 校验与 CLI/API 一致。实测：Agent 自主写 `self-mcp-server.mjs`（get_time）→ mcp_register 注册 my-time（审批批准）→ 下一任务自动注入调用成功。`npm test` 306 项全绿（register 新增 16 项）
- ✅ **批 2 插件系统 v1 + 钩子 + skill（2026-08-13）**：
  - **插件协议**（opencode 式 JS 模块，`docs/PLUGINS.md`）：`PluginDef`（tools 数组或延迟函数 / hooks / skills）+ config `plugins[]` 节 + `loadPlugins`（失败跳过不阻塞/重名加前缀/工具 risk 缺省 medium/只注入 Executor 与直接模式）+ 内置工具 `plugin_add`（第 12 个，high + requireExplicit + 白名单写 plugins 节——Agent 自主装插件闭环）+ CLI `infu plugin add/list/remove/status`（含探测）+ API `/api/plugins` CRUD + probe
  - **函数式钩子**（opencode 式，非命令式）：`preToolUse`（block 拦截/改 args）/`postToolUse`（改 result），挂 loop 统一执行段（对全部工具含 MCP 生效），抛错放行不阻塞；`applyPreToolUseHooks`/`applyPostToolUseHooks` 导出可测。**选型定稿（2026-08-13 联网调研）**：ZCode/Claude Code 的 hooks 是与插件**分离的独立系统**（config 直配 + 子进程 JSON 协议 + user/workspace/plugin 三层），opencode 是插件内函数式统一——InFu 选择 opencode 式（函数式、热加载、简单）；「零插件配钩子」的独立 config 通道**不做**（触发条件：出现真实多端共享钩子/团队策略需求时，届时再评估 B/C 档）
  - **skill 加载**（SKILL.md 社区标准，agentskills.io 规范，progressive disclosure 三级）：发现层 name+description 常驻 Executor system（`buildSkillsPrompt`）+ 激活层内置工具 `use_skill`（第 13 个，low 只读，进 Planner/Reviewer 白名单）读全文 + 执行层按需 read_file references/scripts；目录 `~/.infu/skills/` > `<root>/.infu/skills/` > config `skills[]` 显式；CLI `infu skill add/list/remove` + API `/api/skills`；Web 管理 UI 留 v2.4 设置界面
  - 验证：`npm test` 367 项全绿（新增 tests/plugin.test.ts 61 项）+ 端到端实测（示例插件工具调用 + preToolUse 钩子拦截、SKILL.md use_skill 读取）
### v2.4 设置界面与终端
- 配置系统 UI 化：**权限等级设置**（审批模式/按风险/按工具/命令白名单/通配符/禁用工具）+ **沙箱等级设置**（off/L1/L1.5/L2 Docker/自动，取代 INFU_SANDBOX 环境变量）+ 常规/外观/模型设置
- Web 交互式终端

### v2.5 子智能体与并行
- 子智能体（opencode 式）：委派、独立上下文、并行执行、结果回收；agent 文件化定义（markdown 定义角色/工具/模型）
- best-of-n Web 端并行 UI（并行任务卡片 + 择优对比）

### v2.6 记忆与任务
- 记忆系统三层（项目记忆/任务总和记忆/全局记忆；形态实施前讨论）+ 项目级指令文件（INFU.md）+ 路径作用域规则
- 项目任务看板（agent 可读写可规划）+ 可选 rubric 完成度自评
- Git 优化（diff/暂存/提交/分支 UI）+ 工具调用优化（并行调用/工具选择/错误自适应）

### v2.7 生态与数据
- 插件落地：browser-use、computer-use、文档技能（docx/pdf/pptx）、skill 创建器
- skill 生态完善（导入/导出/模板库/市场雏形，SKILL.md 标准）
- 定时任务/自动化（cron + webhook/HTTP 触发）
- 成本/用量追踪 + 审计可视化/任务回放
- UI 整体打磨（先讨论）+ 团队基础支持（最简多账号/共享/权限）

## 低优先级 / 远期（可做可不做）

- ⏳ **v3 团队/公司版 InFu（触发条件已定义，2026-08-12）**：Agent 跑在云端服务器 + 云端沙箱 + 多租户隔离/认证授权。**触发条件 = 出现第二个真实用户或明确的团队使用场景**——在那之前不做（v2 聚焦单机个人化深耕）。**若落地，microVM 随本项一并触发**（多租户 = 不可信代码场景，ROADMAP 已定义）；届时网络隔离在可控环境（云服务器）下随 microVM 一并解决。v3 立项时再讨论具体形态
- ⏳ WSL2 原生沙箱（bubblewrap/Landlock）作为 L3 备选
- ⏳ /best-of-n Web 端并行 UI（CLI 版已完成，Web 版需审批/计划确认通道加 taskId）

---

## 已完成（历史）

- ✅ M1：monorepo + 任意模型接入 + 10 工具 + Agent 循环 + CLI + 服务层
- ✅ M2：Web 三栏 UI + SSE 流式 + 停止按钮 + 审批队列
- ✅ M3：沙箱 L1（软沙箱）+ L2（Docker 容器）+ 交付报告 + 模型管理 UI
- ✅ 修复：审批队列、停止链路、端口冲突、错误信息透出、maxSteps 30 + 进度总结
- ✅ git worktree 任务工作树（Cursor /worktree 借鉴）：每任务独立分支 + 工作树，任务后手动合并/丢弃，主代码零污染
- ✅ M4：模板任务引导（一键初始化项目/修复测试失败/分析项目/添加功能，Web 空态欢迎面板 + CLI --template）+ Planner/Reviewer 分层编排（Planner 只读规划→计划确认→Executor 执行→Reviewer 只读审查→汇总报告；Web 三档模式选择器 编排/直接/方案 + 可编辑计划卡片，CLI --no-orchestrate/--no-plan-approval）
- ✅ M5：沙箱中期升级（L1.5 Windows 硬沙箱：restricted tokens + job objects，Rust 原生模块 + 降级阶梯 + 自测）+ /best-of-n 并行尝试（CLI `--best-of-n <N>`：N 路独立 worktree 并行完整编排 + 评分择优）
- ✅ **v2.1 持久化与会话（2026-08-12）**：SQLite 会话库 `~/.infu/infu.db`（node:sqlite 零依赖，Node ≥22.5）+ 全量事件流落库（tool-result 存完整输出，Diff 面板升级为完整 diff）+ 会话 API（列表/详情/删除/Rewind）+ Web 左侧栏会话列表（新建/切换/删除/状态徽标）+ 继续会话（历史回顾注入，消息级重建留 v2.2）+ 消息轮次内嵌「回滚到此」（两段式确认，检查点 = user-message/step-start）+ CLI `infu sessions`/`--session <id>` + v1 localStorage 数据一次性迁移 + 配置 zod schema 基础（version 字段/损坏备份/未知字段保留，v2.4 权限/沙箱设置的地基）。验证：`npm test` 86 项全绿 + CLI/Web 端到端实测（真实模型建会话/继续/回滚）
- ✅ **v2.2 批 1 可靠性核心（2026-08-13）**：见上「v2.2 模型适配与可靠性」节（自动重试/降级链/消息级重建/断点恢复，`npm test` 138 项全绿 + CLI 端到端实测）
