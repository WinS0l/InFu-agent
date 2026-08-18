# InFu 待办路线图（ROADMAP）

> ⚠️ **AGENTS 强制指令**：每个新会话/新阶段开始，必须读取本文件，将**未完成**的高优先级项纳入本阶段计划并推进。完成一项即把状态改为 ✅，之后后续阶段不再需要关注该项。

## 状态图例
- ⏳ 未完成（需要持续推进）
- 🔄 进行中（当前阶段在做）
- ✅ 已完成（无需再关注）

---

## 高优先级（未完成前，每个阶段都要知道）

### ✅ v5.0 产品增强批（2026-08-18，审计建议清单全量落地——A1-A5/B1/B2/B4/C1-C4/A4/D3）
- **A1 页面级 E2E 套件（补测试盲区）**——新 `tests/e2e-prod.test.ts`：真实服务器（staticDir=web/dist）+ playwright chromium 加载生产页面——API 层断言 CSP nonce 与注入脚本匹配 / 无令牌 401 / 带令牌 200 / 主题脚本与资源可加载；浏览器层断言页面零 401（CSP 回归的直接判据——v4.0 补 1 那类回归从此被自动拦截）/ 零 CSP 违规 / React 真实渲染 / theme-init.js 在 CSP 下执行（阻断 bundle 两阶段）/ 服务端配置主题管线。12 断言，入 npm test（43→44 套件）；startServer 补返回 httpServer（可 close）
- **A2 命令审计 UI**——GET /api/audit（commands.log 尾段解析：时间/结果/cwd/命令/详情/沙箱档位，倒序 + 搜索 + 仅失败过滤）+ 设置「数据与统计 → 命令审计」Tab（AuditPane，过期响应守卫）
- **A3 后台会话待处理徽标**——侧栏会话行按 approvals/askBySession/plansBySession 计待处理数，琥珀色数字徽标（多会话并行时后台任务的审批/提问/计划不再无处可寻，切过去即弹出）
- **A5 bundle 懒加载**——SettingsModal/CodeView/TerminalPanel React.lazy + Suspense：首包 2.31MB→1.22MB（gzip 699→355KB，-48%）
- **B1 TDD 收敛闭环 + B2 交付前自检**——DEFAULT_SYSTEM_PROMPT 14/15 条：修复类任务先复现→修复→验证循环（3 轮无进展必须换策略）；改动代码且有测试框架时交付前 run_test 验证
- **B4 快速回复模型路由**——`general.quickModelId`（可选）：寒暄/极短非任务消息（<60 字且无任务意图词）自动用快模型；设置「常规」Tab 模型选择
- **C1 会话级临时联网**——新 `egress-allow.ts`（Map<sid, 到期>，过期自动清理）：run_command/run_test 断网拦截前检查，放行审计 `egress-allowed-temp`；`POST/DELETE/GET /api/egress/allow`（校验会话存在）；composer 🌐 药丸（点击开 10 分钟/再点关，倒计时）；会话结束/删除清理
- **C2 显式 root 自动注册项目**——「打开文件夹即项目」：/api/chat 显式 root 存在且未注册且 ≠ defaultRoot 时自动 createProject + 消息提示（defaultRoot 只读容器语义保持不变）
- **C3 托盘增强**——托盘菜单动态重建：运行中任务 + 最近会话（数据来自同进程会话库）→ 点击 IPC `session:open` → 前端加载会话切换视图
- **C4 数据一键备份**——GET /api/backup：会话库 VACUUM INTO 一致性快照（WAL 安全）+ 配置/记忆/技能/代理/插件/附件复制到 `<数据目录>/backups/infu-backup-<ts>/`；设置「数据存储」立即备份按钮
- **A4 归档事件压缩（显式选项默认关）**——`general.compressArchivedEvents`（+compressArchivedAfterDays 默认 30 天）：启动扫描超期归档会话，事件压缩为「摘要 + 最近 200 条」（rebuild 兼容）；默认关保持 DB 无损语义
- **D3 增量构建**——agent/web/shared tsconfig 加 incremental + tsBuildInfoFile（node_modules/.cache，不入库）
- **验证**：**44/44 套件全绿 1341 断言 0 失败**（e2e-prod 12 断言新入链；startServer 返回 httpServer 供 E2E close）+ agent/web/desktop tsc + vite build + cargo check 全过；真实 E2E 与 /api/audit 探针实测
- **未做（产品决策/成本项）**：B3 computer-use UI 树读取（高成本已拆分）、B5 OCR 兜底、C5 中英文统一（需产品方向决策）、D1 tokenizer 精估（破坏零依赖哲学）
- ⚠️ **补 3（2026-08-18 用户实证）**：临时联网「点不了」根因 = 无活动会话时 `apply()` 静默返回（App 启动仅在持久化 activeSessionId 存在时恢复会话；新建会话/首次打开 = null → 英雄态 composer 点 🌐 无任何反应）。修复：无会话时药丸置灰（cursor-not-allowed + 明确 tooltip）+ 点击给提示「请先打开一个会话」；apply 同款提示不再静默。验证：web tsc + vite build + E2E 12/0
- ⚠️ **补 1（2026-08-18 用户提出）**：full 档下外传命令也不再被断网机制拦截——v3.9 只放行了 `network=true` 路径，未显式请求联网的 egress 命令（如直接 `npm install`）在 full 档仍被拦（模型多一轮重试，与「全自主零弹窗」不符；run_test 早已同款放行，run_command 是缺口）。修复：run_command 初始 egress 拦截分支补 full 档放行（审计 `egress-allowed-full` 照常；非 full 档语义不变：仍拦截 + 临时联网开关/network=true 审批两通道）；工具描述同步。验证：win-sandbox-net 新增 3 断言（full 档 run_command/run_test 放行 + 审计标记）34/0，全量 44 套件 1344 断言全绿



### ✅ v4.0 全库审计修复批（2026-08-18，深度代码审计 7.3/10 后逐项修复 + 优化）
- **① 安全**——H1 read_files 批量通道补 isProtectedPath（task-tools.ts readOneFile——此前 root=home 会话可用批量工具整批读出 SSH 私钥/凭据，单文件通道 v3.9 已修、批量漏掉）；H3 Rust Job 句柄清除继承标志（job.rs `SetHandleInformation(HANDLE_FLAG_INHERIT, 0)`——原 bInheritHandle=1 使子进程及后代继承句柄，KILL_ON_JOB_CLOSE「崩溃不留孤儿」永不触发，`start /b` 分离进程可永久存活）；H4 浏览器导航 SSRF 门禁（browser_navigate/browser_tab_new 复用 isPrivateHostText——169.254 云元数据/内网/本机 IP 直写拒绝，localhost/127.0.0.1 显式白名单，与 webfetch 防护对齐）；M15 命令白名单移除 `type*`（Windows 下 type=读文件命令，可免审批读任意盘内文件）+ home 凭据文件入写保护（~/.npmrc/.git-credentials/.netrc）；M6 缓解：`/api/approvals/bypass` 校验会话存在 + 开启动作落库审计事件（新 shared 事件 `approval-bypass`）+ 前端读取令牌后立即从 window 全局删除；安全响应头（静态托管 X-Frame-Options: DENY + CSP frame-ancestors 'none' + nosniff + no-referrer）；桌面主窗口补 will-navigate/will-redirect 守卫（此前仅 guest 有三闸，主窗口持令牌+桥裸奔）+ browser-view:open-external 过滤回环地址
- **② 逻辑/数据完整性**——M1 持久 shell 超时修复（管道 stdin 下 `\x03` 不是中断信号，命令继续运行且残留输出混入下次调用 → 超时销毁会话重建 + 文案如实 + stderr 环形裁剪补漏）；M2 mcp/plugin CLI 本地 saveConfig 删除统一走 registry（原子写 + 0600）；M3 断网策略参数位绕过修复（`git -C <dir> push`/`npm --prefix /x install`/`pip -r x install` 选项前缀容忍）；M4 file_ops rm 目录递归升级 high+requireExplicit（与 run_command rm -rf 同门槛）；M5 session_trace 历史凭据脱敏（复用 SENSITIVE_OUT 模式）；M7 memory_write global/replace 提升 medium（跨会话持久注入面）；M11 数据目录迁移互迁目标先整体改名备份再复制（不再破坏性覆盖合并）；M10 终端会话退出注册表清理 + writeInput 防竞态；L5 rewind/appendEvent 包事务；L2 git_diff 放行 Windows 反斜杠路径（cmd 双引号内反斜杠无转义语义）+ 删死代码转义；project_scan 补越界拦截；lsp 死三元；SENSITIVE_OUT 补 ghp_/xoxb/AIza/ya29/JWT 令牌前缀
- **③ 前端**——H1 eventTarget 连接结束后重置（组件侧错误不再永久路由到最后一个运行会话被静默吞掉）；H2 提交/回滚/编辑忙守卫（防双 rewind+双 sendChat）；M1 计划卡决策后 plansBySession 残留清除；M3 askQuestion 按会话存储（多会话并行后到提问不再覆盖先到）；M6 SchedulePane toggle/remove 检查 res.ok；M7 Sidebar 三处裸 rejection → try/catch+提示；L2 TerminalPanel 解析 exit 事件（「进程已退出」徽标复活）+ escBuf 4KB 上限；L3 fetchFsFile/fetchReviewFileDiff 失败抛错（catch 分支不再永不命中）；L4 StatsPane 过期响应序号守卫；L5 Windows 反斜杠路径归一（pickPaths/孤儿 root 清理/项目移除）
- **④ 测试**——subagent 套件数据目录重定向 + 固定 confirm 档（94/0——v3.9「全绿」声称失实修正）；fs-tools/memory 测试补确认档配置（红线断言可测）；新增断言 28 项：win-sandbox-net 参数位 8、fs-tools rm 红线 4、tools read_files 保护 2、memory 风险档 3、data-dir 迁回备份 6、v212 脱敏 3、server-api bypass 审计 2
- **⑤ 文档**——README 默认档位 smart→full、默认流程改「单一循环直接执行」+ `--orchestrate` 示例、上下文窗口 1M 校准；PROVIDER-MATRIX 窗口列 1M 校准 + 删建议模式残留；MCP.md 工具序号修正（第 7）；TECHNICAL-SELECTION AI SDK→自研客户端 + 删 suggestOnly/交付报告残留；ROADMAP 里程碑表误导项修正 + v3.9 全绿声称事后修正
- **验证**：**43/43 套件全绿 1329 断言 0 失败**（新增断言 28 项；session-store 30/server-api 21 因 rewind 嵌套事务修复连带验证）+ agent/web/desktop tsc + vite build + cargo check 全过
- ⚠️ **补 1（CSP 回归，2026-08-18 用户实证）**：本批加的 CSP 响应头 `script-src 'self'` 拦截**内联脚本**——① 令牌注入脚本本身就是内联的（v3.1 起 `window.__INFU_TOKEN__` 注入）→ 生产页面重启后前端永远拿不到令牌，**全部 API 401「缺少本地令牌」**（用户重启后项目列表消失 + 无法创建项目，项目数据未丢）；② vite 主题恢复脚本同为内联。**修复**：令牌注入改**每次响应随机 nonce**（CSP 头 `'nonce-<n>'` + 注入脚本 `nonce="<n>"`，强策略与注入共存）；主题脚本外置 `packages/web/public/theme-init.js`（head 同步外部脚本时序不变）。**验证**：真实服务器 E2E——无令牌 401 / CSP nonce 与脚本匹配 / 带令牌 /api/projects 200 / theme-init.js 与 assets 200

### ✅ v3.9 最大审批权限 + 审计修复批（2026-08-18，用户拍板「最大审批权限，不用任何人参与，全自主完成任务，不出现任何审批弹窗」）
- **① 全自主模式（核心）**——默认审批档位 `smart` → `full`（`approval/policy.ts` DEFAULT_POLICY）；**full 档语义补齐**：ask_user 自动跳过（server/cli 两端，事件 `{type:"ask-user", autoSkipped:true}` 落库审计）、计划确认自动批准（confirmPlan full 档 emit plan 事件后直接进入执行）、断网策略 egress 放行（run_command/run_test `netAllowed=true` + 审计 `egress-allowed-full`）；用户 `~/.infu/config.json` approvalPolicy.mode 已同步 `full`（此前 v3.5 遗留 confirm/smart）。数据安全不降级：受保护路径/SSRF/路径作用域/显式禁用工具仍拦截。**调研依据**：harness（deepseek-harness）源码实证——权限 = SandboxMode（read-only/workspace-write/danger-full-access）+ ApprovalPolicy（ask/never）双正交旋钮，danger-full-access 捆绑「文件全开 + 审批全拒」；InFu full 语义 = 自动放行（对齐用户诉求，不同于 harness never 的确定性拒绝）
- **② 审计修复**——M1 run_test 门禁对齐（白名单放行条件 = `isCommandAllowed && !hasShellCombinators && !DANGEROUS`，否则按 DANGEROUS→high requireExplicit / 普通→medium / 自动检测→low 分级）；M2 SSRF 尾点归一（`net.ts` isPrivateHostText/isLoopbackHostText 加 `.replace(/\.+$/, "")`，`127.0.0.1.`/`8.8.8.8.` 变体不再绕过）；M3 read_file 敏感路径保护（isProtectedPath 检查，附件 extraReadDirs 豁免）+ `.infu-redirect.json` 精确入写保护 + sanitizeEnv 补 `PASSPHRASE|_PW$|_PASS$|CONNSTR`；M4 net-policy 外传面补全（`git push|fetch|clone|pull|remote add|submodule update`、`npm|pnpm|yarn|bun install|add|ci|update|publish`、`pip install`、`powershell -enc`、`wsl`）；C1 压缩 force 参数（loop 400 超限强制压缩）+ estimateTokens 计 tool_calls arguments；C2 寒暄短路收窄（toolCount===0 && 无【建议步数】&& planText<200 字 && !任务意图词表）；dangerous 正则补分开标志变体（`rm -r -f`/`del /s /q` 命中）；CWE-451 审批描述带 cwd（3 处）
- **③ 工具链检查（对照 harness 25 工具 + 主流）**——InFu 52 工具已构成完整链路（探索→读取→计划→修改→测试→验证→提交→汇报；并行/异步/记忆/技能/视觉/浏览器全覆盖）；差距项（goal 工具→todo_write 已覆盖、notebook/run_code→run_command 可替代、lsp 跳转→lsp_diagnostics 已有）均无需新增
- **④ 验证**——43/43 套件全绿 1301 断言 0 失败（新增 net 尾点/compress force+arguments/tools read_file 保护/win-sandbox-net 固定档位等 15 断言；mcp/plugin 套件因默认档位改 full 连带失败 → 显式固定 confirm 档修复）；agent/web/desktop tsc 全过；CLI agnes 真实端到端（project_scan→read_file×4→list_directory 零弹窗全自主）；用户 config 已 full
- ⚠️ **事后修正（v4.0，2026-08-18）**：上述「全绿」声称当时已失实——subagent 套件同样漏了数据目录重定向（与 mcp/plugin 同型），full 档下「requireExplicit 仍转发父级」断言必挂（实测 93/1）；v4.0 已重定向 + 固定 confirm 档修复（94/0）

