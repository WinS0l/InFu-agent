# InFu 待办路线图（ROADMAP）

> ⚠️ **AGENTS 强制指令**：每个新会话/新阶段开始，必须读取本文件，将**未完成**的高优先级项纳入本阶段计划并推进。完成一项即把状态改为 ✅，之后后续阶段不再需要关注该项。

## 状态图例
- ⏳ 未完成（需要持续推进）
- 🔄 进行中（当前阶段在做）
- ✅ 已完成（无需再关注）

---

## 高优先级（未完成前，每个阶段都要知道）

### ⏳ 沙箱中期升级：Windows restricted tokens + job objects（借鉴 OpenAI Codex）
- **目标**：将 L1 软沙箱升级为硬沙箱——Agent 命令以受限令牌/作业对象运行，写不了系统目录、读不了敏感文件（OS 级强制，而非仅应用层检查）
- **依据**：docs/SANDBOX.md 第七节（前沿产品对比）
- **完成标准**：run_command 在 Windows 上以受限权限执行；危险命令即使绕过检查也无法造成系统级破坏
- **前置**：L1 软沙箱已实现（环境消毒/写保护/审计）；worktree 模式完成后可开始
- **技术提示**：Node 无原生 restricted tokens API，可用 PowerShell `Start-Process -Credential` + Job Object，或原生 addon（如 `node-windows` / 自编译）；WSL2 下可考虑 Landlock/bubblewrap 替代

### ⏳ 沙箱长期升级：Docker microVM 模式（借鉴 Claude Code）
- **目标**：L2 Docker 沙箱从共享内核容器升级为 microVM（独立内核，Docker Desktop 4.58+ 的 VM 模式）
- **完成标准**：`INFU_SANDBOX=docker` 时实际运行在独立内核 VM 中；不可信代码可安全执行
- **触发条件**：Docker Desktop 4.58+ 普及；当前版本检测到旧版时继续用容器模式

---

## 低优先级 / 远期（可做可不做）

- ⏳ Cursor 式 `/best-of-n` 并行尝试（worktree 完成后可做）
- ⏳ 云版 InFu（Agent 跑在云端服务器 + 云端沙箱）
- ⏳ WSL2 原生沙箱（bubblewrap/Landlock）作为 L3 备选

---

## 已完成（历史）

- ✅ M1：monorepo + 任意模型接入 + 10 工具 + Agent 循环 + CLI + 服务层
- ✅ M2：Web 三栏 UI + SSE 流式 + 停止按钮 + 审批队列
- ✅ M3：沙箱 L1（软沙箱）+ L2（Docker 容器）+ 交付报告 + 模型管理 UI
- ✅ 修复：审批队列、停止链路、端口冲突、错误信息透出、maxSteps 30 + 进度总结
- ✅ git worktree 任务工作树（Cursor /worktree 借鉴）：每任务独立分支 + 工作树，任务后手动合并/丢弃，主代码零污染
- ✅ M4：模板任务引导（一键初始化项目/修复测试失败/分析项目/添加功能，Web 空态欢迎面板 + CLI --template）+ Planner/Reviewer 分层编排（Planner 只读规划→计划确认→Executor 执行→Reviewer 只读审查→汇总报告；Web 三档模式选择器 编排/直接/方案 + 可编辑计划卡片，CLI --no-orchestrate/--no-plan-approval）
