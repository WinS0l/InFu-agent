# InFu — 项目状态与开发指南（Agent 必读）

> 本文件由 ZCode 在每个新会话自动加载。开发前先读本节，避免重复劳动或方向错误。

## ⚠️ 强制指令（每次会话必须执行）

1. **读取 `docs/ROADMAP.md`**——其中 ⏳ 未完成项是持续待办，**完成之前每个阶段都要知道并推进**（目前高优先级仅剩"沙箱长期升级 microVM"，触发条件未到）。
2. 将未完成的高优先级项纳入本阶段计划；**完成一项即在 ROADMAP 中标记 ✅**，之后后续阶段不再关注它。
3. 本阶段工作完成后，更新 AGENTS.md 与 ROADMAP.md 的状态（已完成项移入历史区）。

## 项目是什么

InFu（Infinite Future）——软件工程智能体平台。用户用自然语言给 AI 下开发任务，AI 在代码仓库里自主完成：分析项目 → 规划 → 修改代码 → 跑测试 → 输出交付报告。

## 技术栈（已定，勿改）

- **monorepo**：npm workspaces（`packages/shared`、`packages/agent`、`packages/web`、`packages/sandbox-rs`）
- **后端**：Node + TypeScript + **AI SDK v6**（`ai@6.0.250`，配套 provider 3.x；DeepSeek/智谱/通义/Ollama/自定义端点统一走 `createOpenAI({baseURL})`，OpenAI/Anthropic/Google 用官方 3.x 适配器）
- **原生模块**：Rust N-API（napi-rs，`packages/sandbox-rs/`）——Windows 硬沙箱（restricted tokens + job objects）。构建需 MSVC C++ 工具链（VS 2022 BuildTools VCTools 工作负载）；`npx napi build --platform --release` 产出 `index.node`（不入库）。cargo 1.97 + stable-x86_64-pc-windows-msvc
- **前端**：React 19 + Vite + Tailwind v4 + zustand（设计系统来自 ui-ux-pro-max skill：Dark OLED 深色 + 运行绿 #22C55E，图标用 lucide-react，禁用 emoji 图标）
- **服务**：Hono + SSE 流式（端口 4317，冲突自动递增；Web 端口 5174）

## 常用命令

```bash
npm install                    # 装依赖
npm run build                  # shared → sandbox-rs(native) → agent
npm run config                 # 交互式模型配置向导（~/.infu/config.json，Key 不入库）
npm run infu -- "任务" --root <路径> -y   # CLI 跑 Agent
npm run infu -- "任务" --root <路径> -y --best-of-n 3   # /best-of-n 并行尝试（N 路 worktree + 评分择优）
npm run infu -- sessions       # 会话历史（v2.1：每次任务自动落库）
npm run infu -- --session <id> "继续的指令"   # 继续之前的会话（v2.2：消息级重建续跑，完整恢复历史）
npm run infu -- "任务" --fallback-model <id> [--fallback-model <id>...]   # 备用模型降级链（v2.2）
npm run infu -- "任务" --planner-model <id> --executor-model <id> --reviewer-model <id>   # 按角色指定模型（v2.2）
npm run infu -- "任务" --thinking <1-4>   # 思考级别（v2：按模型实际级别数自动映射）
npm run infu -- mcp add/list/remove/status   # MCP 服务器管理（v2.3：工具动态注入执行阶段）
npm run infu -- plugin add/list/remove/status   # 插件管理（v2.3 批 2：JS 模块 = 工具/钩子/技能）
npm run infu -- skill add/list/remove   # 技能管理（SKILL.md 社区标准）
npm run probe -- <modelId>   # provider 兼容性探针（v2.2：流式/思考字段/工具调用/长输出）
npm run start                  # 启动 Agent 服务
npm run test                   # 工具/模板/沙箱/会话库/重试/重建/降级/压缩/步数自测（平台自动门控）
start-infu.bat                 # Windows 一键启动（服务 + Web + 浏览器）
```

## 已完成（勿重复开发）