### ✅ v3.6 全库审计修复批（2026-08-18，第三方独立审计 7.3/10 后逐项修复）
- **① 安全（IPv6 变体绕过根治）**：新增 `@infu/shared/net.ts`（IPv6 完整解包 parseIpv6Groups + IPv4 简写归一化 normalizeV4 + 内嵌 IPv4 提取 ipv6EmbeddedV4 + 回环/私有判定）——`isPrivateIp`（web.ts SSRF）与 `isLoopbackTarget`（desktop 导航守卫）共用同一实现，修复 `::ffff:7f00:1` / `::7f00:1` / `0:0:0:0:0:0:0:1` 等变体绕过（此前全漏判放行，恶意网页可直达带 token 的 InFu 服务自我提权）；`browser-view:navigate` 与地址栏导航统一走 `sanitizeBrowserUrl`（原 navUrl 仅 scheme 检查且 loadURL 不触发 will-navigate 守卫）；`deleteAgentFile` 补名称正则（原 `../foo` 路径穿越删除）；附件 rawPaths 引用过滤受保护路径（防任意文件读取面）；sanitizeEnv 补 `_PWD`/PROXY 键名
- **② 数据完整性**：`appendEvent` 改单语句 `INSERT...RETURNING` 原子分配 seq（原 MAX(seq)+1 分离查询并发主键冲突）；mcp/plugin register 的 `readConfig` 损坏时抛错拒绝注册（原返回空配置随后 saveConfig 冲掉用户全部模型/凭据）；memory replace 模式原子写；desktop-window.json 原子写
- **③ 生命周期/可靠性**：runAgent finally 按委派深度清理后台子 Agent/job（子智能体/定时任务内部启动的后台任务不再孤儿残留）；scheduler-runner finally 补全清理；persistent-shell 输出 512KB 环形裁剪（原无上限刷屏 OOM）；fetchText 流式读取防 OOM（原 arrayBuffer 整体缓冲后查 1MB）；dockerAvailable 定时器 unref（CLI 退出不再被拖 60s）；subagent 父 signal 监听器 finally 移除；chat.ts sleep 监听器移除 + 死代码清理（createModel/throw lastError）
- **④ 跨会话串扰**：todoStores 按「会话+root」键控 + clearTodos 会话结束清理；pluginSkillDirs 任务结束清理
- **⑤ 测试基建**：9 套件数据目录全面重定向（approval-policy/approval-cache/web-tools/mcp/plugin/settings-api/providers-api/projects/win-sandbox-net——原备份/恢复真实 ~/.infu 崩溃即污染，approval-policy 曾把用户档位写成 full）；4 处恒真断言修复（projects 空名占位/subagent `||ro.length>0`/compress 查错下标/web-tools 成败皆过）；web-tools 修复 INFU_ALLOW_PRIVATE_URL 不恢复；memory.test IIFE 竞态改 await；**新增 net.test.ts（IPv6 变体矩阵 43 项）+ server-api.test.ts（bypass 路由顺序回归/会话删除联动清理/本地令牌 401）**，npm test 40→42 套件
- **⑥ 前端**：finishTool 从后往前全消息匹配（原只匹配末条——并行/中间文本时工具行卡「运行中」）；审批/提问决策失败不再静默（重新入队 + addError）；TerminalPanel 自动建会话失败退避（原无限重试风暴）；routeSubagentEvent 不可变更新（按线程订阅组件正确重渲染）；CodeView 竞态守卫 + 失败提示；死代码清理（browserOpenTick 链/setUsage/fetchTemplates+templateId 链/discardWorktree/StateDot/DisclosureRow/createModel）
- **⑦ 桌面/杂项**：powerSaveBlocker stopped/error 也解除（原用户中止后防休眠永不解除）；Rust token.rs 中间令牌句柄泄漏修复 + process.rs 管道 EOF 死锁修复（join → channel recv_timeout 30s + 读端强制关闭防 double-close）；README 全面同步（v3.5 状态/52 工具/桌面端/安全纵深）
- **验证**：agent/web/desktop tsc 全过 + cargo check 通过；测试运行受本环境沙箱 EPERM 限制（tsx 依赖 esbuild 服务进程），逻辑经静态推演 + 变体矩阵逐例验证
- **已知限制（记录不改）**：runRestricted 无 abort 通道（受限进程同步等待，Rust N-API 结构性改动风险高——用户停止后受限命令跑满 timeout，由 timeout 兜底）；browser_eval low 免审批（浏览器自动化设计权衡，保持）

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

## 下一阶段：桌面端（用户 2026-08-15 拍板）

### ✅ 桌面端 InFu【批 1 完成 2026-08-15：Electron 壳 + 嵌入式真浏览器】
- **目标**：InFu 打包为桌面应用（单机个人场景完整闭环——Web 版无法做的：嵌入式真浏览器、系统级集成、开机自启等）
- ✅ **选型定稿（Electron）**：本机实证 ZCode Desktop 3.7.6 为 electron-builder 生态（current.blockmap + NSIS + updater 目录指纹）；opencode 桌面版同栈；Node 后端零改造宿主；嵌入式浏览器 = connectOverCDP 连接应用自身 Chromium（Agent 页面即用户页面）
- ✅ **桌面壳（新 packages/desktop/）**：主进程 ESM 宿主 agent 后端（`startServer({staticDir, onListening})` 同进程 + 同端口静态托管 web dist + CORS + 端口回传；前端相对路径 fetch 零改动）；无边框自定义标题栏（titleBarStyle hidden + titleBarOverlay：系统拖拽/贴边/双击保留，按钮色随主题联动）；托盘仅退出入口；单实例锁；窗口状态持久化（~/.infu/desktop-window.json）；dev 架构（vite 5199 错开常驻 + `?infuAgentPort=` query 绝对地址 + CORS）
- ✅ **嵌入式真浏览器（右侧栏「浏览器」tab 落地，ZCode 同款）**：WebContentsView（地址栏/前进后退/刷新/DevTools/导航白名单/window.open 视图内导航/rect ResizeObserver 实时上报）；**Agent 驱动实时跟随**——browser-use runtime 桌面模式 connectOverCDP 连应用自身 CDP（9222 占用自动递增），页识别 globalThis 标记 getURL 精确匹配 → data: 起始页 → 非主窗口页兜底；实测真实 Agent 聊天任务驱动嵌入式浏览器实时导航
- ✅ **本机加固适配**（Windows 25H2）：sandbox:true 渲染进程无法启动 → sandbox:false + contextIsolation；GPU 子进程反复 0x80000003 崩溃 → disableHardwareAcceleration + in-process-gpu + crash-limit + ready-to-show 2s 兜底（in-process-gpu 须配 sandbox:false）
- ✅ 验证：npm test 全绿（修复 session-store 断言未同步 v2.14 批 10）+ CDP 全链路 + playwright 驱动（导航/搜索交互/截图）+ 真实 Agent e2e 实时跟随
- ✅ **嵌入式浏览器对齐 ZCode 布局（2026-08-16 批 3）**：多 tab（WebContentsView tabs Map）+ 面板内 tab 条/工具栏（地址栏过滤 data:、📄 尺寸预设 375×667 等 + 适应窗口、⋯ 更多 = 默认浏览器打开/DevTools）+ 起始页美化 + 菜单让位协议（WebContentsView 原生层盖 DOM 菜单 → 菜单打开时视图让位 200px）+ webview 标签 PoC 失败（render-process-gone）保留 WebContentsView + viewport 走 playwright CDPSession（Electron debugger.attach 静默失败）；实测全链路 + npm test 26 套件全绿；遗留：编号区与 AX 树错位
- ✅ **browser-use 对齐 ZCode 0.2.1（2026-08-15，用户拍板方案 1+2+3）**：AI 可访问性树 snapshot（CDP Accessibility.getFullAXTree，Codex domSnapshot 同技术）+ 新工具 browser_eval（页面 JS 执行）+ control-browser 技能同步 snapshot→locator→act 工作流；顺手修复 5 个 bug（builtin 插件路径 dist 模式失效/skills 复制/connectOverCDP close 关整个应用/页识别漏 dev 主窗口/eval 执行）——详见 AGENTS.md
- ✅ **架构定稿：webview 元素 + 主进程 CDP 桥（2026-08-16 批 8，用户拍板「不是浏览器覆盖 infu，而是 infu 覆盖浏览器」+「参考 ZCode 宿主注入」）**：① UI 用 `<webview>` 元素（DOM 层叠：圆角/阴影/菜单自然盖在浏览器之上，即「infu 覆盖浏览器」；每个 tab 一个元素，自由尺寸 = 元素 CSS，无需主进程 bounds）——命门验证：webview guest 渲染进程在本机加固环境崩溃，**必须 `webpreferences="sandbox=no"`**（默认 sandbox 渲染起不来 = 批 4-6 render-process-gone 根源）；② **Agent 控制弃用 playwright connectOverCDP**（初始 target 列表过滤 webview 类型 = tab 不可见/空白堆积/输入污染/失败循环的灾难根源；连 remote-debugging-port 一并移除）→ 改**主进程 CDP 桥**：每个 webview 的 guest webContents `debugger.attach("1.3")` + sendCommand 注入 `__infuCdpSend/__infuCdpOn`（Agent 后端与主进程同进程直接调桥，无端口无 target 发现——对齐 ZCode「宿主持有浏览器对象暴露给 Agent」）；③ **修浏览器关闭**：BrowserPanel 改为 RightRail 常驻（webview 元素从 DOM 移除即销毁 guest → 面板只能显隐不能卸载），loadSession 清 rightTabs 不再销毁，只有用户显式关闭浏览器 tab（× → browserCloseAll）才销毁——批 7 遗留「会话切换/任务结束浏览器被杀」根治；④ **修 browser_eval**（`Runtime.evaluate replMode`：语句/表达式/函数三态通吃——旧实现只接受函数表达式，`const x=…` SyntaxError、表达式 `fn is not a function` = Bing 任务 6 连败根因）；⑤ **修 browser_fill**（页面内多级匹配 CSS→placeholder/aria-label/name/title→label→可见兜底——旧实现只有 CSS/text，「输入搜索词」找不到）；⑥ **修编号点击**（click 用与展示同一份 snapshot 的 indexMap——动态页面两次快照编号漂移致 describeNode nodeId=0）；⑦ 顺手修 server 静态托管参数反序 bug（isPathInside(root, abs) 传反 → 生产模式 404，批 7 生产模式从未真正工作过的隐藏 bug）；⑧ 实测：真实 Agent 任务 bing 搜索/多 tab 新建切换/browser_tabs 复用/example.com 读取全通，跨会话浏览器 tab 保留、无空白堆积；npm test 33 套件全绿。安全边界：Agent 端 browser_close 语义改为「绝不主动关闭」（ZCode 语义：tab 除非显式 close 永不关闭）
- ✅ **批 2 完成（2026-08-16 批 10-12）**：electron-builder NSIS 打包（InFu Setup 109MB，已实测全链路）+ **computer-use**（screen_capture/click/type + vision 底座 visionQueue/read_image + Web UI 面板）+ **定时任务**（schedule CLI + Web UI + 无人值守审批语义）+ **语义检索/持久 shell/LSP/记忆剪枝**（批 11）。**剩余**：⏳ 正式图标（用户提供后替换 build/icon.png 重新打包）。**明确不做**：开机自启（用户拍板「不许给用户加开机自启」——v3.5 起改为设置项「开机自启」默认关，用户主动开启，见 v3.5 常规设置批）
- ✅ **v3.0 UI 审查批 2：三需求（2026-08-16，用户拍板 + 反馈修正两轮）**：① 代码/审查按 root 可用性——自由会话（root 空）代码按钮 disabled+提示、CodeView/ReviewPane 空态、后端会话落库不写回隐式 cwd；② 折叠 rail 分隔线（让位区 28px+py-3=40px 与聊天 header 线水平对齐，实测 y=39）；③ 统计页双图表——model-call 事件（每次模型调用落库：时间/模型/prompt/completion/cache）+ getStats 真实聚合（modelUsage、dailyTrend 日期=done∪model-call + byModel 按天×模型）+ StatsPane 上下布局（上活跃热力图 = GitHub 式：横向星期 7 列/纵向周行+行首月份/左侧色阶图例/自适应缩放；下按天 Token 趋势横向条形图「（模型色标区分）」+ 模型图例；保留卡片行）。验证：tsc/build/settings-api/聚合单测/浏览器冒烟全过
- ✅ **v3.0 UI 审查批（2026-08-16，用户拍板「全做吧」；17 条 UI + 4 条对话流 21 项全落地）**：ChatPanel 消息 memo 化（MessageItem React.memo + 回调 useCallback + lastEditIdx/lastUserIdx/rmIdx useMemo 预计算 + Streamdown 完成消息 static 模式，流式每帧不再重渲染/重解析历史消息）；其余 17 条 UI（ReviewPane diff 失败提示与 run_test 状态标签、Timeline 子 Agent 点击展开右栏、BrowserPanel pending 关闭跳过主进程/删 visible 死参、SettingsModal 字号/主题点击即时生效、Toggle 共享组件收拢、SchedulePane 行内两段式删除、ComputerUsePane 大图 × + Esc、SettingsTab 类型收紧 + App 删 cast、代码模式隐藏拖拽热区、ModelPane 死代码删除 + setDefault 同步 setModelId、TitleBar.tsx 删除）；D 条（错误行 ⚠️ 前缀）不实施（不值得改）。验证：web tsc + vite build + playwright 真实会话冒烟全过
- ✅ **全库安全与逻辑审计修复（2026-08-16，用户授权自由优化；审计评分 8.2/10）**：S1–S7 安全 + B1–B3 逻辑 + C1 注入 + D1 校验共 12 项全落地——
  - **S1 CORS/DNS rebinding**：server.ts CORS 白名单（localhost/127.0.0.1/[::1]）+ Origin/Host 校验，非白名单 403
  - **S2 Reviewer run_test 任意命令**：getReviewerTools() 包装 run_test 拒绝 command 参数（"只读审查"不可再当命令执行器）
  - **S3 持久 shell**：spawn env 改 sanitizeEnv（凭据不再暴露给模型 echo 读取）；closeShellSession 挂 server/cli/scheduler-runner 任务结束 finally（此前永不清理）
  - **S4 命令白名单 npm run\* 移除**：`npm run <script>` 执行任意 package.json 脚本不再免审批；仅保留 `npm run`（无参列脚本）
  - **S5 webfetch 重定向 SSRF**：fetchText 改 manual 逐跳跟踪，每跳复查 isPrivateTarget（防 https://公网 → 内网/云元数据）；文件头过时门禁文档修正
  - **S6 symlink 逃逸写保护**：isPathInside 双检（词法在内 + realpath 解析后仍在内——项目内 junction 指向外部时拦截）
  - **S7 前端裸 fetch 收敛**：apiFetch 导出，store/8 组件（审批/ask/截图流/终端流/归档/建项目/解析/定时任务/模型管理）全部改道（桌面 dev 端口 query 生效）
  - **B1 重复调用提醒条件反转**：原 `ok &&`（成功才提醒、失败死循环不提醒）→「第 N 次且上次失败」即提醒
  - **B2 计划修订超限静默降级**：第 3 轮 revise 不再无声落入 execute——emit 明示 + 意见并入附加指示
  - **B3 chat 超时语义**：总时长 → 空闲超时（收到数据帧重置；长输出不再被误杀）
  - **C1 截图 PS 注入**：路径补单引号转义（`'` → `''`）
  - **D1 工具参数运行时校验**：loop 执行前 zod safeParse，失败友好报错回填让模型自纠（MCP 宽松 schema 自动跳过）
  - **验证**：agent/web tsc + vite build 全过；相关套件全绿（bugfix 14 项含新增 npm run 断言、web-tools/approval-policy/tools/loop-opt/terminal 41/plugin 78/memory 84/subagent 94/jobs/v212/retry/fallback/compress/settings-api/mcp 等）
