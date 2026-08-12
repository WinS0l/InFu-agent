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
npm run start                  # 启动 Agent 服务
npm run test                   # 工具/模板/Windows 硬沙箱自测（平台自动门控）
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

## 未完成 / 下一步

**以 `docs/ROADMAP.md` 为准**（本处仅摘要）：
- 🔄 **v2 候选方向**（2026-08-12 评估，未立项）：① MCP 工具生态接入 ② 长任务/上下文压缩（突破 30 步上限）③ 模型兼容矩阵实测（GLM/通义/Kimi/Ollama 未实测）+ 会话持久化/失败重试 ④ best-of-n Web UI。**v2.1 配置系统含：权限等级设置（审批策略：按风险/工具/命令配置，全自动↔全确认）+ 沙箱等级设置（off/L1 软/L1.5 受限/L2 Docker/自动，取代 INFU_SANDBOX 环境变量）**
- ⏳ 沙箱长期升级 microVM（**已降级为条件触发**：仅多租户/不可信代码场景需要，如云版 InFu 落地时）
- ⏳ 低优先级：**v3 团队版 InFu**（触发条件 = 出现第二个真实用户/团队需求，届时 microVM 一并触发，见 ROADMAP）、WSL2 原生沙箱、/best-of-n Web 端并行 UI

## 安全红线（不可妥协）

- API Key 只存 `~/.infu/config.json`（0600），严禁入库、严禁进沙箱环境
- 沙箱写保护：`~/.ssh`、`~/.infu`、`~/.aws`、`~/.gnupg`、`~/.docker` 永远只读
- 审批提示必须展示解析后的真实绝对路径（防 CWE-451）
- 高风险命令（rm -rf/format/mkfs/dd）必须 high 级审批