- M1：AI 接入层（任意大模型）、10 基础工具、Agent 循环（30 步上限+进度总结）、CLI、Hono/SSE 服务
- M2：Web 三栏 UI（对话/工具过程/Diff）、停止按钮（abort 全链路）、审批队列
- M3：**沙箱 L1**（环境变量消毒/敏感路径写保护/命令审计）+ **沙箱 L2**（Docker：断网/只读挂载/资源限制/任务后销毁）、**交付报告**（buildReport，任务结束自动生成）、**模型管理 Web UI**（CRUD API + 弹窗）
- git worktree 任务工作树：每任务独立分支 + 工作树，任务后手动合并/丢弃（server 三端点 + Web 开关/操作条）
- M4：**模板任务引导**（4 模板：初始化项目/修复测试失败/分析项目/添加功能；Web 空态欢迎面板 + CLI `--template`）+ **Planner/Reviewer 分层编排**（`orchestrator.ts`：Planner 只读规划 → 计划确认 → Executor 全工具执行 → Reviewer 只读审查 → 汇总报告；Web 输入框旁**三档模式选择器**（编排/直接/方案，Shift+Tab 切换）+ **计划卡片**（可编辑、批准后执行，`POST /api/plan/:id`）；CLI `--no-orchestrate`/`--no-plan-approval`）
- M6：**网络出站软控制策略**（本机实测全部 OS 级按进程断网路线不可行——WFP 引擎拒绝/LSA 特权被加固删除且授不回去/AppContainer 低盒 WithTokenW 1314/SYSTEM 辅助触发通道全被硬化封死/未装 Docker，详见 ROADMAP；落地为命令级策略 `net-policy.ts`：外传命令 curl/wget/nc/ssh/powershell 网络调用等默认拦截，`network=true` 经人工审批放行（🌐，-y 不放行），审计 `egress-blocked`；OS 级断网的正确姿势 = Docker L2 `--network none` 或未来云版 microVM）
- M5：**沙箱 L1.5 Windows 硬沙箱**（Rust 原生 `packages/sandbox-rs/`：CreateRestrictedToken 四标志 + Job Object 资源上限/杀整树 + 降级阶梯 full→reduced→basic→job-only；win32 自动启用；`INFU_SANDBOX_RESTRICTED=0` 禁用；run_command 与 run_test 统一走 `execLocal` 分派，修复了 run_test 绕过沙箱的缺口）+ **`/best-of-n` 并行尝试**（CLI `--best-of-n <N>`：N 路独立 worktree 并行完整编排，评分择优：测试×40/工具成功率×25/报告×20/效率×15，任务后保留 worktree 手动合并/丢弃）
- 后台日志：`~/.infu/logs/agent.log`（全事件）+ `commands.log`（命令审计，含沙箱档位）
- ✅ **v1 收官（2026-08-12）**：M1–M6 全部落地（模型接入/10 工具/Agent 循环/Web UI/审批/沙箱 L1·L1.5·L2/编排/模板/best-of-n/网络软控制），`npm test` 68 项全绿，CLI+Web 端到端实测正常。剩余项（云版/microVM/WSL2 沙箱/best-of-n Web UI）均为 v1 范围外，见 ROADMAP
- ✅ **v2.1 持久化与会话（2026-08-12）**：SQLite 会话库 `~/.infu/infu.db`（node:sqlite，零依赖，**需 Node ≥22.5**，本机 24）+ 全量事件流落库（tool-result 存完整输出，Diff 面板升级为完整 diff）+ 会话 API（列表/详情/删除/Rewind）+ Web 左侧栏会话列表（新建/切换/删除/状态徽标）+ 继续会话（历史回顾注入，消息级上下文重建留 v2.2）+ 消息轮次内嵌「回滚到此」按钮（两段式确认；检查点 = user-message/step-start 事件）+ CLI `infu sessions` / `--session <id>` + v1 localStorage 数据一次性迁移 + 配置 zod schema 基础（version 字段/损坏自动备份/未知字段保留）。`npm test` 86 项全绿 + 真实模型端到端实测（建会话/继续/回滚/Web 重放）
- ✅ **v2.2 批 1 可靠性核心（2026-08-13）**：API 失败自动重试（`chat.ts` 重构：429/5xx/408/网络/超时指数退避 1s/2s/4s+jitter，尊重 Retry-After；已产出 delta 后断流不重试）+ **降级备用模型链**（新 `providers/gateway.ts`：`ModelChain` 重试耗尽依次切换、任务内保持不自动回主模型；配置 `ModelConfig.fallbackModelIds` + CLI `--fallback-model`（可重复）+ Web 模型弹窗「备用模型」多选 + `model-fallback` 事件落库/Timeline 徽标/CLI 打印）+ **消息级上下文重建**（新 `db/rebuild.ts`：事件流 → OpenAI wire messages，callId 消费式配对/缺失补占位/孤儿丢弃/reasoning_content 保留）+ **断点恢复**（继续会话升级为消息级重建续跑，不重放工具副作用；CLI `--session` / Web 带 sessionId 自动获得）+ 顺手修复（loop baseURL 硬编码 deepseek 兜底 bug → `resolveBaseURL` 统一解析；CLI 参数值混入 prompt 的既有 bug）。`npm test` 138 项全绿（新增 retry/rebuild/fallback 52 项）+ CLI 端到端实测（真实模型建会话/继续重建/fallback 解析/未知 id 警告）
- ✅ **v2.2 批 2（2026-08-13）**：**上下文压缩按模型因地制宜**（新 `agent/context.ts`：`resolveContextWindow`（显式 > 模型名表 > provider > 128k）+ 超「当前活动模型窗口×80%」触发压到×60%，降级切模型预算跟随，摘要失败降级丢弃最老，DB 事件流无损）+ **动态步数**（新 `agent/steps.ts`：显式 `--max-steps` > Planner 建议【建议步数】N > 启发式 > 30）+ **轻量模型选择按角色路由**（`InfuConfig.roles`/`ModelConfig.roles`/CLI `--planner-model` 等/API `roleModelIds`；`phase-start` 带 `model` 字段；角色独立降级链）+ **provider 兼容矩阵**（`npm run probe -- <modelId>` 探针，deepseek 5/5；`docs/PROVIDER-MATRIX.md` 模板，其余 provider 待 key 实测回填）。`npm test` 179 项全绿（新增 compress 24/steps 17）+ 端到端（动态步数 Planner 建议生效/角色路由打到 glm 端点）。**遗留：Web 角色 UI 形态实施前单独讨论**

