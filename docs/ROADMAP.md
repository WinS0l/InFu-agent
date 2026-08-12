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

### v2.2 模型适配与可靠性
- provider 兼容矩阵实测（GLM/通义/Kimi/Ollama 未实测；reasoning/工具调用/流式差异）
- API 失败自动重试 / 降级备用模型
- 模型选择流程（codex 式，按任务类型路由；细节实施前讨论）
- **消息级上下文重建**（v2.1 遗留边界：从 DB 事件流重建完整 OpenAI messages——v2.1 已存全量事件 + callId，地基就绪；先重建、再压缩）
- 上下文压缩（长会话自动摘要，超长历史才触发）+ 动态步数（任务复杂度评估）
- **断点恢复（工具级）**（v2.1 遗留边界：中断任务从检查点精确续跑 = 重建 messages + 续跑入口，不重放工具副作用；与失败重试同属"可靠性"；若 v2.2 体量超预期可顺延，勿拖过 v2.3）

### v2.3 扩展机制与 MCP
- 插件系统架构 v1（插件 = 可注册工具/命令/技能/钩子的包）
- 钩子系统（生命周期事件：PreToolUse/PostToolUse 等）
- skill 加载机制（SKILL.md 社区标准兼容）
- **MCP 客户端作为第一个插件类型**（`infu mcp add <server>`，工具动态注入 Agent 循环，审批/审计覆盖）

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
