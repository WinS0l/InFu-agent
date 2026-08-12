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
