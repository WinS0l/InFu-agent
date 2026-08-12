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

### ⏳ 网络出站控制（L1.5 受限沙箱的最大真实缺口）【2026-08-12 评估新增】
- **缺口**：受限令牌只约束「写系统目录/提权/资源」，**不拦网络**——Agent 被 prompt 注入诱导后，可 `curl` 外传项目代码（凭据已消毒，但项目代码本身是敏感资产）
- **可选方案**（渐进）：
  1. **WFP 防火墙按进程规则**（借鉴 Codex elevated 模式的 `INetFwRule3.LocalUserAuthorizedList`）：默认禁出站 + 白名单放行；需提权安装规则，可做成 `infu sandbox-net setup` 一次性配置
  2. **文档化引导**：需要断网隔离时用 `INFU_SANDBOX=docker`（L2 容器自带 `--network none`）；受限沙箱用户接受出站
- **完成标准**：受限进程默认无出站网络（白名单例外），或提供文档化的一键断网方案
- **优先级理由**：当前威胁模型下真实存在的攻击面，成本可控；WSL2 下可更轻量（Landlock/bubblewrap + 网络 namespace）

### ⏳ 沙箱长期升级：Docker microVM 模式（借鉴 Claude Code）【降级为条件触发】
- **目标**：L2 Docker 沙箱从共享内核容器升级为 microVM（独立内核，Docker Desktop 4.58+ 的 VM 模式）
- **完成标准**：`INFU_SANDBOX=docker` 时实际运行在独立内核 VM 中；不可信代码可安全执行
- **⚠️ 触发条件（2026-08-12 重定义）**：microVM 防的是**内核级逃逸**，威胁模型要求"执行不可信代码/多租户场景"（如云版 InFu 落地、执行第三方提交的代码）。**个人本机场景**（自己仓库 + 审批 + 受限令牌）该威胁概率≈0，L1.5 + Docker 容器已覆盖——**不再以"Docker Desktop 4.58+ 普及"作为立项理由**，仅作技术前提；触发时机 = 出现多租户/不可信代码需求

---

## 低优先级 / 远期（可做可不做）

- ⏳ 云版 InFu（Agent 跑在云端服务器 + 云端沙箱；**若落地，microVM 随本项触发**）
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
