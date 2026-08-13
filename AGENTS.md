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

## 未完成 / 下一步

**以 `docs/ROADMAP.md` 为准**（本处仅摘要）：
- 🔄 **v2 按 ROADMAP 7 阶段推进**（v2.1 ✅，v2.2 ✅ 全两批）：下一步 **v2.3 扩展机制与 MCP**（插件系统架构 v1 / 钩子系统 / skill 加载机制 / MCP 客户端作为第一个插件类型，见 ROADMAP）。v2.2 遗留：**Web 角色 UI 形态（模型管理弹窗加角色选择）实施前单独讨论**；provider 兼容矩阵其余模型待 key 实测回填。v2.4 设置界面含**权限等级设置**（审批策略：按风险/工具/命令配置，全自动↔全确认）+ **沙箱等级设置**（off/L1 软/L1.5 受限/L2 Docker/自动，取代 INFU_SANDBOX 环境变量）——配置 schema 基础已就位（zod + version + 未知字段保留）
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
