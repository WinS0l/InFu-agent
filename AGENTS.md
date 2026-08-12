# InFu — 项目状态与开发指南（Agent 必读）

> 本文件由 ZCode 在每个新会话自动加载。开发前先读本节，避免重复劳动或方向错误。

## ⚠️ 强制指令（每次会话必须执行）

1. **读取 `docs/ROADMAP.md`**——其中 ⏳ 未完成项是持续待办，**完成之前每个阶段都要知道并推进**（尤其是"沙箱中期升级 restricted tokens"和"沙箱长期升级 microVM"）。
2. 将未完成的高优先级项纳入本阶段计划；**完成一项即在 ROADMAP 中标记 ✅**，之后后续阶段不再关注它。
3. 本阶段工作完成后，更新 AGENTS.md 与 ROADMAP.md 的状态（已完成项移入历史区）。

## 项目是什么

InFu（Infinite Future）——软件工程智能体平台。用户用自然语言给 AI 下开发任务，AI 在代码仓库里自主完成：分析项目 → 规划 → 修改代码 → 跑测试 → 输出交付报告。

## 技术栈（已定，勿改）

- **monorepo**：npm workspaces（`packages/shared`、`packages/agent`、`packages/web`）
- **后端**：Node + TypeScript + **AI SDK v6**（`ai@6.0.250`，配套 provider 3.x；DeepSeek/智谱/通义/Ollama/自定义端点统一走 `createOpenAI({baseURL})`，OpenAI/Anthropic/Google 用官方 3.x 适配器）
- **前端**：React 19 + Vite + Tailwind v4 + zustand（设计系统来自 ui-ux-pro-max skill：Dark OLED 深色 + 运行绿 #22C55E，图标用 lucide-react，禁用 emoji 图标）
- **服务**：Hono + SSE 流式（端口 4317，冲突自动递增；Web 端口 5174）

## 常用命令

```bash
npm install                    # 装依赖
npm run config                 # 交互式模型配置向导（~/.infu/config.json，Key 不入库）
npm run infu -- "任务" --root <路径> -y   # CLI 跑 Agent
npm run start                  # 启动 Agent 服务
npm run test                   # 工具系统自测（16 项）
start-infu.bat                 # Windows 一键启动（服务 + Web + 浏览器）
```

## 已完成（勿重复开发）

- M1：AI 接入层（任意大模型）、10 基础工具、Agent 循环（30 步上限+进度总结）、CLI、Hono/SSE 服务
- M2：Web 三栏 UI（对话/工具过程/Diff）、停止按钮（abort 全链路）、审批队列
- M3：**沙箱 L1**（环境变量消毒/敏感路径写保护/命令审计）+ **沙箱 L2**（Docker：断网/只读挂载/资源限制/任务后销毁）、**交付报告**（buildReport，任务结束自动生成）、**模型管理 Web UI**（CRUD API + 弹窗）
- git worktree 任务工作树：每任务独立分支 + 工作树，任务后手动合并/丢弃（server 三端点 + Web 开关/操作条）
- M4：**模板任务引导**（4 模板：初始化项目/修复测试失败/分析项目/添加功能；Web 空态欢迎面板 + CLI `--template`）+ **Planner/Reviewer 分层编排**（`orchestrator.ts`：Planner 只读规划 → 计划确认 → Executor 全工具执行 → Reviewer 只读审查 → 汇总报告；Web 输入框旁**三档模式选择器**（编排/直接/方案，Shift+Tab 切换）+ **计划卡片**（可编辑、批准后执行，`POST /api/plan/:id`）；CLI `--no-orchestrate`/`--no-plan-approval`）
- 后台日志：`~/.infu/logs/agent.log`（全事件）+ `commands.log`（命令审计）

## 未完成 / 下一步

**以 `docs/ROADMAP.md` 为准**（本处仅摘要）：
- ⏳ 沙箱中期升级：Windows restricted tokens + job objects（**每个阶段都要知道，直到完成**）
- ⏳ 沙箱长期升级：Docker microVM（触发条件：Docker Desktop 4.58+ 普及）
- ⏳ 低优先级：`/best-of-n` 并行尝试（worktree 完成后可做）、云版 InFu、WSL2 原生沙箱

## 安全红线（不可妥协）

- API Key 只存 `~/.infu/config.json`（0600），严禁入库、严禁进沙箱环境
- 沙箱写保护：`~/.ssh`、`~/.infu`、`~/.aws`、`~/.gnupg`、`~/.docker` 永远只读
- 审批提示必须展示解析后的真实绝对路径（防 CWE-451）
- 高风险命令（rm -rf/format/mkfs/dd）必须 high 级审批