- ✅ **方案模式升级 + 计划确认三态化（v2.3，2026-08-13）**：① 方案模式（suggestOnly）从「无工具纯文本」升级为「只读工具 + run_test」（写工具/命令工具架构级不注入，绝不改文件）；② **计划确认三态**（新 `agent/plan-feedback.ts`）：用户自由文本回复 → 模型判断 `execute/revise/abort`——execute（回复作指示注入执行）/ revise（Planner 按意见重新规划再确认，最多 2 轮）/ abort（任务停止，不执行不审查；"先停下来先不做"实测正确中止）；Web 计划卡片改「提交/取消」（回复输入框 + 计划可编辑），CLI 交互输入回复文本（空=批准）；修复 CLI 双 readline 抢 stdin bug（makeDecider 统一 getLines 单实例）；③ **回滚按钮移到用户消息**（回滚语义 = 撤销这条指令及其后内容，微信撤回式；不再挂在 assistant 消息）。缓存/产物策略借鉴生态共识：不自动清理项目内产物，隔离靠 worktree
- ✅ **角色路由面板（v2.3，2026-08-13）**：Web 模型管理 → 模型 Tab「角色路由」面板——规划/执行/审查 三行各选模型 + 独立思考级别（1-4，未设置跟随默认/全局）；config `roles` 支持 `{model, thinkingLevel}` 对象形态（zod union 兼容旧 string）；`PUT /api/roles` / `GET /api/roles` 端点；orchestrator 角色级 thinkingLevel 优先于全局；resolveRoleThinking 解析。验证：角色路由端到端（规划阶段真实切到 local-qwen）+ 232 项测试全绿
- ✅ **模型管理重构（v2 供应商凭据，2026-08-13）**：config 升级 v2（`providers[]` 存凭据 + `models[]` 经 `providerId` 引用，**模型层不再存 API Key**；v1 配置读取时在线迁移归并，写回持久化）+ **供应商模板表**（`providers/templates.ts` 8 家：选类型自动填 baseURL/默认窗口/思考级别，2026-08 联网调研校准：deepseek/GLM-5.2/GPT-5.6/Claude5/Gemini/Kimi 均 1M 窗口）+ **上游模型获取**（`POST /api/providers/:id/models` 拉 OpenAI 兼容 `/models`，Web 勾选启用，模板预设匹配窗口/级别）+ **思考级别 4 档 UI**（`mapThinkingLevel`：UI 1→最弱、2-4 按比例映射到模型实际级别数；`buildThinkingParams` 按供应商协议注入：deepseek `thinking.type`、openai/kimi `reasoning_effort`、zhipu `thinking+effort`、qwen `enable_thinking`、google `thinkingConfig.thinkingLevel`；CLI `--thinking 1-4` + Web 输入框旁选择器 + 4 档按钮）+ **Web 模型管理弹窗双 Tab**（供应商：模板添加/获取模型勾选/删除连带模型；模型：窗口/思考级别/备用模型编辑）+ ChatPanel 输入框左下方模型选择器（供应商分组 + 思考级别）。`npm test` 226 项全绿（新增 config-migration 15 / thinking 24 / providers-api 7）+ 浏览器实测（真实 DeepSeek 上游拉取 v4-flash/v4-pro）+ config 迁移实测
- ✅ **v2.3 批 1 MCP 客户端（2026-08-13）**：`@modelcontextprotocol/sdk` 1.30 + 新 `src/mcp/`（client：stdio 子进程/Streamable HTTP 双传输 + 20s 握手超时；schema：JSON Schema→zod 转换器（未知回退 z.any）；tools：ToolDef 适配器——**默认 medium 审批**防 prompt 注入投毒，`riskOverrides` 工具名精确 > 前缀*通配；index：`loadMcpTools` 只连 enabled/失败跳过不阻塞/重名加服务器前缀/任务结束统一 close 防残留子进程）+ **注入范围仅 Executor 阶段与直接模式**（Planner/Reviewer 架构级只读不暴露；suggestOnly 与 /best-of-n 不注入）+ **审批/审计复用现有通道**（approval-required/result 事件 + tool-start/tool-result 全量落库 = 会话回放审计）+ **CLI** `infu mcp add/list/remove/status`（交互向导 + --type/--command/--args/--url 直传）+ **API** `/api/mcp` CRUD（env 脱敏只回键名）+ `POST /api/mcp/:id/tools` 探测（15s 超时）+ **Web 顶栏「MCP」按钮独立弹窗**（列表/启停开关/探测工具+风险徽标/添加表单/两段式删除）+ config `mcpServers[]` 节（passthrough 兼容，无需迁移）+ **阶段级精确续跑**（v2.2 遗留落地：`inferResumePhase`——尾部 planner/executor 且有计划 → 跳过规划直接 Executor 续跑，计划沿用上次确认的；无计划/reviewer 尾部/直接模式从头）。`npm test` 290 项全绿（新增 mcp 58 项）+ **端到端实测**：CLI（真实 stdio server：greet 注入调用成功 / add_note medium 审批拒绝与批准 / 文件落盘 / 事件落库可回放）+ Web（弹窗列表/启停/探测工具+风险徽标 / 任务中「MCP 服务器已连接」事件 / 模型调用 greet → medium 审批弹窗 → 批准 → 回复回填 + 交付报告）。**安全边界**：MCP 服务器子进程不受 L1.5 沙箱约束（配置即信任，工具层审批兜底）；Windows 下 npx 需写 npx.cmd——详见 docs/MCP.md
- ✅ **自注册闭环增强（v2.3 批 1 追加，2026-08-13）**：新工具 `mcp_register`（第 11 个内置工具；opencode config-hook 自注册模式）——**Agent 可自主「编写 MCP server → 注册给 InFu 自己用」**：`src/mcp/register.ts` 白名单只写 `mcpServers` 节（models/providers/roles/apiKey 不可达，防自我提权/投毒）+ **high 级 requireExplicit 审批**（-y 不放行，与联网放行同级；Web 弹窗人工确认）+ 校验与 CLI/API 一致（id 生成/command 或 url 非空/重名拒绝）。**闭环实测**：真实任务中 Agent 参考项目内示例自主编写 `packages/agent/tests/fixtures/self-mcp-server.mjs`（get_time 工具）→ 调用 mcp_register 注册 `my-time`（high 审批批准）→ 下一任务自动注入并成功调用 get_time。`npm test` 306 项全绿（register 新增 16 项）
- ✅ **v2.3 批 2 插件系统 v1 + 钩子 + skill（2026-08-13）**：**插件协议**（opencode 式 JS 模块，`PluginDef`：tools 数组或延迟函数/hooks/skills；config `plugins[]` 节；`loadPlugins` 失败跳过不阻塞、重名加前缀、工具 risk 缺省 medium、只注入 Executor 与直接模式）+ 内置工具 **`plugin_add`**（第 12 个：high + requireExplicit + 白名单写 plugins 节——Agent 自主装插件闭环）+ CLI `infu plugin add/list/remove/status`（含探测）+ API `/api/plugins` CRUD+probe；**函数式钩子**（opencode 式）：`preToolUse`（block 拦截/改 args）/`postToolUse`（改 result）挂 loop 统一执行段（对全部工具含 MCP 生效），抛错放行不阻塞，`applyPreToolUseHooks/applyPostToolUseHooks` 导出可测；**skill 加载**（SKILL.md 社区标准 agentskills.io，progressive disclosure 三级：描述常驻 Executor system + 内置工具 **`use_skill`**（第 13 个，low 只读，进 Planner/Reviewer 白名单）读全文 + 按需 read_file references/scripts；`~/.infu/skills/` > `<root>/.infu/skills/` > config `skills[]`；CLI `infu skill add/list/remove` + API `/api/skills`；Web 管理 UI 留 v2.4 设置界面）。`npm test` 367 项全绿（新增 plugin 61 项）+ 端到端实测（示例插件工具调用 + preToolUse 钩子拦截、SKILL.md use_skill 读取）。安全边界：插件代码在 Agent 进程内运行（比 MCP 信任级别更高，配置即信任），详见 docs/PLUGINS.md
- ✅ **技能自编写闭环 + 写保护精确化（v2.3 批 2 追加，2026-08-13）**：skill 走**文件系统即注册**——Agent 用 write_file 写 `<root>/.infu/skills/<name>/SKILL.md` 即自动发现（下一任务描述注入 system + use_skill 可用），无需注册工具。为此修复 `isProtectedPath`：`.infu` 写保护从「任意层级匹配」精确到**仅用户级 `~/.infu`**（项目内 .infu/skills 是合法场景放开写；~/.infu 配置/凭据/日志仍保护）。实测：Agent 自主编写 review-checklist 技能 → 下一任务自动发现 → use_skill 读取 → 按清单真实执行代码审查。测试新增写保护断言 6 项（plugin 套件 67 项）
- ✅ **扩展管理 Web 弹窗（v2.3 批 2 补完，2026-08-13）**：顶栏「扩展」按钮 → `ExtensionsModal`（双 Tab：插件/技能，Dark OLED 骨架）——插件 Tab（添加 id+path / 启停开关 / 「加载」探测展示工具列表含风险徽标 + 钩子 pre×N/post×N 徽标与详情 / 两段式删除）、技能 Tab（列表含来源层级徽标（用户级/项目级/显式引用）+ 描述 + 移除显式引用、添加 name+path 可选）；浏览器实测通过（sample 插件工具/钩子展示、sample-skill 添加与列表）。至此 MCP/插件/技能三通道 Web 可视化齐全（钩子为插件属性，在插件卡片内展示）
- 📌 **钩子形态选型定稿（2026-08-13 联网调研）**：ZCode/Claude Code 的 hooks 是与插件**分离的独立系统**（config 直配 + 子进程 JSON 协议 + user/workspace/plugin 三层，详见 ROADMAP v2.3 批 2）；InFu 定稿 **opencode 式统一**（钩子 = 插件内 JS 函数，函数式/热加载/简单）。「零插件配钩子」的独立 config 通道**不做**，触发条件 = 真实多端共享钩子/团队策略需求（届时评估命令式兼容档）
- ✅ **v2.4 批 1 设置界面（2026-08-13）**：config 四节（approvalPolicy/sandbox/general/appearance，全 passthrough）+ **审批策略核心**（`approval/policy.ts`：三档 auto/smart/confirm + 工具覆盖/禁用（精确>前缀*>默认）+ 命令白名单 glob；guard 加 tool 参数接线、run_command 白名单豁免、loop 层禁用兜底、CLI/server 档位接入；顺手修 DANGEROUS 正则 \b 漏检）+ **沙箱档位**（SandboxMode 加 restricted 独立成档、resolveEffectiveMode 纯函数、显式 soft 不再隐式 L1.5、env 优先 config）+ `GET/PUT /api/config`（白名单四节 + defaultModelId，strip 防提权；saveConfig 4 拷贝收敛 registry）+ **Web 设置弹窗**（顶栏设置按钮 → w-[820px] 左导航大弹窗：常规/权限/沙箱/外观/模型 5 Tab，L2 档「当前机器不可用」徽标，外观字号/光标即时应用）。`npm test` 501 项全绿（新增 approval-policy 54/sandbox-config 29/settings-api 45）+ 浏览器实测（档位/覆盖/白名单/L1.5 沙箱保存落盘 curl 验证）
- ✅ **v2.4 批 2 Web 交互式终端（2026-08-13）**：`terminal/`（node-pty 真实 PTY：Windows ConPTY；会话 Map + 输出环形缓冲 SSE 重连重放 + 服务退出清理）+ 端点（创建/输入[命令级高危审批协议：未 confirmed 拦截 requireApproval]/resize/SSE 流/删除）+ **SSE 传输链路修复（关键）**：@hono/node-server 在 Node 24 下 chunked SSE 数据滞留（最小复现 serve()+streamSSE，与业务无关）→ 服务启动改**原生 Node HTTP 转发**（forwardResponse：Web Stream→socket + 背压/断开处理），Hono 路由与 streamSSE 不变，实测终端/chat SSE 均正常 + 前端 TerminalPanel（xterm 底部通栏 + 右下角入口；本地预览缓冲 + 转义序列透传修复 focus 报告污染；高危确认框拒绝/允许；串行写入队列）+ docs/TERMINAL.md（安全边界：终端直连不走 L1.5，高危审批 + 全量审计兜底，白名单不豁免终端）。`npm test` 542 项全绿（新增 terminal 41）+ 浏览器实测（输入回显/高危确认/审计落盘）
- ✅ **设置界面信息架构升级（v2.4 追加，2026-08-13，用户定稿三组导航）**：设置弹窗左侧导航按三组组织——**基础设置**（常规/外观/模型设置/浏览器[规划中]）、**Agent 能力**（记忆[规划中]/插件/技能/子智能体[规划中]/MCP 服务器/命令/钩子）、**数据与统计**（索引库[规划中]/使用统计[规划中]）；MCP/插件/技能/钩子从独立弹窗**内嵌**进设置（新 `SettingsPanes.tsx`：McpPane/PluginsPane/SkillsPane/HooksPane/ComingSoonPane，删除 McpManagerModal/ExtensionsModal）；「命令」= 原权限 Tab 重组（审批档位 + 工具覆盖/禁用 + 命令白名单 + 沙箱等级 + 高危命令红线说明）；未实现功能显示**禁用态占位 + 规划中徽标**（信息架构一步到位，后续版本往里填）；顶栏「扩展」「MCP」按钮改为打开设置并定位对应 Tab；浏览器实测通过（三组导航/内嵌页真实数据/顶栏跳转高亮/占位点击无效）。**追加（用户定稿「对号入座」）**：模型管理弹窗也彻底内嵌（ModelManagerModal → ModelPane 去壳保留全部功能：供应商 CRUD/上游拉取/模型 CRUD/角色路由面板），顶栏「扩展」「MCP」「模型管理」三按钮**全部删除**，仅剩「设置」单一入口；模型管理全部功能归入「模型设置」Tab