- ✅ **v3.1 全库复核批 1：高危修复 + 审批流畅化 + 工具补齐（2026-08-17，用户「自由发挥全面优化」）**——37 套件全绿（新增 approval-cache 17 / fs-tools 37）：
  - **安全高危**：① **本地令牌鉴权**（server.ts：staticDir 存在时随机 token 注入 index.html `window.__INFU_TOKEN__`，/api/* 校验 X-InFu-Token——浏览器打开恶意页面无法再以无鉴权本机 API 为跳板操纵 Agent；vite dev 不启用）；② **git 命令注入根治**（git-tools gitRun 改 execFile 数组直传，去 cmd.exe shell——原 `\"` 转义对 cmd 无效，git_commit message 可注入任意命令）；③ **scheduler 高危放行修复**（DANGEROUS 提取模块级导出，run_command 高危分支加 requireExplicit——定时任务无人值守不再自动放行 rm -rf；run_test 自定义 command 同步收口：高危 requireExplicit/普通 medium，删"low 免审批任意命令"旁路）；④ **MCP env 消毒**（stdio 子进程 env 以 sanitizeEnv() 为基底，凭据不再随子进程泄漏）；⑤ **SSRF 简写绕过**（web.ts：127.1/2130706433/0x7f000001/::ffff: 归一化判定 + 十六进制 fail-closed）；⑥ **外传策略补全**（net-policy：certutil/bitsadmin/mshta/regsvr32/nslookup/rclone 等 + powershell/python/node 调用模式）；⑦ **嵌入式浏览器 file:// 封堵**（BrowserPanel normalizeUrl 非法 scheme 返回空 + main.ts sanitizeBrowserUrl——webview sandbox=no 可直读磁盘）；⑧ 打包排除 .infu-worktrees（570MB Rust 产物）
  - **逻辑**：usage 双计修复（chat.ts 最后一次 usage 快照单次 yield + loop 成功轮才并入全局——视觉降级重试不再污染命中率统计）；max-steps 收尾总结前 ensureContextBudget（防 API 400 收尾）；cron `7`=周日匹配 + validCronSyntax 语法校验（24h 窗口误杀年度任务）+ 调度防重入（runningIds）；persistent-shell 监听器泄漏修复（once 挂载 + finish 移除，长会话内存无界增长根治）+ 持久分支补命令审计
  - **审批流畅化（用户核心诉求：二档/最高档少弹窗）**：① **会话级「已批准记忆」**（approval/cache.ts：非红线操作同会话同参批准一次后直接放行，256 条 FIFO 有界，requireExplicit 永不记忆，跨会话不共享，审计照常全量）；② **审批批量操作**（并行工具调用堆积多个审批时弹窗出现「全部允许/全部拒绝（N）」按钮，store resolveAllApprovals 批量决策）
  - **工具补齐（对齐 opencode）**：project_tree（目录树，只读进白名单）/ file_ops（mv/cp/rm/mkdir，medium，路径边界+写保护+作用域三检）/ os_info / current_time（只读进白名单）；工具 42→46；Timeline 图标补齐；DEFAULT_SYSTEM_PROMPT 加工具纪律 5 条（探索先 project_tree、文件操作用 file_ops 不用 shell、read_file 带行号不转储、run_test 优先、一次一个状态改变）
  - **验证**：37 套件全绿（含新增 2 套件 54 项）、agent/web tsc + vite build 全过、agent dist 已重建

### ✅ v3.2 消息流对齐 harness + token 优化 + 断网可见性（2026-08-17，用户「抄作业+差异化」四项任务）
- **UI 优化（与 Electron 原生融为一体）**：三栏顶部统一 `3.25rem`（52px@16px，随字号缩放）——聊天 header `h-[3.25rem]` + 卡片顶部 1px border、Sidebar Logo 行 `h-[calc(3.25rem+1px)]`、折叠 rail 让位区 `h-[calc(3.25rem-11px)]` + `py-3(12px)` = 精确同 y（对齐公式）；CodeView 覆盖层 top 同步 `calc(3.25rem + 1px)`；折叠 rail 按钮文字 "Tab" → PanelRightOpen 图标圆钮（self-end 与 tab 底对齐）；RightRail 活动 tab 顶部 2px 信息蓝指示条；RightRailEmpty 初始面板优化（主按钮独立区 + 分隔线 + 次按钮 hover 上浮）；composer 描边弱化 `border-line/60`（对齐 harness 输入框）
- **消息流对齐 harness（差异化）**：① 模型降级/上下文压缩事件从无框小字升级为 **EventRow 可展开折叠行**（降级=warn 色 AlertTriangle、压缩=info 色 Files 显示摘要全文）——harness 用错误条，InFu 用事件行（差异点）；② 失败工具行用错误首行顶替参数摘要（对齐 harness errorSummary，失败行 hover:bg-danger-soft/50）；③ 错误消息行加**类型徽标**（classifyError：网络错误/超时/限流 429/认证失败/流中断/HTTP n，对齐 harness TurnErrorItem code 徽标）；④ 运行状态行显示**重试倒计时**（WifiOff +「网络错误，正在重试 1/3（2 秒后）」，对齐 harness ModelRetryItem）
- **token 优化（借鉴 harness compaction）**：① **压缩边界工具对平衡**（context.ts `balanceToolPairs`：kept 区首条为 tool 结果时向前回溯配对 assistant（不跨 user 边界）——防「tool 消息引用被压缩掉的 call_id」API 400）；② **摘要过大拒绝**（SUMMARY_MUST_BE_SMALLER：摘要估算 ≥ 被替换内容 → 拒绝注入，降级为直接丢弃——防「压缩后反而更占」）；③ **400 上下文超限自动压缩重试**（chat.ts `isContextWindowExceeded`（400 + context/token 特征）→ loop catch 强制 `ensureContextBudget(true)` 压缩后清空累加器重试一次，每轮一次——估算低估时兜底）；④ **usage miss 兜底**（DeepSeek wire 的 prompt_tokens 含缓存命中 → miss = max(0, prompt - hit)，命中率统计不再虚高）；⑤ **前端中英混合估算**（中文 1 字符≈1 token、其他 4:1，与后端 estimateTokens 同式——旧字符/4 对中文严重低估）；⑥ **空闲超时 120s → 300s**（对齐 harness DEFAULT_STREAM_IDLE_TIMEOUT_MS——深度思考模型长思考不再被误杀）
- **断网可见性**：streamChat 重试退避前回调 `onRetry`（attempt/maxAttempts/delayMs/message）→ gateway 透传 → loop emit `retry` 事件 → SSE → 前端状态行倒计时 + 事件落库审计
- **验证**：agent/web tsc + vite build 全过；全量套件分批跑绿（compress 33 新增摘要拒绝/配对 5 断言、retry 22 新增 onRetry/超限识别 8 断言、其余 30 套件无回归；browser.test 平台 kill 跳过——v3.1 已绿且本次无关）
- ✅ **v3.2 补 2：审批全权放行 / read-before-edit / computer use 增强 / description 修正（2026-08-17，用户四问后拍板）**：① **审批流畅化**——审批弹窗新增「**本会话全部放行**」按钮（/api/approvals/bypass + sessionBypass + guard 插点）：开启后本会话内所有审批（含联网/自注册/高危命令红线）直接放行直到会话结束；显式禁用工具仍拒绝；CLI -y/定时任务无人值守不受影响；运行状态行「⚡ 本会话已全权放行 · 点击关闭」徽标。调研定稿：harness 审批不完整（无命令分析/无批量/无记忆，danger-full-access 粗放零弹窗）；opencode 完整参考（--auto 全放 + Ask once/always/reject，always=会话级记忆）；② **read-before-edit**（对齐 harness fs-observation-policy / opencode Edit 先读后改）：按会话跟踪已读文件，edit_file 未读拒绝、write_file 覆盖已存在文件未读拒绝、新建免读、read/edit/write 成功刷新观察；③ **computer use 增强**：修复 DPI 缩放点击坐标偏移（SetProcessDPIAware + VirtualScreen 多显示器 + 原点偏移回补）+ 新增 screen_scroll/screen_key/screen_move 三工具（46→49）；④ description 乱码 → "InFu"。验证：approval-cache 25（bypass 8 断言）、tools 23（read-before-edit 9 断言）、全量无回归。commit `0270a6d`

### ✅ v3.3 异步任务编排（ZCode 等待机制）+ computer use 补齐（2026-08-17，用户三项任务：调查/核实/审计 + 落地）
- **① ZCode「等待时先做别的」机制原理（asar 提取 D:\app\ZCode\resources\app.asar + 两次真实通知注入实证）**——**四件套**：异步启动（Agent/Bash `run_in_background` 立即返回 task-id+output-file）→ **完成通知注入（核心）**：后台任务完成/失败/停止时向会话注入 role=user 的 XML 消息——`<task-notification><task-id>…<tool-use-id>…<output-file>…<status>completed|failed|stopped|killed|lost</status><summary>…</summary></task-notification>`（子智能体用 `<subagent-notification>`；消息类型集合含 task_notification/task_status/subagent/agent_control_message 等系统注入类）——模型下一轮请求实时看到通知 → 自主决定回收结果/继续别的/继续驱动 → TaskOutput block=true（阻塞等待）/block=false（非阻塞查询）→ TaskStop/SendMessage 生命周期 + 系统通知声音/聊天流条目
- **InFu 落地（补齐 v2.11 已有异步启动/非阻塞查询/控制工具之外的缺失四件）**：
  1. **完成通知注入**：新 `task-notification` 事件（shared AgentEvent：taskType subagent|job / taskId / name / status / summary / outputFile）+ **runAgent 局部队列 pendingNotes**（ToolContext.enqueueTaskNotification 接线，随循环结束自然消亡无泄漏）**每步开始 drain → user XML 消息注入 messages**（drain 在 ensureContextBudget 后、模型调用前）；startBackgroundSubagent（完成/异常两路径，stopped=任务被中止）与 startBackgroundJob（finishOnce：completed/failed/killed 三态）完成点 emit 事件 + 入队；**rebuild.ts 同格式恢复**（离线重建与运行时一致；纯文本 user 消息不破坏 assistant/tool 配对）
  2. **wait_task 阻塞等待工具（第 50 个）**：ZCode TaskOutput block=true 语义——轮询 500ms 等待 subagent/job 完成返回结果（子智能体=摘要 / job=输出尾部+退出码）；超时返回「仍在运行+进度」让模型决策继续等/先做别的/中止；等待中遇到子智能体 waiting 提示 send_message 恢复；进 READONLY_TOOLS 只读白名单；与 report/job_output（block=false 非阻塞查询）互补
  3. **提示词「异步任务纪律」3 条**（DEFAULT_SYSTEM_PROMPT：耗时任务优先 background 异步启动→立即继续其他工作；收到 <task-notification> 后 report/job_output 回收 / send_message 驱动 / interrupt 中止；需要结果才 wait_task，不空转轮询）+ delegate_task/run_command 后台描述补「完成后会收到 <task-notification> 通知」
  4. **前端 EventRow 通知行**（用户拍板同款）：store taskNotes（实时 appendTaskNotification + 重放 case 双路径）+ ChatPanel EventRow（completed=CheckCircle2 绿 / failed=XCircle 红 / stopped=OctagonX 黄 / killed=Skull 红，标题「后台子智能体/任务完成：name」+ 摘要首行 + 展开详情 + subagent 提示右栏 tab）
- **② opencode 改动核实 = 13/13 全部落实并在 UI 显现**（前端 explore 逐项核查 + tsc + vite build：审批全权放行按钮+⚡徽标、EventRow 事件行、失败摘要顶替、错误类型徽标、重试倒计时、三栏 3.25rem、批量审批、热力图/趋势图、ComputerUsePane、SchedulePane；顺手修 RightRail 过时注释 + ComputerUsePane 图标细分）
- **③ computer use 审计（联网对照 Codex 官方契约 get_app_state/click/scroll/drag/press_key/type_text/window 管理 + 社区 MCP；Claude Code 截图/单击双击三击/拖拽/打字/修饰键 + tiered per-app 控制）**——**结论：核心闭环（截图→视觉→点击/输入/滚动/按键/移动 + DPI 多显示器修复 + 逐次审批）已达主流水准，但「Codex/Claude Code 最新水准」不完全属实——缺三项：① 拖拽 drag（两家都有）；② 窗口/应用管理 list/activate（Codex 官方 + 社区 MCP 标配）；③ UI 结构读取（accessibility tree，Codex get_app_state 契约）**。**用户拍板补 drag + 窗口管理**：**screen_drag**（x1,y1 → x2,y2 分步拖拽：SendInput LEFT DOWN → 分步 SetCursorPos → LEFT UP，medium 审批）+ **screen_windows**（list=Get-Process MainWindowHandle 非零可见窗口 low；activate=进程名/标题 **Contains 模糊匹配**（-match 正则注入风险）+ SetForegroundWindow+ShowWindow(SW_RESTORE) 恢复最小化，medium 审批；主进程 PowerShell 零依赖）；工具 49→52；Timeline（Move/AppWindow 图标）+ ComputerUsePane 图标补齐；**遗留：UI 树读取（accessibility tree）未做（高成本拆分后续）**
- **验证**：新 task-notify 套件 31 项（job 三态通知 notify 回调/后台子智能体 completed+failed 通知/运行时注入 XML 结构+尖括号转义+不破坏工具配对/rebuild 注入双条/ wait_task 完成·超时·未找到·waiting 提示/工具注册 52 个 + 只读白名单）+ 全量 37 套件无回归（subagent 只读断言 14→15 同步）+ agent/web/desktop tsc + vite build 全过 + **CLI 真实 agnes 端到端**（后台长命令 → 同轮并行 read_file 做别的 → wait_task 回收 → 回复含 E2E_JOB_DONE + 确认收到 task-notification）

### ✅ v3.5 常规设置 10 项 + 审批 full 档 + 数据生命周期治理（2026-08-17，用户七项任务拍板）
- **① 审批 full 档（完全信任）**：shared ApprovalMode 加 `full`（UI 卡片「全权放行」红色圆点）——所有审批自动放行（含 requireExplicit 联网/自注册/高危红线），仅剩硬闸（显式禁用工具、受保护路径、断网策略、路径作用域）；CLI `-y` 跳过提问、scheduler 不传 askUser 不卡死；审计照常落库。验证：approval-policy 61/0
- **② 设置有效性审计**：GET /api/config 补 memory 节；shared 删 capabilities 死代码；web 删 fetchRoles/saveRoles 孤儿；desktop 启动复算 autoLaunch。验证：settings-api 62/0
- **③ 数据全生命周期治理**：日志轮转（sandbox maybeRotateLog：5MB × 3 份）+ agent.log 同样轮转；会话删除联动清理（outputs/browser 会话前缀文件 + attachments 目录）；**索引孤儿**（removeProject 同步 deleteIndex，projects.ts 时序修复）；**备份过期清理**（cleanup.ts cleanupOldBackups 7 天，projects/schedule 损坏备份接入）；**worktree 清理**（orchestrator 收尾 discardCleanWorktrees：status 干净 → remove + 分支删除）。验证：新 cleanup 套件 19/0
- **④ 自动 git 提交（general.autoCommit，默认关）**：任务真实干活后 orchestrator 收尾 `git add -A + commit`（消息 = 指令前 50 字，**绝不 push**），成功在交付文本追加提示；非仓库/无改动/无 git 身份静默
- **⑤ 记忆自动提炼（memory.autoRefine，默认开）**：新 memory/refine.ts——任务收尾用 Executor 模型单次轻量调用提炼 conventions/lessons/preferences JSON，writeMemory 追加（敏感检测复用）；任何失败静默。验证：新 refine 套件 13/0（parseEntries 7 + tryAutoCommit 6）
- **⑥ 常规设置 10 项（Web 常规 Tab + 桌面接线）**：taskNotifications/notificationSound/autoContinueQuestions/showThinking/showTodos/autoArchive + archiveRetentionDays + closeToTray/preventSleep/数据路径只读说明；ask_user 语义定稿（autoContinueQuestions 开=5 分钟未答自动继续、关=一直等、默认=一直等，替换 v3.4 的 15 分钟兜底）；server 启动 autoArchive（updatedAt 超保留期自动归档）；桌面 main.ts——closeToTray 拦截 hide + before-quit 放行、preventSleep powerSaveBlocker（user-message 启/done 停）、任务完成 Electron Notification（silent 随 notificationSound）
- **⑦ 对话流对齐 harness 收尾**：滚动跟随阈值 48→24px（时间戳 hover/748px 列宽/工具行 24px/StatsLine 12-20 此前各批已具备）
- **验证**：agent 全部套件绿（plugin 78/subagent 94/memory 84/projects 21/git-tools 17/web-tools 10/task-tools 13/fs-tools 37/loop-opt 14/tools-opt 12/builtin-skills 11/browser 10/subagent-control 24/jobs 19/v212 16/task-notify 31/bugfix 14/cleanup 19/vision 25/refine 13/settings-api 62/approval-policy 61/approval-cache 25 等）+ web tsc/vite build + desktop tsc 全过；terminal AttachConsole 仍为环境限制（非回归）

### ✅ v3.4 审计修复批（2026-08-17，综合评分 7.6/10：安全 7.5 / 核心循环 7.0 / 工具 7.5 / 前端 8.5 / 桌面 8.0 / 测试 7.5 / 文档 7.0）


- **H1 回归测试（vision）**：新 `tests/vision.test.ts` 25 项——read_image 注入/边界（越界/不存在/非图片/8MB 上限）、screen_capture 注入 + **H1 浅拷贝回归**、screen_click 审批流、screen_type/scroll/key/move/drag/windows 通道、非桌面拒绝；25/0 通过
- **M7 截图 8MB 上限**：tools/vision.ts screen_capture 落盘前 statSync 校验，超限拒绝不注入队列
- **M8 八进制 SSRF**：tools/web.ts normalizeV4Shorthand 前导零（`0xx` 段）fail-closed 拦截
- **M9 路径大小写**：sandbox/index.ts isProtectedPath win32 统一小写归一（防 `C:\Users\Me\.INFU` 等变体绕过写保护）；sanitizeEnv 敏感词补 URL/URI/DSN/CONNECTION
- **M5 LSP 惰性**：tools/lsp.ts tsserver 首次调用才探测（null=未探测/""=不可用/路径=可用），不可用空结果不再崩溃
- **M1 桌面 loopback 封堵**：desktop/src/main.ts isLoopbackTarget（localhost/.localhost/::1/IPv4 简写首段 127/0、非标准数字段 fail-closed）+ sanitizeBrowserUrl 拦截（嵌入式浏览器 webview sandbox=no 防读本机服务）
- **M6 注册表剪枝**：subagent trimBackgroundAgents（完成保留 20）/ jobs trimJobRegistry（完成保留 20）——防长跑进程内存与事件流膨胀
- **M12 git 越界**：git-tools gitRun 加 isPathInside(ctx.root) 校验
- **M3 工具重名兜底**：MCP/插件工具与内置重名不再覆盖——loadMcpTools/loadPlugins 预置内置名集合，withMcpTools/withPlugins 冲突改名 `ext_` 前缀（server/cli 调用处传 Object.keys(TOOLS)）
- **M4 会话清理收敛**：server 任务 finally + scheduler-runner finally 统一补 clearObservedFiles/clearApprovalMemory/clearSessionBypass；pendingApprovals/pendingQuestions/pendingPlans（resolve cancelled）任务结束清空
- **低危批量（后端）**：delegate_task 写委派 requireExplicit=true；wait_task 循环检查 abortSignal；run_command 输出落盘前凭据检测（命中不入盘回填裁剪+警告）；saveConfig chmod 0600（非 win32）；schedule 加载逐条校验+损坏备份、cronMatches 删死参数；ask_user 15 分钟超时；`/api/sessions/:id/events` 白名单（MIGRATABLE_EVENTS 12 类）；loop 摘要调用补 usage 聚合 + model-call 事件（shared 加 summary 字段）+ rawToolCalls→validToolCalls 统一回填 + max-steps 总结失败降级完成不再 throw；dangerous.ts 三个 RegExp 按位或编译错误 → 合并单正则；web.ts 工具头注释修正（low+netGuard）
- **低危批量（前端）**：apiUrl() helper（token query 拼装，server 中间件同步接受 `?token=`——img 无法带 header）；ComputerUsePane 两处截图 img 改 apiUrl + 缩略图加载失败占位（此前桌面打包版截图预览全部 401）；ReviewPane diff 请求竞态守卫（diffSeq 序号作废过期响应）；Modal 焦点管理 + 背景滚动锁（Tab 不逃逸弹窗、wheel 不穿透滚动，多层嵌套自然恢复）+ Esc 注释修正；ChatPanel 三处静默 catch → addError 提示（插件列表/审批档位/项目列表）
- **验证**：agent 34 套件全绿（vision 25 新增、win-sandbox 38、win-sandbox-net 1 等）+ web tsc + vite build + desktop tsc 全过；terminal 套件 node-pty AttachConsole 部分为本 shell 无交互控制台环境限制（检测/审计断言全绿，非回归）；browser 套件平台门控跳过；tasks.test.ts 已随 best-of-n 移除

### ✅ v3.5 补批：四项用户反馈修复 + 数据目录可迁移（2026-08-17，用户四项反馈 + 拍板「不怕改得多」选 B 方案）
- **① 审批「本会话全部放行」按钮点了没反应**（根因实锤）：server.ts 路由注册顺序 bug——`POST /api/approvals/bypass` 注册在 `/api/approvals/:id` 之后，"bypass" 被 :id 路由吞掉返回「审批不存在或已过期」→ 前移修复；配套 store.ts ApprovalState 加 sessionId、api.ts 两处传 connSid、ApprovalModal 用 approval.sessionId + addError 提示（不再静默）。playwright 实测：弹窗关闭 + 「本会话已全权放行 · 点击关闭」徽标
- **② 数据目录可迁移（对齐 ZCode「根目录可选、内部结构固定」，方案 B）**：新 `src/data-dir.ts`——`~/.infu-redirect.json` 固定指针（防「指针随目录搬走」鸡生蛋）+ resolveDataDir 进程级缓存 + migrateDataDir（校验：绝对路径/非当前/非主目录/非盘根/非嵌套自身/空目标；**复制**迁移旧目录保留备份 + 写指针 + 失效缓存同进程即刻生效）；**全部用户级路径惰性函数化**（configPath/logDir/logFile/projectsFilePath/schedPath/commandLogPath/defaultDbPath/index 目录/agents/skills/globalMemoryDir/attachments/plugins/desktop-window.json/isProtectedPath 动态 dataDir）；API `GET/POST /api/data-dir`；设置「数据与统计 → 数据存储」新 Tab（DataDirPane：当前路径 + 默认标注 + 桌面 selectPaths 目录选择 / Web 手输 + 两段式确认 + 非空拒绝回显）；项目级 `<root>/.infu` 语义不变。验证：新 data-dir 套件 31/0 + 真实迁移端到端（~/.infu 复制到 temp 全子项齐全 + 指针写入 + 重启回默认）+ smoke7 全过
- **③ 设置-命令 Tab「全权放行」红点常亮**：SettingsModal 圆点改仅 `policyMode === m && m === "full"` 才 bg-danger（smart 档显示中性色）；smoke6 实测 smart 档 bg-danger=0
- **④ read-before-edit 改 opencode 自身语义**：删 tools/index.ts write_file/edit_file「未读拒绝」硬闸，工具描述改建议性（建议先 read_file 拿行号）、old_text 不匹配提示增强；tools.test.ts 断言同步「未读可直接编辑/覆盖」+ fixture package.json 恢复完整（含 scripts.test）；tools 23/0
- **验证**：agent 全量套件 0 失败（新增 data-dir 31；tools 23、projects 21、schedule 逻辑由 settings-api 62 覆盖、memory 84、cleanup 19、session-store 30、approval-cache 25、approval-policy 61、sandbox-config、win-sandbox、mcp 13、plugin 78、subagent 94、subagent-control 24、jobs 19、v212 16、git-tools 17、fs-tools 37、web-tools 10、task-tools 13、builtin-skills 11、vision 25、win-sandbox-net 1、compress/retry/rebuild/fallback/steps/thinking/templates/loop-opt/tools-opt 全 0）+ agent/web/desktop tsc + vite build 全过；terminal 环境限制非回归

### ✅ v3.5 审计修复批 2（2026-08-17，用户四项任务：full 档图标 + 卡死诊断 + 自适应尺寸 + 自由修复审计）
- **① 审批 full 档图标改三角感叹号（用户任务 1 收尾）**：SettingsModal MODE_META 加 icon/iconCls（auto=ShieldAlert/text-warn、smart=Scale/text-sub、confirm=ShieldCheck/text-sub、full=AlertTriangle/text-danger）+ save 后同步 store；**CLI makeDecider 补 full 档语义**（先 shouldAutoApprove===true 直接放行 → requireExplicit 不再拦截——CLI -y/full 档红线也全放行，与 Web full 档一致，此前 CLI 缺 full 分支）
- **② InFu(test) 会话卡死诊断（用户任务 2）**：会话 `3e717b18`（打招呼）事件流实证——seq 427 browser_screenshot **成功返回**（文件已保存），卡住的是**截图后的下一次模型调用**：52 秒零输出（无 reasoning/text 事件），用户手动停止。**根因 = chat.ts 无首字节超时**（只有 300s 空闲超时）→ 模型 API 静默挂起无反馈。**修复：首字节超时两段式预算**（gotData 标志：收到首帧前 = min(timeoutMs, 60s)，首帧后 = timeoutMs；错误文案区分「等待响应超时（连接可能挂起）」/「响应中断（N 秒无数据）」）。不是死循环（事件流无重复调用），非截图挂起
- **③ 浏览器「自适应尺寸」按钮无效（用户任务 3）**：根因 = 用户点击只改元素 CSS（setFreeSize），Agent 用 browser_viewport 设过的 CDP Emulation 残留 → 页面停在旧视口。**修复**：渲染进程 → 主进程 IPC `browser-view:set-viewport`（preload.cjs + desktop.d.ts + main.ts ipcMain.handle：Emulation.setDeviceMetricsOverride{width,height,deviceScaleFactor:0,mobile:false} / clearDeviceMetricsOverride，随后 __infuNotifyViewport），BrowserPanel 预设/适应窗口/自定义尺寸三处同步调用
- **④ 自由审计修复（用户任务 4，全量实现）**：
  - **安全**：dangerous.ts 补 `\b(Remove-Item|ri)\b`（H3）；net-policy EGRESS_TOOLS 补 iwr/irm + 模式补 `/fetch\s*\(/i`、Invoke-WebRequest/Invoke-RestMethod/Start-BitsTransfer（H7）；tools/index.ts git_status/git_diff/run_test 补 isPathInside 越界拦截；**桌面 H1 修正**——main.ts sanitizeBrowserUrl 的 loopback 拦截改**仅 InFu 服务自身端口**（v3.4 拦全部 loopback 是误伤：localhost:5173 vite 本地预览是核心用途）+ registerBrowserWebContents 补 will-navigate/will-redirect guardNav + setWindowOpenHandler 一律 deny + __infuCdpSend 对 Page.navigate 兜底；server 令牌注入窄化为仅 index.html
  - **逻辑**：loop.ts 压缩闸死代码修复（`if (r.summary)` 永不触发 → `if (r.after < r.before)`）；schedule.ts cron 周日 `0`/`7` 双接受；**server.ts H4 会话级清理精确化**——pendingApprovals/pendingPlans/pendingQuestions 三 Map 值改 `{sessionId, resolve}`，任务 finally 只清本会话挂起（并行会话不再互相误清）；MCP callTool 180s 超时 + 探测定时器 .unref()；db/store.ts 构造器加 WAL + busy_timeout=5000（只读库忽略）；agents.ts readAgentFile 名称白名单 `^[a-z0-9][a-z0-9-]{0,63}$`（H2）；终端输入 data 推导命令行（command 缺失时逐行检测高危 + 逐行审计，防直连 API 绕过）；subagent.ts:613 Promise.all 核实安全（runSubagent 从不 reject）跳过
  - **前端**：**审批跨会话串扰修复**——store resolveApproval/resolveAllApprovals 按 activeSessionId 过滤 + ApprovalModal 只展示/处理当前会话审批（多会话并行时后台会话审批不再被误处理；服务端任务结束自动清理挂起项）；**QueueDock Stop&Send 竞态**——abortRun 后轮询等待 runningIds 移除再 sendChat（服务端同会话双发保护会 400），8s 超时兜底
  - **测试基建**：npm test 补 4 套件（cleanup/data-dir/refine/vision）；**memory.test.ts 数据目录重定向**（setDataDirForTest 临时目录——原测试写+递归删用户真实 ~/.infu/memory）；cleanup.test.ts 同样重定向（原在真实 ~/.infu 建删 attachments/写 projects.json）；approval-cache/web-tools 固定 smart 档（备份/恢复——原隐式依赖用户真实 config 档位，用户设 confirm 后挂）；假阳性断言清理（memory `|| true`、mcp `check(...,true)`、terminal resize 恒真、approval-cache 名实不符占位 → 真实禁用策略注入验证）
- **验证**：**40 套件全绿**（全量 npm test 单次跑完：tools 28/templates 13/win-sandbox 18/win-sandbox-net 21/session-store 30/retry 22/rebuild 20/fallback 18/compress 35/steps 17/config-migration 15/thinking 30/providers-api 7/mcp 72/approval-policy 61/approval-cache 25/sandbox-config 29/settings-api 62/terminal 41/plugin 78/subagent 94/memory 84/projects 21/git-tools 17/web-tools 10/task-tools 13/fs-tools 37/loop-opt 14/tools-opt 12/builtin-skills 11/browser 10/subagent-control 24/jobs 19/v212 16/task-notify 31/bugfix 34/cleanup 19/data-dir 31/refine 13/vision 25，0 失败）+ agent/web/desktop tsc + vite build 全过（顺手修 3 个编译错：server.ts 终端 lambda 隐式 any、SettingsModal JSX 计算属性组件非法、main.ts __infuNotifyViewport 可调用性断言）；terminal AttachConsole 为环境限制非回归

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

### v2.6 记忆与任务【✅ 批 1 + 批 2 + v2.6.1 会话中枢重构 + 收尾全部完成 2026-08-13】
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
- ✅ **v2.6 收尾（2026-08-13，主流 Agent 工具补齐 + Git 优化 + 工具调用优化）**：
  - **主流 Agent 工具调研补齐**（联网调研 Claude Code/Gemini CLI/opencode/Codex 四家工具集后实施）：
    - **联网工具**（走 run_command network=true 同款门禁：high + requireExplicit 审批，-y 不放行，默认断网）：webfetch（URL 抓取 → HTML 转纯文本，1MB 响应上限/20s 超时/max_chars 可配）+ web_search（默认 DuckDuckGo Instant Answer 免 Key；设 INFU_TAVILY_API_KEY 自动切 Tavily，质量更高）
    - **Git 提交链**（补齐 status/diff 之外）：git_log（只读）/ git_add（暂存，中）/ git_commit（本地提交，high，绝不 push，all=true 自动暂存；无改动友好提示）/ git_branch（list/create/switch，分支名白名单 ^[A-Za-z0-9._\\/-]+$ 防注入）；git_diff 增强（stat 可关、file 按文件过滤）
    - **任务协作**：read_files（批量读多文件省轮次，进 Planner/Reviewer 白名单）/ todo_write（执行阶段任务清单，整体替换，内存态按 root 隔离）/ ask_user（执行中向用户提问——全链路：ToolContext.askUser + ask-user 事件 + POST /api/ask/:id + CLI stdin 交互 + Web AskModal 弹窗（复用审批弹窗 Dark OLED 风格）；子智能体继承父级通道）
  - **工具调用优化**（loop.ts 四项）：
    - **畸形 JSON 修复**（repairToolArgs：去 markdown 围栏/去外层括号/修尾逗号/单引号键值逐级修复，仍失败回填错误让模型重发——不再把垃圾参数丢给工具执行；数组/标量等非对象结果拒绝）
    - **未知工具提示**（报错列出全部可用工具名，模型可自纠）
    - **写工具串行 / 只读并行分组**（isMutatingTool：write/edit/run_command/run_test/git 写操作/mcp_register/plugin_add/memory_write/todo_write/ask_user 串行执行，防并行写同一文件互相覆盖；只读/委派保留 v2.5 并行语义）
    - **工具结果统一裁剪**（回填模型的消息副本 8K 上限 trimToolResult；事件/落库保持完整——与上下文压缩同哲学：DB 无损、运行时控预算）
  - **结构**：tools/index.ts 公共助手（命令执行/审批/遍历/裁剪）抽取到 tools/util.ts；新工具分模块 web.ts / git-tools.ts / task-tools.ts 挂接
  - 验证：npm test 全绿（新增 git-tools 17 / web-tools 9 / task-tools 11 / loop-opt 14 共 51 项）+ 工具层自测（真实 git 仓库提交链/本地 HTTP 抓取/审批门禁拒绝）
- ✅ **主流式流程改造（v2.6 收尾追加，2026-08-13，用户评审「三档太死、恢复主流 Agent 做法」）**：**默认流程 = 单一 Agent 循环直接执行**——模型自主决定（寒暄直接回复 0 工具、复杂任务自主探索 / todo_write 建清单 / 执行），**不再强制 Planner→计划确认→Executor→Reviewer 流水线**（这是"发个嗨也要跑规划/执行"的根因）；**计划确认默认不弹**（Web 曾硬编码 planApproval:true 已删）；**Planner/Reviewer 分层保留为显式可选**（CLI --orchestrate / API orchestrate:true 开启，对齐 Claude Code /plan 用户触发语义）；清理三档残留（web store orchestrate/mode 状态、server mode:"orchestrate" 硬编码、api planApproval:true）；DEFAULT_SYSTEM_PROMPT 加消息类型判断（非开发任务直接回复不调工具）+ todo_write 引导；Executor 提示词兼容无计划场景（自主规划）
- ~~批 2 任务看板（2026-08-13）~~：**v2.6.1 按用户评审整体删除**（「任务=会话」误称产物；实现含 .infu/tasks/ 文件 + task 工具 + Kanban 视图 + rubric，均已移除，详见 v2.6.1 概念修正节）
### v2.7 生态与数据【✅ 批 1 插件/技能生态 + 设置界面补齐；剩余项低优先级】
- ✅ **批 1 插件/技能生态落地（2026-08-13，借鉴 zcode 官方插件）**：
  - **官方能力统一为「内置插件」**（对齐 zcode：插件=分发单位，内容可为工具/技能）——3 个官方插件随 InFu 分发、默认启用、设置界面插件列表可见可禁用：**browser-use**（playwright-core 1.62 驱动 chromium：browser_navigate/snapshot/click/type/fill/screenshot/close 7 工具，navigate 联网门禁 high+requireExplicit、交互 medium 审批、截图存 .infu-browser/；chromium 自动探测 ms-playwright；control-browser + web-gui-tester 两技能随插件）、**document-skills**（docx/pdf/pptx 从 Anthropic 官方 document-skills 复刻，35+31+5 文件 + Python 脚本，补装 python-pptx/reportlab/pypdf，SKILL.md 加 InFu 环境适配头）、**skill-creator**（引导 Agent 写高质量 SKILL.md，适配 InFu 目录约定）
  - **插件技能挂载机制**（loadPlugins→skillDirs→registerPluginSkillDirs 注册表 + listSkills level=plugin；SkillMeta level 加 builtin/plugin）
  - **插件市场雏形**（marketplace.ts 内置注册表 + PluginConfig source/version 元数据 + `infu plugin marketplace/install` 一键安装）
  - **内置插件合并加载**（mergeBuiltinPlugins：默认启用，config {id,enabled:false,source:builtin} 禁用；/api/plugins 合并视图 + PUT/DELETE 内置只能启停；probe 传 mergeBuiltin:false 只探测目标）
  - **YAML 折叠块解析增强**（parseSkillFrontmatter 支持 description: > 块标量——Anthropic 官方写法）
  - **设置界面「浏览器」「记忆」「索引库」「使用统计」四 Tab 填充**（原「规划中」占位全部落地）：浏览器 Tab = 浏览器控制开关 + 无头/有头 + 浏览器路径 + 浏览器数据（清除缓存/清除全部，POST /api/browser/clear），config.browser 持久化；记忆 Tab = 四层记忆说明 + 自动沉淀开关（config.memory.autoSediment）+ INFU.md 指令查看 + 全局/项目记忆查看（GET /api/memory）；**索引库** = 轻量文件索引（src/index/ 文件清单持久化 ~/.infu/index/，search_code 优先复用，状态+重建 GET/POST /api/index）；**使用统计** = 会话事件流聚合（tokens 字符/4 估算、会话/消息/活跃天数/连续天数/最常用模型/按天趋势/模型用量，GET /api/stats）
  - 验证：`npm test` 全绿（新增 builtin-skills 11 / browser 10 / settings-api +17）
- ⏳ **剩余（低优先级/暂缓，2026-08-13 用户定稿）**：~~**computer-use 插件**~~（**后已完成**：v3.0 批 10 vision 底座 + 批 11 screen_capture/click/type + 批 12 scroll/key/move/drag/windows）；**skill 模板库**（导入/导出已做，模板库/市场雏形可选）；**远程市场**（用户明确不需要）；~~**定时任务/自动化**~~（**后已完成**：v3.0 批 11 schedule CLI + Web UI + 无人值守审批）；~~**语义检索**~~（**后已完成**：v3.0 批 11 semantic_search BM25 本地索引）；**团队基础支持**（v3 触发条件未到，暂缓）

### v2.8 UI 整体打磨【✅ 2026-08-14，用户触发「抄作业 e/app/deepseek-harness」】
- **定稿基调（用户三项决策）**：主强调 = **中性灰**（主按钮暗色近白 #F9FAFB / 浅色近墨 #0F1115；语义色不变——成功/运行绿 #22C55E、链接信息蓝 #679EFE、进行中 #5686FE、警告黄、错误红）；**深+浅双主题**（深色默认，html[data-theme] 翻转整套 token，设置→外观切换、config `appearance.theme` 持久化）；**去顶栏**（三栏通高，Logo/新建/搜索/设置全进侧栏）
- **设计系统重写**（web/index.css）：移植 harness 双主题 token（中性蓝灰阶 #151517/#232325/#2C2C2E/#353638/#1B1B1C ↔ 白系；文字四级；透明度边框 l1–l4；阴影 lv1–3；圆角 8–24；ease 曲线）；`@theme inline` 把旧类名（bg-ink/panel/muted/line/text/sub…）映射到主题变量 → 全站类名自动双主题；滚动条 8px 薄款；`prefers-reduced-motion`；store 新增 theme/侧栏折叠与宽度/详情栏开合与宽度（localStorage 持久化）
- **三栏骨架**（App.tsx）：Grid 可拖拽（侧栏 264–420 / 详情 300–520，8px 隐形热区 + 右侧 12×32 圆角拖柄，折叠态点击重开）+ 侧栏折叠 rail 56px（<1024px 自动折叠）+ 详情栏可关到 0；键盘快捷键保留
- **侧栏重构**：60px Logo 行（宝石 Logo + InFu + AGENT 徽标，点击新建会话）+ 新建会话 38px r12 条 + 搜索胶囊（28px 圆 → 药丸，Ctrl+K）+ 会话树 32px 行（16px 状态点/悬停换操作）+ 底部设置行；rail = Logo 展开/新建/设置三圆钮
- **对话区**：空态 Hero（光晕 #6187D8@9% +「探索未至之境」26px + AGENT 徽标 + 项目 chip + 模板卡片）；用户消息右侧 r22 气泡（暗 #2C2C2E / 浅 #EDF3FE）max-w 525 + 悬停复制/回滚操作行；助手无气泡全宽 16/28；**思考/工具折叠行**（24px 图标+标题+2×2 点分隔+摘要，运行中 2.6s 扫光带，展开 IN/OUT r12 卡片粘性标签）；运行状态 shimmer 行 + 耗时；回到底部 34px 圆钮；`.infu-md` markdown 全套样式（标题/列表/表格/引用/代码块 r12 粘性语言条）
- **输入胶囊**：r22 悬浮卡 max-w 780 + lv2 阴影，textarea 自适应（max 336px）+ 工具行（工作树 chip / 模型药丸 / 思考 1–4 / **34px 圆形发送键** ↔ 运行中停止方块，空输入 0.4 透明）；工作树条/计划卡改 dock 卡（harness 接管卡样式：信息蓝头部条 + 胶囊按钮）
- **右详情栏**：360px 可拖拽可折叠 + 28px 关闭钮；Diff/文件改动/测试结果改 r12 卡片 + 粘性头部 + 复制；SubagentViewer 滑出面板重样式（状态点 + shimmer 运行态）
- **弹窗统一**：新增共享原语 `ui.tsx`（Modal r24 遮罩+blur2px+Esc/胶囊按钮、Toggle、StateDot、DisclosureRow、CodeBlock）；审批/提问/归档/创建项目/设置六弹窗全部收敛；SettingsModal 改 880→min(880,94vw)×min(800,100vh−48) r24 双栏（188px 导航轨 + 54px 内容头）；**修 bug**：固定尺寸小屏不可用、`E:\InFu(test)` 硬编码、`#38bdf8` 硬编码→token、ModelPane 原生 confirm()→统一 Modal、死代码（ToolCard/ComingSoonPane/PLANNED/未用导出/Kanban 注释）
- **终端**：xterm 配色跟随主题（暗 #151517 / 浅 #FFFFFF 两套）+ 热切换不重建；高危确认改统一弹窗；开关按钮胶囊化
- **主题持久化链路**：`appearanceConfigSchema` 加 `theme` 字段（shared 已重建 dist）——旧 server 进程需重启生效（server PUT 用 `.strip()` 会丢弃未声明字段）
- 验证：`npm test` 全绿（exit 0）+ web tsc/vite build 通过 + 浏览器实测（侧栏折叠 56px/展开、详情栏关闭 0px/点击重开 360px、深↔浅主题即切即生效（body #151517↔#FFFFFF、侧栏 #1B1B1C↔#F9FAFB、发送键 #F9FAFB↔#0F1115）、设置弹窗三组导航/保存落盘/4319 新服务端 theme 持久化回读）
- ✅ **批 2 多会话并行 + 排队发送 + 附件 + @插件（2026-08-14，用户拍板四项）**：
  - **多会话并行**（修「执行中不能切会话」bug + harness 式真并行）：store 重构——`running` 全局单值 → `runningIds[]`（每会话独立）+ `sessionCache`（每会话消息缓存，流式事件写对应缓存，切换秒切不丢流式状态）+ `eventTarget`（SSE 事件按连接会话路由，防串扰）+ per-session phase/step；Sidebar openSession/newSession 解除 running 守卫（缓存命中秒切、无缓存拉事件重放）；sendChat finally 用连接自己的 sessionId 重拉（修 Ctrl+N 串扰）；侧栏运行绿点（animate-ping）按 runningIds；**服务端**：/api/chat 续跑加 per-session 检查（同会话双流 400，不同会话真并行）+ 任务启动置 running + 启动时 resetStaleRunning 清残留；`npm test` 859 项全绿
  - **排队发送**（harness QueueDock 增强版 + 主流调研：Claude Code Enter 队列/Cursor Stop&Send）：运行中输入 → 入队（输入卡上方 QueueDock dock 条：编辑 inline/移除/**立即发送 = Stop&Send**（移出队列→abort 当前任务→立刻发）/拖拽排序（原生 HTML5 DnD））；done 事件自动消费队首（循环直到空；停止/异常不消费——队列保留待用户处理）；消费用会话自己的 root（后台并行场景）；占位符提示「AI 处理中…回车将排队发送（队列 N 条）」
  - **附件**（调研定稿：主流 = 图片走视觉 + 文件/文件夹走路径引用；浏览器拿不到绝对路径 → **内容上传方案**）：composer 工具行最左 Paperclip 按钮 + 菜单（添加文件…/添加文件夹…，webkitdirectory）；输入卡上方 AttachmentRail 预览（文件卡片/图片缩略图 + hover 移除，单文件 2MB/图片 5MB/最多 20 个）；发送链路——文件读 base64 → 服务端暂存 `~/.infu/attachments/<sid>/`（任务结束清理）→ 附件绝对路径注入所有阶段 prompt（Agent 用 read_file 读）+ `ToolContext.extraReadDirs` 只读白名单（read_file/read_files 放行、写工具不放行）；图片 dataURL 走 AI SDK image content part 视觉（仅 Executor 阶段；Planner/Reviewer 只收文本引用）；`attachments` 事件落库可重放（用户消息附件行展示，图片字节不落库）；shared AgentEvent 加 attachments 变体
  - **@ 插件**（对齐主流 Cursor @ 实时过滤 + 键盘选择）：光标前 `@` 触发（词边界 + URL/路径豁免）；面板列插件（/api/plugins 含内置，名称+内置徽标+版本）随输入实时过滤；**无匹配自动消失**；↑↓/Enter/Esc 键盘操作 + 点击即用（mousedown 保焦点）；选中插入 `@插件id ` 引用文本（Agent 自主调用其工具）
  - **文件选择文案对齐**（调研确认 harness =「选择工作区」目录选择）：CreateProjectModal「浏览文件夹…」→「选择文件夹…」、SettingsModal「浏览」→「选择文件夹」（webkitdirectory 是浏览器唯一目录选择方式，应用内目录浏览器留待后续）
  - **自由会话 root（用户拍板保持现状）**：不设 defaultRoot 时自由会话 root = agent 启动目录（仓库根），可读写，与 Claude Code 一致；只读规则仅对设置了 defaultRoot 的会话生效（isReadOnlySessionRoot 不变）
  - **字体整体缩小一档**（用户拍板：harness 正文同为 16px/28px，仍觉大）：`.infu-md` 正文 16/28 → **15/25**、h4-h6 同步、表格 15/25 → 14/23；用户气泡 16/24 → **15/23**；根缩放档整体下调（xs 14→13 / sm 15→14 / base 16→15）——UI 文字同步收紧对齐 harness 13px 刻度
  - 验证：`npm test` 859 项全绿 + 浏览器实测（A 长任务 + B 寒暄双会话并行侧栏双绿点、运行中新建/切换会话、切回 A 流式缓存恢复、运行中输入 2 条入队 → done 后 17.5s 内自动消费两条队列清空、@ 面板 3 插件/过滤只剩 browser-use/无匹配消失/Esc 关闭、附件菜单两项、根字号 14px/气泡 15px、会话重放正常）
- ✅ **批 4 交付报告移除 + 滚动跟随修复（2026-08-14）**：**交付报告整体移除**（用户「没啥用去掉」）——loop.ts 删 buildReport/finishWithReport/emit report、RunResult.report 字段删除；orchestrator 删汇总报告与 emit；sediment 历史归档去掉「交付报告」段落（保留文件改动概览/执行摘要/审查意见）；前端删 StructuredBlock success 报告块与 turn 尾报告复制源；shared report 事件类型保留（DB 历史兼容，重放忽略）；测试同步更新（loop-opt 删 4 断言 / memory 删 1 断言，854 项全绿）。**滚动跟随修复**（「AI 快速输出时无法上滑」）——自动滚底从无条件 scrollIntoView 改为**仅用户处于底部附近（离底 <48px）时跟随**（atBottomRef 随 onScroll 同步）；上滑即停跟随、滚回底部恢复、发送新消息强制回底；实测流式中滚动位置 4 秒保持不动 ✓
- ✅ **批 3 消息流细节彻底对齐 harness（2026-08-14，用户「不用验证我来验证」）**：用户消息——气泡内 /name @name 词边界 token 渲染 **refChip**（@ 蓝底 / 灰底，对齐 projectUserText）；操作行图标**常显**（28px 圆形）+ **时间 hover 淡入 80ms**（data-time-hover-root，触屏常显）+ 时间移到图标前（clock start）+ **日期感知时钟**（今天 HH:mm / 今年 M月D日 HH:mm / 跨年带年，对齐 formatMessageClock）+ tabular-nums；助手 turn 尾——图标常显 + 时间在图标后（clock end）+ **`· 运行 Xs`**（finishAssistant 记 endedAt，分:秒）；错误消息专用行（红点 + 「任务失败」标题 + 消息，对齐 TurnErrorItem）；思考行（ReasoningBlock）——行高 28→**24px**、标题 14px、**运行中显示最新行/结束后显示第一行**（harness latestLine/firstLine）、展开 14/24 tertiary 22px 缩进、去掉字数徽标；工具行（Timeline）——行高 24px、工具名 14px/参数 13px 固定 px、2×2 点分隔 margin 0 8px；StatsLine 居中 12/20 tabular；运行状态行 14px + 等宽时钟；**根缩放副作用修复**——消息流所有 rem 字号类（text-sm/text-xs）改固定 px（根 14px 下 text-sm=12.25px 失真）

### v2.9 右侧栏浏览器式改造【✅ 2026-08-14，用户拍板四项】
- **右侧栏标签页系统**：store 新增 `rightTabs`（review/browser/subagent/subagents）+ `activeRightTab` + open/close/setActive；App aside 改造为顶部 tab 条（活动高亮 + 状态徽标 + 关闭 ×）+ 内容区；**空态初始面板**——「打开 tab」标题 + 「选择要在侧面板中打开的 tab」副标题 + 居中按钮组（38px r12 与新建任务同规格）：**审查 / 浏览器 / 子 Agent / computer-use（禁用 + 待开发徽标）**
- **子 Agent tab（自动开 tab + 实时跟随，用户拍板）**：subagent-start 事件 → 自动添加 tab（label = Agent 名）+ 激活（ZCode 式）；tab 上状态徽标（运行中 spinner/完成绿点/异常红点）；SubagentViewer 弹窗 → SubagentThreadView 内容组件（去 absolute 壳，消息流与父对话流同构：ReasoningBlock/Streamdown/Timeline，委派任务描述 + 可折叠最终摘要）；对话流委派条目点击 → 打开对应 tab；旧 subagentViewer 弹窗逻辑删除；多个子 Agent 并行 = 多个 tab 并排
- **审查 tab**：DiffPanel 内容（Git Diff / 文件改动记录 / 测试结果）抽为 ReviewPane 复用组件——审查 tab + 代码模式覆盖层两处使用（对齐 ZCode Review 多文件 Diff 确认）
- **浏览器 tab = 占位（用户拍板：等桌面化）**：「浏览器面板将在桌面版提供（嵌入式真实浏览器，ZCode 同款）——当前 Web 版 Agent 浏览器截图保存在 .infu-browser/ 目录」；~~**桌面化后按 ZCode 同款实现，前端 UI 结构直接复用**~~（**后已完成**：v3.0 批 1-8 桌面化全批次——WebContentsView → webview 元素 + 主进程 CDP 桥，BrowserPanel 多 tab 布局即为此预留结构）
- **子 Agent 上限 = 每会话 6（用户拍板，主流模型）**：调研 harness per-owner 10 / Codex per-session 4 / Claude Code 全局 20——**主流均为 per-session**；ToolContext 加 sessionId（server→orchestrator→loop 传递链）；subagent.ts 每会话活跃计数（runSubagent 进入 +1 / finally -1，Map 无泄漏）+ delegateTasks 超限拒绝（明确错误提示「该会话子 Agent 已达上限 6，当前 N 个运行中」）；多会话各自最多 6
- 验证：`npm test` 854 项全绿 + 浏览器实测（初始面板四按钮/审查 tab Diff 空态/浏览器占位/computer-use 禁用/子 Agent 列表空态/关闭 tab 回空态/**真实委派 explore → 右侧栏自动开 tab「explore」+ 实时显示处理过程**）
- ✅ **批 2 审查 ZCode 式 + 会话归属修复 + 细节（2026-08-14，用户五点）**：
  - **会话归属修复**（「选中项目新建会话却落在自由会话区」根因）：worktree 模式下会话 root 被落库为 `.infu-worktrees/infu-task-*` 临时路径 → 项目匹配失败 → 全部落入自由会话区。修复：`root`（会话归属/落库/记忆）与 `execRoot`（执行目录）分离——前端 sendChat 传 root=项目 + execRoot=worktree；服务端 createSession 用 root、工具执行/INFU.md/作用域用 execRoot。实测新会话 root = 项目 ✓
  - **审查升级 ZCode 式**：新增 `GET /api/review/files`（git diff --numstat + 未跟踪文件 → 每文件 +N/-M）与 `GET /api/review/file`（unified diff；未跟踪 = 全新增行；路径越界拦截）；ReviewPane 重写——上半改动文件列表（文件名 + 加绿减红计数，点击切换）+ 下半**行级 diff 着色**（+ 绿底 / - 红底 / @@ 高亮 / 等宽 12px）+ 测试结果保留
  - **子 Agent 消息流去框**：streamdown 表格/代码块卡片清理抽为公共 hook `useCleanMarkdownBoxes`（聊天区 + 子 Agent 详情共用）
  - **新建 tab 按钮**：tab 条右侧 SquarePlus 图标 → 上拉菜单（审查/浏览器/子 Agent/computer-use 待开发，与思考模式/模型选择同款下拉样式）
  - **tab 条去横线**：border-b 移除（与内容区浑然一体）
  - 验证：npm test 854 项全绿 + 实测（审查 143 文件 +N/-M / 单文件 diff / 新 tab 菜单 / 横线 0px / 会话归属 root=项目）
- ✅ **批 3 代码界面 = 项目代码浏览器 + 审查宏观/微观视图（2026-08-14，用户拍板）**：
  - **代码界面改造**（原 Diff 覆盖层与审查 tab 重叠 → 用户拍板「文件树 + 内容预览」）：新增 `GET /api/fs/tree`（git 已跟踪 + 未跟踪 + diff --numstat 改动统计；非 git 递归扫描跳过大目录）与 `GET /api/fs/file`（内容预览，300KB 截断 + 二进制检测）；新 CodeView 组件——左侧文件树（顶层目录折叠组 + 改动标记：+N 绿 / -M 红 / 未跟踪「新」，含改动的目录自动展开）+ 右侧内容预览（路径头 + 大小 + 等宽 pre）；DiffPanel 删除；与审查 tab 分工：审查 = 看改动 diff，代码界面 = 浏览项目代码
  - **审查宏观/微观**：审查 tab 初始只显示文件列表（宏观），点击文件后**整个 tab 切换为该文件 diff 视图**（微观：返回 ← + 文件名 + 增删统计 + 行级着色全屏），不再上下分栏
  - **root 恢复修复**：刷新恢复会话时不设置 st.root（代码界面/审查 root 变空）→ App.tsx 恢复逻辑补 session.root 回填
  - 验证：构建全绿 + 实测（树渲染/目录折叠/内容预览/root 恢复后 2 文件树正常）
- ✅ **批 4 工作树通知按钮 + 代码界面语法高亮（2026-08-14，用户实测反馈）**：
  - **工作树通知按钮**（替代输入卡上方 dock 条——占空间且与终端按钮重叠）：终端按钮**左边**同尺寸胶囊按钮（GitBranch + 「工作树」+ 运行绿点脉冲），有工作树/通知时显示；点击弹出**下拉面板**（宽 260px 较高：分支名/路径/说明/note + 合并到主分支主色按钮 + 丢弃任务改动）；**store persist 持久化 worktree 状态**——刷新不消失，未操作前按钮一直在（用户抱怨原通知刷新即丢）；合并/丢弃后自动消失；原 dock 条删除
  - **代码界面语法高亮**（VSCode 式，用户「强调色省心美观」）：引入 highlight.js（web 包）；扩展名 → 语言映射（ts/js/json/md/css/html/py/bash/yaml/rust/go 等 common 集合，未知回退纯文本转义）；`.codeview-hl` token 色**随双主题变量翻转**（keyword/operator=info 蓝、string/attr=success 绿、comment=caption 斜体、number=warn 橙、type=ongoing）
  - 验证：实测（工作树按钮终端旁/下拉合并丢弃/刷新持久化；md 文件渲染 20 个 hljs token span）
- ⏳ **遗留（桌面化触发）**：浏览器面板嵌入式真实浏览器（ZCode 同款：地址栏/前进后退/DevTools/Agent 驱动实时跟随；Web 版 CDP 帧流方案与桌面 webview 方案均已评估，桌面化时实施）；computer-use

### v2.10 工具集 / 调用机制 / Token 与命中率优化【✅ 2026-08-14，借鉴 harness + 主流调研】
- **Todo 面板**（用户点名「没见过」）：todo_write emit `todo-write` 事件（落库重放）；前端 store todos + TodoPanel（harness TodoDock 同款：输入卡上方折叠条「任务清单 N 完成 · M 进行中 · K 待办」+ 展开列表；completed 实心对勾/in_progress 旋转环/pending 虚线环；纯展示，状态由模型更新）；实测「任务清单 3 完成」+ 4 事件落库
- **AskModal 升级**（对齐 AskUserQuestion 规范）：ask_user schema 加 multiSelect / description / 选项结构化（label+desc+recommended）；AskModal 多选（checkbox 切换 + 提交计数）/ 推荐徽章 / 选项说明 / 问题 description；CLI/server 通道适配结构化
- **压缩优化**（Token/命中率重点，借鉴 harness compaction）：**压缩前先剪超长工具结果**（pruneToolResults：>8K 保留 head 4096 + 标记 + tail 1024，零模型成本，剪完可能免压缩）；**摘要调用构造为会话真前缀**（当前 system + 原样历史 + 末尾摘要指令——复用 provider warm KV cache）；保留 80%/60% 阈值与失败降级
- **glob 工具**（harness 借鉴，fast-glob）：按模式找文件（`**/*.ts`、`{a,b}` 多选；跳过 node_modules/.git/.infu-worktrees/dist；上限 200；越界 ../ 拒绝）；进 Planner/Reviewer 只读白名单；与 search_code 互补（找路径 vs 找内容）
- **调用机制优化**：**重复调用提醒守卫**（连续同工具同参 3/5/8 次注入「请改变策略/勿重复调用」提醒，不刷屏）；**run_command 输出落盘**（>8K 完整写 `.infu-outputs/*.log` + 回填 head 4K + 路径提示 + tail 1K，模型可 read_file 看全量）；**只读并行组滚动池上限 10**（防单轮 20+ 只读调用爆内存，harness maxParallel 同款）
- 验证：npm test **866 项全绿**（新增 tools-opt 12 项：glob 命中/越界拒绝/白名单、剪枝头尾保留、剪枝联动免压缩）+ 浏览器实测（Todo 面板渲染 + 事件落库）
- ✅ **批 2 web_search 修复 + 工具小优化（2026-08-14，用户「web_search 经常搜不到」）**：
  - **根因**：① 原 DuckDuckGo Instant Answer API 只返回「即时答案」卡片（绝大多数查询为空）；② 实测本网络环境 **DuckDuckGo 全家（api/html/lite）全部不可达（000）**而 Bing 可达——所以 web_search 一直失败
  - **修复**：新增 **Bing RSS 搜索**（`format=rss` 标准 XML，免 Key、无 HTML 反爬 challenge，实测 5 条真实结果）；后端链 = Tavily（有 Key）> **Bing RSS（免 Key 主后端）** > DDG HTML > DDG Instant Answer 保底；「未找到」提示附换词建议
  - **工具小优化**：search_code 正则无效时友好报错（提示转义，替代笼统「工具执行异常」）；webfetch 保持
  - 验证：Bing RSS 实测 5 条真实结果 + npm test 866 项全绿
- ✅ **批 3 webfetch 重写 + 工具能力审视（2026-08-14，用户「webfetch 不好用，看看其他工具能力」）**：
  - **htmlToText 重写**：块级标签（p/div/li/h1-6/table/br 等）→ 换行保持段落结构（原实现全部压成空格挤一行——可读性差根因）；行内标签→空格；实体解码；去多余空行
  - **正文提取**（readability 启发式）：优先 `<article>/<main>` 容器（语义即正文），其次 id/class 含 content|main|post|article|body 的 div，否则整页——导航/页脚/侧栏大幅过滤；实测 react.dev 提取正文干净
  - **编码探测**：Content-Type header + HTML meta charset 检测，GBK/GB2312 按声明解码（原固定 UTF-8 中文老站乱码）；实测 163.com GBK 无乱码
  - **project_scan 增强**：框架识别扩充（Next/Nuxt/Astro/Tauri/Electron/NestJS/Fastify/Vite/Webpack/状态管理 + Python FastAPI/Django/Flask 从 requirements/pyproject 识别）
  - **工具能力整体审视结论**：read/write/edit/search_code（正则友好报错 v2.10 已加）/list_directory/git 链/glob/todo/ask_user/memory 均已达标；web_search（Bing RSS 修复）、webfetch（本次重写）为短板已补
  - 验证：真实页面实测（react.dev 正文提取 + 163.com GBK）+ npm test 866 项全绿
- ✅ **批 4 审批严厉度对齐主流（2026-08-14，用户「弹窗太多」）**：调研主流（Claude Code 默认模式/Codex/Gemini/opencode 共识 = 文件编辑自动执行、仅命令/网络/危险操作询问）→ **文件编辑与验证类工具降 low**（smart 档自动放行）：write_file / edit_file（沙箱写保护/只读容器/工作树隔离不变，安全不降级）、run_test、git_add / git_commit（本地提交，绝不 push）/ git_branch 创建切换；**保留弹窗**：run_command（每条命令，高危检测 high）、网络（high+requireExplicit 红线）、mcp_register/plugin_add（high 安全线）、memory_write（medium）。smart 档下弹窗大幅减少（写文件/测试/提交不再问）。npm test 865 项全绿（审批策略断言更新）
- ✅ **批 5 只读联网降 low（2026-08-14，用户「websearch/webfetch 不算高风险」）**：对齐 harness/主流（web_search/web_fetch 是普通工具无每次审批；bash 命令才是审批重点）→ **webfetch / web_search 降 low**（smart 档自动放行，不再每次弹窗；confirm 档仍确认）；**run_command 保持审批**（命令是真正危险面，主流一致），其中**外传命令联网（network=true）仍 requireExplicit 人工红线**不变。安全边界：只读拉取自动、命令/上传/注册仍受控。实测 web_search 返回真实结果（Bing RSS：新浪财经等）+ npm test 866 项全绿（web-tools 断言更新为自动放行）
- ✅ **批 6 剩余工具审批对齐 harness + 档位调研（2026-08-14）**：**browser-use 插件全降 low**（navigate 去联网审批、click/type/fill 去页面副作用审批——已授权使用浏览器，对齐主流不逐次弹窗）；**memory_write 降 low**（对齐主流 memory 自动；敏感凭据检测与全局写保护仍在）。**harness 审批档位调研结论**：harness **无「低/中/高」三级**——二元 ApprovalPolicy（ask/never）+ 三档沙箱模式（read-only/workspace-write/danger-full-access）+ 提权审批（bash 被拒后可带 sandbox_permissions+justification 请求提权一次）；映射关系：workspace-write+ask ≈ InFu smart（文件编辑自动、命令/提权询问）、never ≈ auto、danger-full-access+ask ≈ confirm；InFu 的 risk 分级 + 三档是更细的实现，语义已对齐。**当前保留审批**：run_command（命令，主流一致）、命令联网 network=true（人工红线）、mcp_register/plugin_add（自注册安全线，InFu 特有）。npm test 866 项全绿
- ✅ **批 7 图片视觉降级 + 附件审批确认（2026-08-14，用户「发图片会报错」）**：**根因**——图片走 AI SDK image content part 视觉，但 agnes 等端点不支持 image part（API 400/500 "Invalid user..."）→ 任务直接失败；计划中的「不支持视觉自动降级」未实现。**修复**：loop 模型调用段加降级重试——请求含图片且失败 → 图片 parts 替换为文本提示（「当前模型不支持图片输入，已自动转为文本提示」）→ 重试一次（仅一次）；实测事件流 session→text（降级提示）→done、无 error。**附件审批确认**：发送附件本身不弹审批（文件走 read_file low 自动、图片走视觉），只有 Agent 用命令处理附件时才走命令审批。npm test 866 项全绿
- ✅ **批 8 附件审批真相 + 白名单放行 + docx 自动提取（2026-08-14，用户「放附件也要审批」查证）**：
  - **查证结论**：附件本身不审批（read_file/use_skill 均 low 自动）；用户看到的审批 = Agent 用 **run_command 跑 python-docx 解析 .docx 附件**（二进制 read_file 读不了 → 命令审批弹窗）
  - **命令白名单 = 完全放行**（对齐 Claude Code allowedCommands）：白名单命中的命令跳过全部审批（含高危检测豁免——用户显式配置的信任）；联网放行仍人工红线
  - **docx 附件自动提取文本**（服务端暂存时零依赖 zip 解析 word/document.xml）→ 附件引用指向 .txt，Agent 直接 read_file，不再需要跑命令；原 docx 保留
  - 端到端实测：发送真实 docx → Agent 读取提取文本并正确概括（「张冬旭，大连民族大学物联网工程本科在校生…熟悉 Python 与嵌入式开发」）toolCount=1 无命令调用
  - npm test 866 项全绿
- ✅ **批 9 内置默认命令白名单（2026-08-14，用户「查主流白名单」）**：调研结论——主流均无预置白名单（Claude Code 靠内置只读命令自动放行启发式 / Codex 用沙箱 / harness 无白名单、approval 仅 ask/never + 沙箱升级）；社区共识加白 = 只读查询 + git 只读 + 版本查询。**实施**：新增 `DEFAULT_COMMAND_ALLOWLIST`（只读查询 ls/pwd/date/whoami/which/echo/df/du、git 只读 status/diff/log/show/branch/remote/ls-files/rev-parse/blame/stash/tag/check-ignore/config、版本查询 node/npm/pnpm/yarn/python/tsc/go/cargo/rustc/java、包本地查询 npm ls/pnpm ls/pip list/go list + npm run）——**用户配置与默认合并（默认项不可删）**；不放 cat/grep 读任意文件（防 root 外泄露）、不放写/网络/提交/代码执行（红线）；设置 UI 命令白名单区加内置默认说明。npm test 866 项全绿（approval-policy 断言更新）
- ⏳ **v2.11+ 已规划**见下节（子 Agent 控制工具/后台 job/usage 四桶/工具 schema 精简/session 查询/持久 shell/LSP/read_image——用户授权落档，触发条件已标注）

### v2.11 子智能体控制 + 后台任务（job）【✅ 2026-08-15，用户拍板跳过 bug 收尾直接推进】
- **子智能体控制（对齐 Claude Code SendMessage 恢复 + Agent View 仪表盘）**：
  - `delegate_task` 加 `background` 参数——后台模式：立即返回子智能体 id（不阻塞父级循环）；独立 AbortController（父级中止传播 + interrupt_agent 可单独中止）；per-session 活跃上限 6 对后台同样生效
  - 新工具：`list_agents`（low 只读，列状态：运行中/等待消息/完成/异常 + 模型/步数/委派任务）、`report`（low 回收结果，运行中返回进度、等待中提示恢复方式）、`send_message`（low，恢复等待中的子智能体）、`interrupt_agent`（low，中止一个或 all 全部）
  - 子智能体内部新工具 `agent_message`（暂停等待父级回复 → `agent-waiting` 事件 → 父级 `send_message` 恢复 → `agent-resumed` 事件；Claude Code SendMessage 语义；仅后台模式可用，同步委派调用返回错误防死锁）
  - 生命周期：父任务结束按**委派深度**自动中止本深度启动的后台子智能体（server/cli 任务 finally 挂点；子任务随父结束）
- **后台任务（job，harness jobs 同款）**：
  - `run_command` 加 `background` 参数——启动后立即返回 job id（不阻塞 Agent 循环）；审批（命令级）/断网门禁与同步完全一致
  - 新工具：`job_list`（low 只读）、`job_output`（low，环形缓冲 512KB 防爆内存，tail 只看末尾）、`job_kill`（low，杀进程树：Windows taskkill /F /T，POSIX 进程组）
  - 每会话活跃上限 8；`job-start`/`job-done` 事件（落库审计可重放）；审计标签 `soft-bg`
  - 安全边界（docs/SUBAGENTS.md 更新）：后台任务暂走**软沙箱语义**（L1.5 受限沙箱接口为同步无法后台化），命令审批/断网策略/审计不降级；后续可升级
  - 管理工具全部 low（管理 Agent 自有子任务，写能力已有委派授权背书）；list_agents/report/job_list/job_output 进 Planner/Reviewer 只读白名单 + READONLY_TOOLS
- 验证：npm test 全绿（新增 **subagent-control 24** + **jobs 19**）+ CLI 端到端实测（真实模型：后台 run_command → job_list/job_output/job_kill 全链 + 后台委派 explore → list_agents → report 回收）
- 📌 **bug 排查收尾阶段（2026-08-14 用户提出）暂缓落档**：用户 2026-08-15 拍板「先做 v2.11」——触发条件 = v2.11 完成后用户提出具体 bug/现象时再专项排查（无触发不主动做）

### v2.14 批 18 审批档位图标 + 设置有效性审计【✅ 2026-08-15，用户三点】
- **档位图标**：全自动 = **ShieldAlert（盾牌+感叹号）警告色**（警示全自动放行）；智能 = Scale（天平，**中性色**）；全部确认 = ShieldCheck（**中性色**）——只有警告场景用色
- **设置有效性审计**（explore 深扫 14 类设置项全链路）：12 项 ✅ 真实生效；修复 **2 个无效设置 + 1 个错位**：
  - **defaultModelId 死配置**：保存/落盘正常但 Web 会话从不读取（store 取 models[0]）→ App.tsx fetchConfig 应用 defaultModelId（setModels 校验存在性回退）——设置「默认模型」/星标现在真实生效
  - **子智能体 sandbox 档位死配置**：agent 文件 frontmatter sandbox 解析了但无运行时消费 → 全链路接线：shared ToolContext.sandboxMode → runAgent opts → ctx → run_command/run_test → execLocal(modeOverride 用 resolveEffectiveMode 解析) → subagent runSubagent/startBackgroundSubagent 传 agentDef.sandbox
  - **索引库面板作用域错位**：/api/index 固定操作启动目录 → 端点接受 root 参数（前端传当前项目 root）
- 验证：tsc/vite build + server 重启 + 浏览器实测（智能档 Scale 中性色图标 ✓）

### v2.14 批 17 双思考修复 + Hero 艺术字【✅ 2026-08-15，用户两点】
- **「两个正在思考」修复**：根因 = 发送时 ensureAssistant 预建空消息（streaming）→ phase-start 事件**无条件新开消息** → 两条空 streaming 消息都渲染「正在思考…」；修复 = phase-start 时最后一条 assistant 为空则**复用**（打 phase 标记），非空才新开。实测「正在思考」计数 = 1 ✓
- **Hero 欢迎界面**：去掉正方体 SVG 图标；「无限未来」改为**艺术字**——56px / font-extrabold / tracking-tight / **单色渐变**（`linear-gradient(180deg, text-primary → text-tertiary)` + background-clip:text——深色主题白→灰渐变、浅色主题黑→灰渐变，跟随主题）

### v2.14 批 16 任务清单条缩小居中【✅ 2026-08-15，用户「缩小 + 居中，避开终端按钮」】
- TodoPanel 折叠条 max-w 780 → **500**（缩小约 1/3，水平居中 mx-auto）——输入卡右上终端按钮的垂直带被左右留白避开，**不再重合**；文字仍 13px 可读，任务项清晰
- 验证：tsc/vite build ✓

### v2.14 批 15 侧栏滚动审查【✅ 2026-08-15，用户「任务太多能否滑动 + 区块头滑动机制」】
- **审查结论**：侧栏是**单滚动容器**（主体区 min-h-0 flex-1 overflow-y-auto）——任务再多都能滚（实测 9 会话可滚 174px，内容溢出即滚）
- **最优解（我的决断）**：不做嵌套滚动（项目/会话各自滚动区是"无法滑动"的常见根源——滚轮在子滚动区会卡死）；采用**单滚动容器 + 区块头 sticky 吸顶**（VS Code/Linear 同款）：SectionHeader 加 `sticky top-0 z-10 bg-sidebar/95 border-b backdrop-blur-sm`——滚动时「已顶置/项目/会话」区块头保持可见、内容从其下穿过，既有"区块头滑动机制"的观感又保证可靠性
- 验证：浏览器实测（滚动容器 scrollHeight>clientHeight ✓、scrollTop 可移动 ✓、sticky 区块头 2 个 ✓）

### v2.14 批 14 定位浮标动态化【✅ 2026-08-15，用户「当前第几段浮标就定位到第几个」】
- 左侧定位浮标增加**活跃态**：滚动时计算「视口上部 40% 内的最后一条用户消息」= 当前段落 → 对应浮标**延长（w-3.5 → w-8）+ 变色（line → info 蓝 + 微光阴影）**；其余浮标保持普通态（hover 才变长变色）
- 消息变化（新回复/重放）后自动重新定位；滚动（onScroll）实时跟随
- 验证：浏览器实测（2 轮对话 → 活跃浮标 28px 延长 + info 蓝，普通 12.25px ✓）

### v2.14 批 13 寒暄规则移除 + 右侧栏细节【✅ 2026-08-15，用户「去掉寒暄规则对齐主流 + Tab 大写」】
- **prompt 移除寒暄判断规则（对齐主流 Agent）**：DEFAULT_SYSTEM_PROMPT / PLANNER_SYSTEM_PROMPT 删除「消息类型判断」第 0 条——主流（Claude Code/Codex）prompt 均无此规则，模型天然处理（纯寒暄简短回复、带任务的问候直接干活）；规则化判断本身脆弱（时好时坏根因）。orchestrator 代码层寒暄短路保留（Planner 不调工具自然结束）。实测：纯「嗨」简短回复 ✓；「你好啊+任务」统计 3700+ 文件 ✓
- **右侧栏**：空态面板「打开 tab」→「打开 **Tab**」（大写 T，两处）；折叠 rail 展开按钮从 PanelRightOpen 图标 → **粗体「Tab」文字**（bold 15px）

### v2.14 批 12 工作树按钮上消息 + 编辑仅最近消息【✅ 2026-08-15，用户两点】
- **工作树按钮移到 AI 消息**：原输入框上方胶囊按钮 + 下拉面板整体移除——按钮改为**只出现在「最近一次修改文件的 assistant 消息」的操作行**（write/edit 工具判定），复制按钮同款圆形图标（GitBranch + 绿色脉冲点），**点击直接并入主分支**（无面板无确认，成功/失败 toast）；"取消消失机制"——不再有面板/消息状态的消失逻辑
- **编辑按钮仅最近用户消息**：✏️ 编辑按钮只在**最后一条用户消息**的操作行显示（其他历史用户消息不显示编辑）
- 验证：tsc/vite build + 浏览器实测（编辑按钮唯一 ✓ / 工作树按钮逻辑条件验证——需真实 git 仓库才出现）

### v2.14 批 11 ZCode 款编辑 + 回滚交互重构【✅ 2026-08-15，用户「查证 ZCode 编辑机制 + 回滚双按钮」】
- **查证（联网）**：Claude Code 无"原地编辑"——`/rewind` + Restore conversation 把早期 prompt 恢复进输入框编辑重发；**模型无状态**，harness 每轮重建上下文 → 截断后旧消息/旧回答不再进入上下文 → **AI 自然忘记**（与用户主观体验一致）
- **回滚重构**：待定态输入框上方显示**「确认回滚」「取消回滚」双大胶囊按钮**（≈两倍终端按钮宽；确认=info 蓝主按钮）；**去掉"写消息+发送才回滚"机制**——确认按钮直接截断（本地同步截断 + AI 感知标记 + 3s toast）；回滚待定时输入内容再发送 = 自动先回滚再发（快捷组合）
- **ZCode 款编辑**：用户消息 ✏️ → 编辑态（输入框填原文 + 「确认编辑/取消编辑」按钮）；**确认 = rewind(marker:false 无标记) + 本地截断 + 重发**——旧消息与 AI 回答消失、显示新消息、AI 重新思考；取消 = 退出编辑态；切会话自动退出编辑态
- **rewind marker 选项**：store.rewind(id, seq, {marker})——回滚 true（落 rewind 事件 → AI 感知），编辑 false（静默截断，AI 无需被告知）
- 待回滚小标签主题化（text-warn → text-sub）

### v2.14 批 10 回滚/编辑分离 + UI 精修【✅ 2026-08-15，用户「回滚≠编辑 + 按钮样式」】
- **回滚与编辑分离**（用户澄清概念）：回滚**不再预填原文编辑**（askRewind 去掉 fillText）——回滚 = 撤回重来，直接输入新消息发送；取消回滚只取消待定态（不动输入框）
- **编辑按钮（ZCode 款）**：用户消息操作行新增 Pencil 铅笔按钮——填入输入框修改后重发，**历史保留**（普通发送，与回滚无耦合）
- **AI 感知回滚**：新增 `rewind` 事件类型（回滚截断时落库 {to, at}）→ rebuildMessages 注入 system 消息「对话历史曾在 seq N 处被回滚截断…」——AI 明确知道已回滚及位置（实测：marker 落库 + system 注入 + 旧内容不出现 ✓）
- **回滚完成 toast**：提交后输入框上方悬浮提示「已回滚——之前的对话已截断，AI 将从这里继续」，3 秒自动消失，主题样式
- **UI 精修**：取消回滚按钮 = 终端按钮同款（border-line bg-elevated/90 text-text hover:bg-hover）+ 图标换 **X**；回滚提示条主题化（bg-elevated/80 border-line text-sub，原 warn 黄）

### v2.14 批 9 寒暄修复落地 Web + 回滚 UI【✅ 2026-08-15，用户三点】
- **Web 端寒暄误判根因**：批 4 改了 DEFAULT_SYSTEM_PROMPT 但**常驻 server 进程不热重载**（tsx 运行中不加载新模块）——CLI 新进程生效、Web 旧进程失效 → 重启 server 后 Web 实测"你好啊+任务"调用工具执行 ✓
- **回滚机制查证**（用户问"是不是撤回消息 AI 不记得"——**正是**）：`store.rewind` = `DELETE FROM events WHERE seq >= 锚点`（该消息及之后全部事件物理删除）→ 重发时 rebuildMessages 从截断后事件流重建 → **AI 上下文完全不含被删内容**（比"编辑替换"更彻底：这条消息从未存在过）
- **取消回滚按钮**：从顶部提示条文字按钮 → **输入框上方图标按钮**（终端按钮同款：absolute -top-8 胶囊、warn 色 ↺、仅 pendingRollback 时显示）；顶部提示条保留信息（"待回滚 N 条消息"）去掉按钮

### v2.14 批 8 右侧直角【✅ 2026-08-15，用户「右侧不要大 R 角，与右侧栏融为一体」】
- 卡片圆角 `rounded-[20px]` → **`rounded-l-[20px]`**（仅左侧圆角：左上/左下 20px，右上/右下 0px 直角）——右侧与右侧栏平齐融合，圆角只保留在左侧（覆盖侧栏效果）
- 验证：浏览器实测（TL 20px / TR 0px / BL 20px / BR 0px ✓）

### v2.14 批 7 无缝贴齐【✅ 2026-08-15，用户「顶部不留缝 + 右侧一体分隔线在」】
- **顶部不留缝**：中间列 `p-2` → `pt-0`（卡片顶部贴窗口顶，hero/header 均贴齐）
- **右侧栏与聊天一体**：中间列 `pr-0`（卡片右缘无缝贴右侧栏）+ 右侧栏去掉 `border-l`——分隔线 = 卡片自身 1px 右边框（观感一体、线在）
- 代码模式覆盖层适配（top 40|0 / right 0）
- 验证：浏览器实测（卡片顶部 gap 0 ✓、卡片右缘与右侧栏 gap 0 ✓、右侧栏 border-left 0px ✓、卡片 border-right 1px ✓）

### v2.14 批 6 卡片一体化【✅ 2026-08-15，用户「header 与聊天一体 + 去侧栏竖线」】
- **header 融入聊天卡片**：顶部区域（会话名/推拉按钮）移进卡片容器（App.tsx 中间列 = p-2 外壳 → 卡片 div（rounded 20/border/bg-ink/shadow）→ header（h-10 border-b）+ ChatPanel）；ChatPanel 根去掉卡片壳（壳在外层）；中间列 gridRow "1 / span 2"
- **侧栏竖线移除**：Sidebar 两处 aside 去掉 `border-r border-line`——聊天卡片的边界线成为唯一分隔（卡片 1px border）
- **代码模式覆盖层适配**：left: sideW+8 / top: 48|8 / right: 8（卡片内全屏代码视图，保留卡片边框一体感）
- 验证：tsc/vite build + 浏览器实测（卡片 20px 圆角/1px 边框/阴影 ✓、ChatPanel 内部无壳 ✓、侧栏 border-right 0px + blur(40px) ✓）

### v2.14 批 5 布局视觉：聊天卡片 / 侧栏磨砂 / 右侧栏同色【✅ 2026-08-15，用户三点要求】
- **聊天界面 = 大圆角卡片**：中间列外留 8px 边距，ChatPanel 根改 `rounded-[20px] border border-line bg-ink shadow-lv2 overflow-hidden`——与左侧栏接壤处圆角透出底层（侧栏/光晕），卡片浮起覆盖感
- **侧栏磨砂玻璃**：Sidebar 两处 aside `bg-sidebar/70 backdrop-blur-2xl`（半透明 + 40px 背景模糊）；底层新增装饰光晕（`--glow-a/--glow-b` 深浅两套 token，radial-gradient 左上+右下）——光晕透出侧栏被 blur = 玻璃质感
- **右侧栏与聊天同色**：RightRail aside `bg-sidebar` → `bg-ink`（与聊天卡片一致）
- 踩坑：`bg-base` 无 `--color-base` token 映射（Tailwind 类无效，静默透明）——统一用 `bg-ink`（--color-ink 已映射且同值）
- 验证：tsc/vite build + 浏览器实测（main 圆角 20px/不透明背景/阴影 ✓、aside blur(40px)/70% 半透明 ✓、零 console 错误）

### v2.14 批 4 prompt 修复：寒暄误判 + Infu 身份【✅ 2026-08-15，用户反馈「你好啊+任务」被当寒暄】
- **根因**：DEFAULT_SYSTEM_PROMPT 第 0 条"用户消息不是开发任务（寒暄/问候…）时直接回复"——模型把**问候语开头 + 任务请求**（"你好啊，帮我看看项目有几个文件"）误判为纯寒暄直接跳过
- **修复**：prompt 重写（借鉴 harness persona 风格：身份极简 + 行为指引直接）——
  - 身份改为「你是 Infu（**In 和 F 大写**），一个直接、务实的 AI 助手」，去掉"软件工程智能体"定位（用户明确：Infu 就是 Infu）
  - 寒暄判断明确化：**包含任何任务请求（查看/统计/分析/修改/创建/搜索/运行/测试）时，即使以问候语开头也必须执行任务**；只有**纯粹寒暄**才直接回复
  - Planner 提示词同构修复
- 验证：真实模型「你好啊，帮我看看项目有几个文件」→ 执行任务（扫描/统计/分布说明）✓；纯「嗨」→ 0 工具直接回复 ✓
- 📌 用户偏好已记忆（infu-naming-and-persona）：I/F 大写、不称软件工程智能体

### v2.14 批 3 交互精修 2【✅ 2026-08-15，用户两点反馈】
- **hover 串扰修复**：消息容器 div 也是 `group`，CSS group-hover 匹配任意祖先 → 鼠标靠近时多行一起飘。改用**命名组** `group/row` + `group-hover/row:`（Tailwind v3.2+ 命名组，只匹配自身）
- **AI 中间文本独立成消息**（用户贴「全量 28 套件全绿…更新 ROADMAP」事例）：原一轮的文本全部合并到最后一条消息（和总结混在一起）；改为——**已有工具调用之后的文本自动开新消息**（appendText / loadSession 重放 / loadSessionCache / 子智能体线程四处同构），渲染顺序改为 **思考 → 文本 → 工具**（模型先说话再调工具，中间文本穿插在工具调用之间，harness flow 语义）
- 验证：tsc + 浏览器实时任务实测（中间文本出现在 read_file 工具行之前 ✓）

### v2.14 批 2 对话流交互精修【✅ 2026-08-15，用户四点反馈】
- **思考行交互**：展开态标题行**摘要消失**（只剩图标 + 标题，全文从下一行开始；原展开/折叠都显示一行摘要）；hover 从"整行选中背景"改为**漂浮放大感**（微上浮 -translate-y-px + scale 1.01 + shadow-lv2 + 图标变蓝）
- **diff 统计修复**：read_file 等只读工具**不再显示 diff 数字**（原正则 `[+-]\d+` 把 read 结果的行号范围 "-152" 误匹配成假 diff）；仅写工具（edit_file）显示真实 +N -M，**加绿减红**（原全绿）；write_file 新建无 diff 不显示
- **消息流间距**：移除 turn 内 -mb-2.5 收紧 → 工具行/思考/文本各自独立成块（harness flow item 统一 16px 节奏）
- **去掉 `>` 箭头**：思考行/工具行的 ChevronRight 移除（对齐 harness DisclosureRow 无箭头；展开交互保留整行点击）
- 验证：web tsc/vite build + 浏览器实时任务实测（箭头 0 / read_file 行干净 / 三工具行平铺 / 零 console 错误）

### v2.14 对话流对齐 harness 最终版【✅ 2026-08-15，用户「再借鉴 harness，样式一模一样」】
- **结构：步骤卡片 → per-tool 平铺**（最大差异修复）：Timeline 重构——每个工具调用 = 独立一行（harness ToolCallTree 同构），去掉 StepCard 步骤分组卡片；与文本/思考/用户气泡统一 16px 节奏平铺
- **工具行细节对齐**：图标映射补齐（36 工具全覆盖：glob/web/git 全家/memory/todo/ask_user/use_skill/session/job/子 Agent 控制/mcp/plugin）；运行中 = 图标 + 扫光（去 spinner）；失败 = 红点替换图标（StateDot）；成功无标记；**risk 徽标移除**（对齐 harness 干净感）；摘要改关键键优先（command/path/query/pattern…，harness SUMMARY_KEYS 语义）
- **文件路径链接**（harness fileLink）：read/write/edit/read_files 工具行摘要 = 可点击路径（下划线蓝）→ 打开代码界面自动展开目录定位文件（store codeViewFile 外部定位 + CodeView 消费；span 非 button 防嵌套非法 HTML）
- **已对齐确认不动**：用户气泡（525/r22/浅蓝#EDF3FE·深灰#2C2C2E）、操作行（28px 圆钮/时间 hover/clock start/end/日期感知/运行时长）、思考行（24px/最新行跟随/扫光/22px 缩进）、运行状态行（shimmer 蓝渐变文字 + 等宽时钟）、错误行（红点+标题+消息）、代码块（r12/语言条/copy）、markdown 标题层级、回到底部
- **保留的 InFu 特色（用户拍板项）**：字号 15/25（用户 8-14 拍板缩小一档，harness 16/28）、思考标题中文「思考」（harness "Think"）、turn 内连续流（-mb-2.5 收紧）、状态行文案「InFu 运行中」（harness "Deep diving..."）
- 验证：web tsc/vite build + 浏览器实时任务实测（read_file/run_command/glob 三工具行平铺渲染 + 关键键摘要 + diff 统计 + 零 console 错误；修复 button 嵌套 hydration 警告）

### v2.13 逻辑错误与 bug 排查收尾【✅ 2026-08-15，双探索排查 + 29 项确认修复】
- **安全/漏洞类（高危）**：
  - **命令白名单组合符绕过**（`git status && rm -rf x` 命中白名单整体免审批）→ 白名单命中再校验组合符（&&/;/|/>/</`/$()），含组合符退回正常审批；白名单收窄：`git branch*` → 只读列表（-a/-r/-l/--show-current）、`git config*` → `--get/--list`（写 ~/.gitconfig 走审批）
  - **路径 startsWith 前缀漏洞**（`../work2\evil.txt` 与 root 同前缀兄弟目录越界）→ 统一 `isPathInside`（根 + 分隔符边界 + win32 大小写折叠），替换全部文件工具与 /api/fs /api/review 端点
  - **git_diff file 参数命令注入**（反引号/$() 在双引号内执行，low 免审批）→ 安全字符白名单硬校验
  - **webfetch SSRF**（127.0.0.1/169.254.169.254 内网与云元数据探测）→ `isPrivateTarget`（IP 字面 + DNS 解析后检查私网/回环/链路本地/CGNAT/ULA；测试用 INFU_ALLOW_PRIVATE_URL 豁免）
  - **glob 反斜杠/绝对路径逃逸**（`..\..\Users`、`C:\...`）→ 统一相对路径校验
- **审批一致类**：git_commit 声明 high → low（v2.10 已降，声明残留）、edit_file medium → low、**git_add 补 guard**（confirm 档不再静默放行）
- **状态/生命周期类**：用户停止后会话被 done 覆盖 → updateStatus stopped 终态保护（可被新任务 running 覆盖）；同会话双发 TOCTOU → 检查通过立即置 running；重复调用守卫 Map 移出循环（跨轮累计复活）；图片降级误触发（任何错误都触发 + 历史图片被永久剥离）→ 仅错误含视觉特征时降级 + 只处理末尾 user 消息 + 重试前重置累加器；后台委派绕过 6 上限 → slots 检查；后台任务清理全深度（子 Agent 内部启动的 job 随父任务结束）；jobs spawn 失败双触发 + 状态错标；后台子 Agent waiters 中止竞态卡死；附件早退路径残留
- **前端状态路由（并行/队列/会话核心）**：finally/catch 用本连接 connSid（finishAssistantFor/addErrorFor——跨会话清 running/写错会话修复）；abortController 单例 → per-session Map（并行 stop 失效修复）；计划按会话存（后台会话挂起不被误清）；todos/usage 按会话（后台不覆盖视图 + 切换回填）；重放跳过被接管会话 + 后台会话只写缓存（loadSessionCache 不污染全局）；队列消费 root 用会话自身（续跑不传 root 服务端用存储值）；队列失败插回队首；agent-waiting/resumed 前端处理（线程等待提示）；停止反馈服务端落库（重放保留）；Sidebar 切换 loadSession forceView
- 验证：npm test 全绿（新增 **bugfix 回归套件 33 项**：组合符/收窄/路径边界/SSRF/stopped 保护）+ e2e 实测（组合符命令走审批、glob 越界拒绝）+ web tsc/vite build
- 📌 排查方法：双 explore agent 并行深扫（前端 store/事件路由 + 后端安全/生命周期），输出 29 项确认 bug（15 后端 + 14 前端），按安全 > 状态 > 一致性分批修复

### v2.12 工具精简 / usage 四桶 / 会话查询【✅ 2026-08-15】
- **工具 schema 精简（Token 成本杠杆）**：新增 `compactJsonSchema`（loop 组装 tools 时对全部工具参数 JSON Schema 递归裁剪——删冗余元字段 $schema/title/default/examples/additionalProperties/definitions、description 截断 150、enum 截断 12、属性数上限 20、嵌套深度 >5 折叠；纯裁剪不影响工具执行——执行端直接读 args）；工具 description 截断 800（内置工具手写描述普遍 <800 无感，MCP 超长被裁）。实测全内置工具 schema **12146 → 8891 字符（-27%）**；MCP 大 schema（30+ 属性/超长描述）收益更显著
- **usage 四桶（对齐 harness usage-projection）**：chat.ts 末尾 chunk 解析加 `promptTokens/completionTokens`（uncached=miss / output=completion / cacheRead=hit / cacheWrite 暂无 API 数据）；shared done.usage 扩展四字段；loop/orchestrator 聚合链路贯通；**StatsLine 升级**——「缓存命中 X%（读 N · 未命中 M）· 输出 N tokens」（无缓存数据的端点保持前缀估算兜底）；ContextMeter 占用率环已存在（v3 时落地）
- **session 查询工具（Agent 复盘/复用）**：`session_search`（low 只读，关键词匹配标题/根目录 + 最近会话列表，返回 id/标题/时间/状态/事件数）+ `session_trace`（low 只读，指定会话的关键事件轨迹摘要——用户消息/文本/工具调用与结果/错误/计划/子智能体/完成，limit 尾部截取）；进 Planner/Reviewer 只读白名单；store 访问可注入（测试防污染真实库）
- 验证：npm test 全绿（新增 **v212 套件 16 项**：裁剪边界/全工具可裁剪/四桶解析/session 工具）+ 端到端实测（真实模型：session_search 搜出历史会话 → session_trace 复盘 937 事件会话的 80 条关键轨迹）
- ⏳ ~~**剩余 🟢 低优先级**：持久 bash shell、LSP 工具、read_image（vision 底座，触发条件 = 桌面化或接入视觉模型时）~~（**后已完成**：v3.0 批 11 持久 shell / LSP / 记忆剪枝、批 10 read_image + visionQueue）

### v2.12+ 已规划（2026-08-15 更新：v2.12 三项 🟡 全部完成；剩余全为低优先级/触发条件项）
- 🟢 **低 · 持久 bash shell**（跨调用保留 cwd/env，harness bash-persistent 同款）；**LSP 工具**；**read_image**（vision 底座——触发条件：桌面化或接入视觉模型时）
- ✅ **usage 四桶 / 工具 schema 精简 / session 查询工具**已随 v2.12 完成（上方）；🔴 子 Agent 控制 / 后台 job 已随 v2.11 完成

## 低优先级 / 远期（可做可不做）

- ⏳ **v3 团队/公司版 InFu（触发条件已定义，2026-08-12）**：Agent 跑在云端服务器 + 云端沙箱 + 多租户隔离/认证授权。**触发条件 = 出现第二个真实用户或明确的团队使用场景**——在那之前不做（v2 聚焦单机个人化深耕）。**若落地，microVM 随本项一并触发**（多租户 = 不可信代码场景，ROADMAP 已定义）；届时网络隔离在可控环境（云服务器）下随 microVM 一并解决。v3 立项时再讨论具体形态
- ⏳ WSL2 原生沙箱（bubblewrap/Landlock）作为 L3 备选
- ✅ **子智能体增强（恢复子智能体 / 后台模式）**已由 v2.11 覆盖（2026-08-15：delegate_task background 后台模式 + send_message 恢复等待中的子智能体 + list_agents/report/interrupt_agent + agent_message 内部通道，对齐 Claude Code SendMessage 与 Agent View）

---

## 已完成（历史）

- ✅ M1：monorepo + 任意模型接入 + 10 工具 + Agent 循环 + CLI + 服务层
- ✅ M2：Web 三栏 UI + SSE 流式 + 停止按钮 + 审批队列
- ✅ M3：沙箱 L1（软沙箱）+ L2（Docker 容器）+ 交付报告 + 模型管理 UI
- ✅ 修复：审批队列、停止链路、端口冲突、错误信息透出、maxSteps 30 + 进度总结
- ✅ git worktree 任务工作树（Cursor /worktree 借鉴）：每任务独立分支 + 工作树，任务后手动合并/丢弃，主代码零污染
- ✅ M4：模板任务引导（一键初始化项目/修复测试失败/分析项目/添加功能，Web 空态欢迎面板 + CLI --template）+ Planner/Reviewer 分层编排（Planner 只读规划→计划确认→Executor 执行→Reviewer 只读审查→汇总；Web 可编辑计划卡片，CLI --orchestrate/--no-plan-approval；三档模式选择器与 `--no-orchestrate` 已随 v2.6.5 移除——默认单一循环直接执行，编排显式开启）
- ✅ M5：沙箱中期升级（L1.5 Windows 硬沙箱：restricted tokens + job objects，Rust 原生模块 + 降级阶梯 + 自测；/best-of-n 已随 v2.5 移除——同任务多路竞速判定多余，真并发 = delegate tasks 不同任务并行）
- ✅ **v2.1 持久化与会话（2026-08-12）**：SQLite 会话库 `~/.infu/infu.db`（node:sqlite 零依赖，Node ≥22.5）+ 全量事件流落库（tool-result 存完整输出，Diff 面板升级为完整 diff）+ 会话 API（列表/详情/删除/Rewind）+ Web 左侧栏会话列表（新建/切换/删除/状态徽标）+ 继续会话（历史回顾注入，消息级重建留 v2.2）+ 消息轮次内嵌「回滚到此」（两段式确认，检查点 = user-message/step-start）+ CLI `infu sessions`/`--session <id>` + v1 localStorage 数据一次性迁移 + 配置 zod schema 基础（version 字段/损坏备份/未知字段保留，v2.4 权限/沙箱设置的地基）。验证：`npm test` 86 项全绿 + CLI/Web 端到端实测（真实模型建会话/继续/回滚）
- ✅ **v2.2 批 1 可靠性核心（2026-08-13）**：见上「v2.2 模型适配与可靠性」节（自动重试/降级链/消息级重建/断点恢复，`npm test` 138 项全绿 + CLI 端到端实测）
