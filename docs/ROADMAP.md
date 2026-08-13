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
### ✅ v2.4 设置界面与终端【批 1 ✅ 2026-08-13，批 2 ✅ 2026-08-13】
- ✅ **批 1 设置界面（2026-08-13）**：
  - **配置 schema 扩展**（shared）：四节全 passthrough 兼容——`approvalPolicy`（mode: auto/smart/confirm 默认 smart + toolOverrides[{tool 精确或前缀*, risk?, disabled?}] + commandAllowlist（* 通配））、`sandbox`（mode: auto/off/soft/restricted/docker 默认 auto，取代 INFU_SANDBOX）、`general`（defaultRoot）、`appearance`（fontSize/streamCursor）
  - **审批策略核心**（新 `approval/policy.ts`）：`shouldAutoApprove` 档位矩阵（auto 全放行/confirm 全人工/smart 现状；requireExplicit 任何档位不豁免）+ `resolveToolRisk`（精确 > 前缀* > 默认）+ `isToolDisabled`（loop 执行段统一拦截全部工具含 MCP/插件）+ `isCommandAllowed`（glob 通配）；guard 加 tool 参数（内置工具逐个接线）+ run_command 危险命令白名单豁免（联网 requireExplicit 永不豁免）+ CLI makeDecider / server requestApproval 接入档位（server auto 档不发弹窗事件）；**顺手修 DANGEROUS 正则 \b 漏检**（dd if=/…、mkfs.ext4 后随符号处无词边界）
  - **沙箱档位**（sandbox/index.ts）：`SandboxMode` 加 restricted（L1.5 独立成档）；`resolveSandboxMode` env 优先 > config.sandbox.mode > auto；`resolveEffectiveMode` 纯函数（auto：docker → win 受限 → soft；restricted 不可用降级 soft；显式 docker 不可用报错不静默；显式 soft 不再隐式 L1.5——语义修正）；`INFU_SANDBOX_RESTRICTED=0` 保留
  - **API**：`GET /api/config`（四节 + defaultModelId + 沙箱可用性检测字段 dockerAvailable/winRestrictedOk）、`PUT /api/config`（白名单只写四节 + defaultModelId，strip 模式拒绝未知字段落盘，防提权与 mcp_register 同模式）；saveConfig 4 份拷贝收敛到 registry 单实现
  - **Web 设置弹窗**（SettingsModal）：顶栏「设置」按钮（Cog）→ w-[820px] 大弹窗 + 左侧竖排导航（常规/权限/沙箱/外观/模型）——权限 Tab（三档 radio 附说明 + 工具覆盖行：工具名/风险下拉/禁用开关 + 命令白名单行）、沙箱 Tab（5 档 + 「当前机器不可用」徽标，docker/restricted 可用性检测）、常规 Tab（默认根目录/默认模型）、外观 Tab（字号 3 档 + 流式光标开关，html data 属性即时应用）、模型 Tab（默认模型 + 跳转完整模型管理）；保存 = 一次 PUT 落盘