## 未完成 / 下一步

**以 `docs/ROADMAP.md` 为准**（本处仅摘要）：
- 🔄 **v2 按 ROADMAP 7 阶段推进**（v2.1 ✅，v2.2 ✅ 全两批，v2.3 ✅ 全两批，v2.4 ✅ 全两批：设置界面 + Web 交互式终端）：下一步 **v2.5 子智能体与并行**（子智能体：opencode 式委派/独立上下文/并行执行/结果回收，agent 文件化定义；best-of-n Web 端并行 UI）。v2.2 遗留仅剩：**完整 codex 式模型选择流程**（细节实施前讨论）
- ⏳ 沙箱长期升级 microVM（**已降级为条件触发**：仅多租户/不可信代码场景需要，如云版 InFu 落地时）
- ⏳ 低优先级：**v3 团队版 InFu**（触发条件 = 出现第二个真实用户/团队需求，届时 microVM 一并触发，见 ROADMAP）、WSL2 原生沙箱、/best-of-n Web 端并行 UI

## 项目约定（用户明确要求，2026-08-12）

- **UI 决策必须先讨论后动手**：v2.1 设计系统升级、v2.3 整体打磨，以及任何新页面/新交互的视觉方案，动手前必须先与用户讨论定稿（用户强调"到时候必须讨论"）
- **v2 聚焦单机个人化**：团队/公司版（v3）触发条件 = 出现第二个真实用户或明确团队需求，届时再讨论
- **记忆系统形态**（项目记忆/任务总和记忆/全局记忆三层）与**模型选择流程**（codex 式）细节，实施前单独讨论定稿

## 安全红线（不可妥协）

- API Key 只存 `~/.infu/config.json`（0600），严禁入库、严禁进沙箱环境
- 沙箱写保护：`~/.ssh`、`~/.infu`、`~/.aws`、`~/.gnupg`、`~/.docker` 永远只读
- 审批提示必须展示解析后的真实绝对路径（防 CWE-451）
- 高风险命令（rm -rf/format/mkfs/dd）必须 high 级审批