- ✅ **批 2 Web 交互式终端（2026-08-13）**：
  - 后端 `terminal/`（新）：session.ts（node-pty 真实 PTY：Windows ConPTY；多会话 Map、输出环形缓冲 64KB 供 SSE 重连重放、服务退出统一清理）+ policy.ts（高危命令检测 DANGEROUS_TERMINAL + auditCommand 落盘 sandbox=terminal）；auditCommand 加 logPath 参数（测试注入）
  - 端点：`POST /api/terminal`（创建，cwd/shell 可选，cmd/powershell/bash 解析）、`POST /api/terminal/:id/input`（**命令级高危审批协议**：携带 command 字段，命中高危且未 confirmed → 拦截返回 requireApproval 不写入；确认后重发执行；每条命令审计）、`POST /api/terminal/:id/resize`、`GET /api/terminal/:id/stream`（SSE：output/exit/ping + 缓冲重放）、`DELETE /api/terminal/:id`、`GET /api/terminal`（列表含诊断字段）
  - **SSE 传输链路修复（关键）**：@hono/node-server 1.19.x 在 Node 24 下 chunked SSE 数据滞留（write 返回 true 但客户端收不到；最小复现 = serve()+streamSSE 即可，与业务无关）——**服务启动改为原生 Node HTTP 转发**（`forwardResponse`：Web Stream → socket，处理背压 drain/客户端断开；`handleNodeRequest`：IncomingMessage → web Request），Hono 路由与 streamSSE 保持不变；实测终端 SSE 与 /api/chat SSE 均正常
  - 前端 TerminalPanel（新）：底部通栏（240px）+ 右下角常驻入口按钮；xterm.js Dark OLED 主题 + FitAddon；输入模型（命令字符本地缓冲 + 预览回显，回车清预览行整行发送、退格删预览、控制字符即时透传、**完整转义序列透传**——修复 xterm 聚焦 focus 报告 ESC[O/ESC[I 混入命令的 bug）；高危确认框（拒绝显示 ⛔ 提示/允许执行）；串行写入队列保证 PTY 输入顺序；收起 = 断开 SSE 会话保留（重连重放）
  - 安全边界（docs/TERMINAL.md）：终端 = 用户亲手输入直连 spawn（不走 L1.5 整命令执行模型——PTY 需交互），env 消毒 + 高危审批 + 全量审计兜底；命令白名单不豁免终端
  - 验证：`npm test` 542 项全绿（新增 approval-policy 54 / sandbox-config 29 / settings-api 45 / terminal 41）+ CLI/浏览器端到端实测（设置弹窗保存落盘 curl 验证；终端输入回显/高危确认拒绝与允许/审计落盘）

### ✅ v2.5 子智能体与并行【完成 2026-08-13】
- ✅ **子智能体（opencode 式，2026-08-13）**：`delegate_task`（第 14 个内置工具）——独立上下文 + 结果回收 + **同轮多工具调用并行执行**（loop 3.2 段 Promise.all，对齐 ZCode）+ `tasks[]` 并行批量（最多 6）；**agent 文件化定义**（`.infu/agents/<name>.md` frontmatter：description/tools/model/maxSteps/thinkingLevel/permission/sandbox）；**内置 agent 对齐 ZCode**（general-purpose=全工具 / explore=只读，调用时机经 ZCode 本机 33 次调用实证：explore 67% 只读探索调研 / general-purpose 33% 深度审计）；**审批对齐 ZCode**（只读委派免审批、写能力一次授权、内部继承授权、requireExplicit 红线逐条、agent 名不存在直接报错）；**展示对齐 opencode/Claude Code**（主对话流条目 + 右侧栏完整消息流弹窗，内部过程不进主对话流）；**摘要完整接收**（≤2000 字结构化约定 + 20K 兜底）；设置面板可编辑 agent（工具/权限/沙箱/模型/推理强度）；`npm test` 641 项全绿 + CLI/浏览器端到端
- ✅ **best-of-n 按用户评审完全移除（2026-08-13）**：同任务 N 路竞速被判定多余（同模型同工具产出趋同；主流 Agent 并发全是「不同任务并行」）——删除 CLI `--best-of-n`、server 分支、Web 第 4 档模式 + TrialsPanel、tests/parallel.test.ts、docs/BEST-OF-N.md；真并发 = delegate tasks 不同任务并行（见上）

### v2.6 记忆与任务【✅ 批 1 + 批 2 完成 2026-08-13；✅ v2.6.1 会话中枢重构；收尾项视体量】
- ✅ **v2.6.1 会话中枢重构（2026-08-13，用户纠正「任务=会话」误称后定稿）**：
  - **概念修正**：会话（Session）是核心对象，项目是容器，任务看板是误称产物——**任务看板整体删除**（`.infu/tasks/` 模块/4 个 task 工具/`/api/tasks`/KanbanView/TaskModal/NewTaskModal/侧栏任务区/tasksPrompt 引导段/tasks.test.ts 59 项）
  - **记忆系统修正（用户拍板逻辑）**：五层→四层——「发生的事」进会话历史（SQLite）、「总结」进项目历史（.infu/history/ 自动沉淀）、「下次该怎么干」进项目/全局记忆（memory_read/write）、「你必须遵守的」进 INFU.md；**任务记忆（L3）删除**；记忆读取按会话 root 解析路径（自由会话读全局记忆 + root 下 .infu/memory 若存在——对齐 Claude 每目录独立记忆 + 全局兜底）；生成时机 = 会话中 Agent 判断未来有用性主动写（Claude Auto Memory 模式）+ 会话结束自动归档（Codex 即时简化版）；**memory_write 敏感凭据检测**（Codex secret-redactor 轻量版：sk-/AKIA/私钥/Bearer/连接串/JWT 等模式命中拒绝写入）
  - **会话管理**（sessions 表幂等迁移加 pinned/archived 列 + `PATCH /api/sessions/:id`：重命名/顶置/归档；listSessions 支持 archived 过滤）
  - **项目注册表**（新 `src/projects.ts`：`~/.infu/projects.json`；GET/POST/DELETE /api/projects——会话按 root 命中注册表判断隶属，未命中 = 自由会话；创建校验目录存在、重复拒绝、损坏备份；**移除项目只删注册**，会话保留为自由会话、文件夹不删）
  - **侧栏（用户定稿会话中枢）**：顶部 新建会话（CTA，选中项目 = 在项目下新建）/定时任务[规划中]/技能（位置不变）/搜索（Ctrl+K）；**Archive 归档入口 + 全部收起**（置顶区上方）；**已顶置区**（项目栏上方）；项目区（折叠全部项目 + 创建项目 + 项目行[移除两段式确认][新建会话] + 组内会话平铺[重命名行内编辑/顶置/归档 hover 按钮] + 显示更多）；自由会话区；Archive 弹窗（恢复/删除）；创建项目弹窗（Web 受限无法读文件夹绝对路径 → 路径输入 + 历史 root 选择）
  - 验证：`npm test` 全绿（memory 85 + projects 21 新增 + session-store 30 扩展；tasks 59 已删）+ API 级端到端（创建项目→会话归属→顶置/重命名/归档→移除项目会话保留）+ 浏览器（侧栏结构渲染/创建项目弹窗/cua 点击链路；IAB broker 故障期间降级 cua + API 验证）
  - ⏳ 遗留：记忆索引/剪枝（v2.7）、记忆生成的后台提炼管道（Codex 6h 模式，暂用即时归档替代）
- ✅ **三档模式移除（2026-08-13，用户定稿）**：「编排/直接/方案」三档整体删除——用户判断权限维度已被设置页全局审批档位（auto/smart/confirm + 工具覆盖）覆盖、流程维度应交给 AI 自适应（v2.6.5 优化）；删除 Web 模式选择器（Shift+Tab）/CLI `--suggest`/`--no-orchestrate`/suggestOnly 方案模式（loop 只读白名单与输出拦截）/orchestrate 分支（server/CLI direct 直跑分支）；**唯一流程 = Planner 规划 → 计划确认（--no-plan-approval 可跳过）→ Executor 执行 → Reviewer 审查**；沉淀元数据删「模式」字段；测试更新（memory 85 全绿，全量 20 套件）
- ✅ **批 1 记忆核心（2026-08-13，用户拍板五层设计）**：
  - **分层（结合用户「任务/项目历史/会话历史拆分」意见 + 主流 agent 调研）**：L0 项目指令 INFU.md（用户权威规则，类似 CLAUDE.md/AGENTS.md——Codex 明确分工：团队规则进指令文件、历史决策进记忆）→ L1 全局记忆 ~/.infu/memory/（跨项目偏好）→ L2 项目记忆 .infu/memory/（项目约定/教训，主题文件 conventions/lessons/preferences）→ L3 任务记忆 .infu/tasks/（批 2，Claude Code Tasks 同款：任务≠会话，跨会话存活）→ L4 项目历史 .infu/history/（任务完成自动沉淀，只增不改）→ L5 会话历史 SQLite（已有，原始事件流）。**任务/项目历史/会话历史是三个独立维度**（Claude Code 2026-01 Tasks API 核心洞察：TodoWrite 会话内便签重启即失，Tasks 持久化跨会话）
  - **项目指令文件**（新 `src/memory/infu.ts`）：`<root>/INFU.md` 优先、`<root>/AGENTS.md` 生态兜底；**全量注入所有阶段 system**（Planner/Reviewer 也须遵守规则）；32KiB 上限截断（Codex project_doc_max_bytes 同款）
  - **路径作用域**（INFU.md 声明式）：`- 允许: X` / `- 禁止: Y`（`**` 跨段、`*` 单段、尾部 `/**` 匹配根本身）；语义对齐 Claude Code deny>ask>allow——命中禁止直接拒绝、有允许规则时未命中拒绝（白名单模式）；工具层接线 read_file/write_file/edit_file/list_directory（与 isProtectedPath 同模式）；ToolContext 新增 scopeRules
  - **记忆读写**（新 `src/memory/store.ts`）：文件系统即记忆（生态共识：files are the truth，git 可版本化）；主题 = 目录下 *.md，首次访问自动创建默认模板；`memory_read`（low，进 Planner/Reviewer 白名单——规划时了解项目约定）/ `memory_write`（medium，append 带时间戳 / replace 覆盖）；**~/.infu 写保护精确化**：isProtectedPath 不变（write_file 依旧拦截），memory_write 是全局记忆唯一合法写入通道（topic 白名单 ^[a-zA-Z0-9_-]{1,64}$ 防路径穿越）
  - **自动沉淀**（新 `src/memory/sediment.ts`）：任务完成（report 生成后）归档到 .infu/history/YYYY-MM-DD.md——标题/时间/模型/模式/步数/审批统计/改动概览（write/edit/test/command/memory_write）/执行摘要/交付报告全文/审查意见；**零额外模型调用**（用户拍板：报告归档+工具补充；稳定约定由 Agent 中途 memory_write 记录——Executor system 注入记忆引导段）；沉淀失败不影响交付；orchestrator 内部 + CLI/server 直接/方案模式三处挂点
  - 验证：`npm test` 720 项全绿（新增 memory.test.ts 77 项：指令发现/作用域解析校验/glob 转换/主题读写/写保护精确化/工具接线/沉淀防爆）+ **CLI 端到端实测**（真实 agnes 模型三连：任务 1 创建 README + memory_write 约定 → 任务 2 memory_read 读回约定（跨任务记忆闭环）→ 任务 3 访问禁止路径被工具层拦截「命中禁止规则 secret/**」且 Agent 遵守）
  - ⏳ **遗留（v2.7）**：记忆索引/剪枝机制（Codex memories 30 天剪枝 + 秘密脱敏、AutoMem 索引 200 行加载——渐进读取靠 Agent 自觉 + 主题分类，长期膨胀需机制兜底；已按用户评审标注）
- ~~批 2 任务看板（2026-08-13）~~：**v2.6.1 按用户评审整体删除**（「任务=会话」误称产物；实现含 .infu/tasks/ 文件 + task 工具 + Kanban 视图 + rubric，均已移除，详见 v2.6.1 概念修正节）
### v2.7 生态与数据
- 插件落地：browser-use、computer-use、文档技能（docx/pdf/pptx）、skill 创建器
- skill 生态完善（导入/导出/模板库/市场雏形，SKILL.md 标准）
- 定时任务/自动化（cron + webhook/HTTP 触发）
- 成本/用量追踪 + 审计可视化/任务回放
- UI 整体打磨（先讨论）+ 团队基础支持（最简多账号/共享/权限）

## 低优先级 / 远期（可做可不做）

- ⏳ **v3 团队/公司版 InFu（触发条件已定义，2026-08-12）**：Agent 跑在云端服务器 + 云端沙箱 + 多租户隔离/认证授权。**触发条件 = 出现第二个真实用户或明确的团队使用场景**——在那之前不做（v2 聚焦单机个人化深耕）。**若落地，microVM 随本项一并触发**（多租户 = 不可信代码场景，ROADMAP 已定义）；届时网络隔离在可控环境（云服务器）下随 microVM 一并解决。v3 立项时再讨论具体形态
- ⏳ WSL2 原生沙箱（bubblewrap/Landlock）作为 L3 备选
- ⏳ 子智能体增强（恢复子智能体 / 后台模式——参考 Claude Code `SendMessage` 恢复与 Agent View 仪表盘；InFu 事件全量落库已具备重放基础）

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
