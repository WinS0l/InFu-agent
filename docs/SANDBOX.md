# InFu 沙箱设计（Sandbox Design）

> 版本：v0.1 ｜ 2026-08-12 ｜ 依据：2026 年公开资料调研（Tembo / Northflank / Qovery / Zylos / Wiz / Pillar Security / DEF CON 34）

## 一、调研结论（2026 共识）

1. **共享内核容器隔离（Docker/runc）不足以隔离不可信 AI 生成代码**（NIST SP 800-190）——Docker 只用于"可信内部代码"层。
2. 隔离强度分级：Docker（共享内核）→ gVisor（用户态 syscall 拦截）→ Firecracker/Kata 微VM（硬件隔离）。**按信任度匹配**。
3. 主流产品做法：
   - **OpenAI Codex**：云端容器沙箱，**默认断网**，每任务独立沙箱、用后销毁。
   - **Claude Code**：本机执行，可选 `--docker` / macOS Seatbelt。
   - Windows 生态已收敛到 **Docker Desktop + WSL2**；微软 MXC（Build 2026）为新原生方案。
4. 2026 年已知教训（InFu 必须吸收）：
   - **GhostApproval**（Wiz）：symlink 伪装 → 写 `~/.ssh/authorized_keys` → RCE；审批 UI 隐藏真实路径（CWE-451）。
   - **Pillar Security**：沙箱逃逸（写出的配置被宿主工具以用户权限执行）——"沙箱只是建议"（DEF CON 34）。
   - **凭据泄露**：沙箱内读取 `/proc/self/environ` 可得宿主环境变量。
5. 最佳实践清单：资源上限、**网络默认拒绝出站**、仅工作区可写、根只读、**凭据不进沙箱**、任务后销毁、最小权限 + 人工审批、完整审计、纵深防御（prompt 注入/MCP 投毒与执行隔离同等重要）。

## 二、InFu 沙箱分级设计（渐进增强）

| 级别 | 名称 | 隔离手段 | 依赖 | 默认 |
|---|---|---|---|---|
| L0 | 本机受限执行 | 审批 + 危险命令拦截 + 路径越界防护 | 无 | 兜底（Docker 不可用时） |
| **L1** | **本机软沙箱** | 环境变量消毒 + 敏感路径写保护 + 命令审计 + 工作区约束 + 超时 | 无 | 默认（受限沙箱不可用时） |
| **L1.5** | **Windows 硬沙箱** | 受限令牌（restricted tokens）+ Job Object：OS 级强制写不了系统目录/提不了权/资源上限 | Rust 原生模块（已随包构建） | win32 自动启用 |
| L2 | Docker 沙箱 | 容器执行：默认断网、只读挂载或工作区副本、任务后销毁、凭据不进容器 | Docker Desktop | 检测到 Docker 自动启用 |
| L3 | 内核级/微VM（未来） | WSL2 Landlock / MXC / Firecracker | WSL2 更新 / 云端 | 预留 |

**模式选择**：`auto`（默认）——检测到 Docker 用 L2；win32 无 Docker 时用 L1.5 受限沙箱（原生不可用则退回 L1）；可强制 `sandbox=off|soft|docker`。`INFU_SANDBOX_RESTRICTED=0` 可禁用 L1.5（故障排查）。

## 三、L1 软沙箱实现（默认，零依赖）

在现有工具系统上叠加：

1. **环境变量消毒**（run_command）：执行命令时剔除敏感变量（`*KEY*`、`*TOKEN*`、`*SECRET*`、`*PASSWORD*`、`*CREDENTIAL*`），防止命令/子进程读取宿主凭据（防 `/proc/self/environ` 类泄露）。
2. **敏感路径写保护**（write_file / edit_file / run_command）：
   - 写保护清单：`~/.ssh/**`、`~/.infu/**`、`~/.aws/**`、`~/.gnupg/**`、`%APPDATA%` 下凭据文件等。
   - 命中 → 拦截并说明原因（升级为审批也不放行——写敏感路径没有合法场景）。
3. **命令审计**：每次命令执行写入 `~/.infu/logs/commands.log`（时间、命令、cwd、退出码、输出摘要、沙箱档位）——与 agent.log 互补。
4. **危险命令拦截**（已有，保留）：`rm -rf`、`format`、`mkfs`、`dd if=` 等 → high 审批。
5. **工作区约束**（已有）：cwd 必须在项目根内；路径越界拒绝。
6. **超时**（已有）：命令默认 60s。

## 三·五、L1.5 Windows 硬沙箱（restricted tokens + job objects）✅

> 实现于 M5（2026-08-12），借鉴 OpenAI Codex windows-sandbox-rs（`packages/sandbox-rs/`，Rust N-API 原生模块）。
> 目标（ROADMAP 完成标准）：run_command 在 Windows 上以受限权限执行——**危险命令即使绕过应用层检查也无法造成系统级破坏**（OS 级强制，而非仅应用层检查）。

### 机制

| 层 | 手段 | 效果 |
|---|---|---|
| 受限令牌 | `CreateRestrictedToken`：`DISABLE_MAX_PRIVILEGE \| LUA_TOKEN \| WRITE_RESTRICTED \| DISALLOW_VIRTUALIZATION` | 全部特权禁用（仅保留 SeChangeNotify）；Administrators 组 SID 变 deny-only（写系统目录被 OS 拒绝）；禁止 UAC 虚拟化（防 VirtualStore 绕过） |
| 进程创建 | `CreateProcessWithTokenW`（1314 时回退 `CreateProcessAsUserW`）；命令写入临时 .cmd 文件执行；`CREATE_SUSPENDED` → 挂 Job → resume（出生即入 Job，无竞态窗口） | 标准用户/管理员均可运行；无命令行长度与引号限制 |
| Job Object | `KILL_ON_JOB_CLOSE \| ACTIVE_PROCESS(256) \| PROCESS_MEMORY(4GB) \| JOB_MEMORY(8GB)` | 防 fork bomb / 内存炸弹；超时 `TerminateJobObject` 杀整树，不留孤儿 |
| 输出捕获 | 匿名管道 + 读线程（8MB 上限）；stdin 接 NUL | 与 Node exec 语义一致，防写满死锁 |
| 输出解码 | 先按 UTF-8 严格解码（Node/tsx 等外部程序），失败回退 GBK（cmd 内置命令按代码页 936） | 中文输出在两种来源下均正确，无乱码 |

### 降级阶梯（透明降级，不静默）

`full`（完整标志）→ `reduced`（去 WRITE_RESTRICTED）→ `basic`（去 LUA_TOKEN）→ `job-only`（受限令牌创建失败，仅 Job Object 约束）。每级在 commands.log 与工具输出中标注实际档位。

### 与 L1 的分工（安全边界）

- **OS 级强制**：写系统目录/提权/资源炸弹——L1.5 负责（受限令牌 + Job）。
- **应用层**：敏感文件（~/.ssh 等）的**读**隔离——仍由 L1 负责（restricted token 不改变用户 SID 的文件读权限，Codex 同样依赖应用层保护路径）。
- **网络**：OS 级按进程断网在本机实测不可行（加固环境，见三·六）——命令级断网策略（外传拦截 + network 审批）由 M6 负责；容器级断网用 Docker L2。
- **不降完整性级别**：低 IL 会挡住工作区正常写入，破坏 Agent 本职（Codex 亦不降 IL）。

### 红队对照

| 攻击 | L1.5 防御 |
|---|---|
| `rm -rf C:\Windows` 绕过审批 | 受限令牌下 Administrators deny-only → OS 拒绝（Access Denied） |
| 写 Program Files 被 VirtualStore 重定向 | DISALLOW_VIRTUALIZATION → 真实 ACL 检查 → 拒绝 |
| fork bomb / 内存炸弹 | Job：ActiveProcessLimit 256 / ProcessMemory 4GB |
| 超时后孤儿进程 | KILL_ON_JOB_CLOSE + TerminateJobObject |
| 提权（SeDebug 注入等） | 特权全禁用（DISABLE_MAX_PRIVILEGE） |
| 嵌套 Job 环境（CI/任务计划程序） | 挂载失败仅警告不阻断（令牌限制仍生效，照抄 Codex 姿态） |

## 三·六、网络出站软控制策略（M6 收尾版）✅

> 实现于 M6（2026-08-12）。**本机实测 OS 级按进程断网全部路线不可行**（见下表），
> M6 落地为应用层命令策略：外传命令默认拦截（断网语义），`network=true` 经人工审批放行。

### 为什么收尾为软控制（本机实测结论）

| OS 级路线 | 结果 | 决定性证据 |
|---|---|---|
| 专用沙箱账号（Codex elevated 模式） | ❌ | LSA 特权数据库被本机加固策略删除 `SeImpersonate`/`SeAssignPrimaryToken`/`SeIncreaseQuota`，`LsaAddAccountRights` 返回"特权不存在"（0xC0000060=STATUS_NO_SUCH_PRIVILEGE），**无法补授**；他人令牌 WithTokenW/AsUserW 均 1314 |
| 当前用户 AppContainer 低盒（无网络能力=出站全断） | ❌ | 低盒令牌 + `CreateProcessWithTokenW` = 1314（实测）；AsUserW 需缺失的 SeAssignPrimaryToken |
| SYSTEM 提权辅助任务 | ❌ | SYSTEM 持有全部特权，但非提权触发被任务 DACL 拒绝；本机 schtasks `/SD` 被改为 startdate、TaskScheduler COM 校验拒绝 `LogonType=ServiceAccount`、事件触发器只认真实事件信道——**所有触发变通被硬化封死** |
| WFP 防火墙（ALE_USER_ID 按进程/用户规则） | ❌ | 引擎拒绝全部 12 种值编码（Windows 11 25H2 build 26200） |
| Docker L2 容器断网（`--network none`） | ⚠️ 机器未装 Docker | 安装 Docker Desktop 后 `INFU_SANDBOX=docker` 即得容器级断网（L2 已有实现，见第四章） |

> 结论：非代码缺陷，是**环境限制**（加固策略 + 未装 Docker）。若未来落地云版/多租户（microVM 触发），
> 网络隔离在可控环境（云服务器）下随 microVM 一并解决。

### 机制（应用层命令策略，`net-policy.ts`）

- **外传工具整词检测**：`curl / wget / nc / ncat / netcat / telnet / sftp / scp / ftp / rsync / ssh / socat / aria2c / axel`（排除 `ssh-keygen` 等变体前缀）；语言组合模式：`powershell Invoke-WebRequest/Net.WebClient/...`、`python urllib/requests/socket/...`、`node http/net/ws...`、`openssl s_client`。
- **默认断网语义**：`run_command`/`run_test` 命中外传意图 → 命令**不执行**，提示"断网策略拦截，确需联网请用 network=true 经人工审批放行"；审计写入 `sandbox=egress-blocked`。
- **联网放行**：`network=true` → 必须人工审批（🌐 标记，`-y` 自动批准也不放行）→ 通过则正常执行并标注"（联网放行）"，拒绝则仍拦截。
- **与沙箱本体叠加**：拦截发生在外传工具执行前；放行的命令仍走 L1.5 受限令牌 + Job（OS 级）。

### 局限（如实标注）

- **可被绕过**（变体/编码/白名单外的外传通道）——属风险降低措施，**不是内核强制断网**。
- OS 级强制断网的正确姿势：Docker L2（`INFU_SANDBOX=docker`，`--network none`）或未来云版 microVM。

## 四、L2 Docker 沙箱实现（检测到 Docker 时启用）

```
Agent 要执行命令
  → 检测 docker 可用（docker info，缓存结果，5s 超时）
  → 构建容器运行：
      docker run --rm -i \
        --network none \              # 默认断网（防数据外泄）
        --memory 2g --cpus 2 \        # 资源上限
        --user 1000:1000 \            # 非 root
        -v <项目>:<容器内项目路径>:ro  # 项目只读挂载（保护宿主）
        -w <容器内项目路径> \
        <镜像> sh -c "<命令>"
  → 镜像按技术栈选择：node:22 / python:3.12 / golang:1.24 / rust:1.85
  → 任务后容器自动销毁（--rm），沙箱永不复用
```

- **凭据不进容器**：不传任何环境变量；API Key 只存在于宿主 Agent 进程。
- **断网兜底**：需要网络的命令（npm install）默认被拒绝，提示用户手动在宿主执行，或后续白名单模式。
- **Windows 支持**：依赖 Docker Desktop（WSL2 后端），`docker run` 挂载 Windows 路径自动转换。

## 五、审批与审计（纵深防御）

| 层 | 机制 |
|---|---|
| 审批 UI | 展示**解析后的真实绝对路径**（防 CWE-451），队列化处理 |
| 审计 | agent.log（全事件）+ commands.log（命令级）+ diff 记录 |
| 凭据 | 模型配置在宿主（~/.infu/config.json，0600），沙箱内无凭据 |
| 红队清单 | fork bomb（--pids-limit）、root FS 写入（只读挂载）、出站（--network none）、环境变量读取（消毒） |

## 七、前沿智能体沙箱方案对比（2026 深入调研）

| 产品 | 默认沙箱 | 技术实现 | 网络策略 | 强隔离档 |
|---|---|---|---|---|
| **OpenAI Codex**（CLI） | 每命令沙箱化 | 平台原语：macOS Seatbelt / Linux Landlock→**Bubblewrap+seccomp**（0.115 起）/ Windows **restricted tokens + job objects** | 默认断网（seccomp 屏蔽网络 syscall / --unshare-net + 代理） | 云沙箱（每任务独立容器） |
| **Claude Code** | 原生 OS 沙箱 | macOS Seatbelt / Linux **bubblewrap + Landlock**（~1-3% CPU，~1ms 启动，零依赖） | 可配 | **Docker microVM**（独立内核，Docker Desktop 4.58+） |
| **Cursor** | 本地 OS 级 | Landlock/seccomp（少 40% 权限打断） | 出站范围化 | **云 VM + /worktree**（每任务独立工作树，/best-of-n 并行） |
| **Devin/Cognition** | 云端 | 每任务独立云沙箱 | 默认受限 | — |

**关键设计细节（Codex 官方文档）**：
- 沙箱模式分级：`ReadOnly`（全只读+断网）→ `WorkspaceWrite`（工作区可写+默认断网，`network_access` 可选开启）→ `DangerFullAccess`。
- **保护路径始终只读**：即使在工作区可写模式下，`.git`、`.codex`、`gitdir:` 目标也强制只读。
- 网络隔离用 seccomp 屏蔽 `connect/accept/sendto/sendmsg/...` 等 syscall，仅放行 AF_UNIX；bwrap 模式用 `--unshare-net` + 受管代理桥接。

**行业共识（2026）**：
- 隔离层级：**OS 进程沙箱（Seatbelt/Landlock/bubblewrap）< Docker/runc（共享内核）< gVisor < microVM（Firecracker）**。
- Docker 是"尴尬的中间地带"：比 OS 原语重、比 microVM 弱（2025 多个 runc CVE）。
- 推荐模式：**本地可信开发 → OS 原生原语**；**不可信/多租户 → microVM**。

**对 InFu 的启示（Windows 平台）**：
1. 前沿产品几乎都首选 **OS 原生原语**而非 Docker——轻量、快、零依赖。我们的 L1 方向正确，且借鉴点明确：
   - ✅ 已实现：借鉴 Codex 的"保护路径始终只读"（我们已做：~/.ssh、~/.infu 等，可扩展 .git、凭据文件）
   - ✅ 已实现：借鉴 Codex Windows 方案：**restricted tokens + job objects**（M5，Rust 原生模块 `packages/sandbox-rs/`，见"三·五"节）
   - ⏳ 网络默认断：受限令牌不拦网络，是 L1.5 最大真实缺口（防 prompt 注入外传）——**命令级断网策略已落地**（M6：外传命令 curl/wget/nc/ssh 等默认拦截 + `network=true` 人工审批 + egress-blocked 审计；OS 级进程断网受本机加固环境限制不可行，见 ROADMAP「网络出站软控制」）；OS 级断网的正确姿势 = Docker L2 `--network none` 或未来 microVM
2. Docker 定位为"可选增强"档（对应 Claude 的 Docker microVM 档）——我们的 L2 设计方向一致。
3. ✅ 已实现：借鉴 Cursor 的 **/worktree 模式**（M4）；**/best-of-n 并行尝试（M5）已于 v2.5 按用户评审整体移除**（同任务多路竞速多余，真并发 = delegate_task 不同任务并行）。

## 六、参考资料

- Tembo — AI Agent Sandbox: Secure Execution: https://www.tembo.io/blog/ai-agent-sandbox
- Northflank — How to sandbox AI agents in 2026: https://northflank.com/blog/how-to-sandbox-ai-agents
- Qovery — Claude Code sandbox guide: https://www.qovery.com/blog/claude-code-sandbox-guide
- Zylos Research — AI Agent Sandboxing: https://zylos.ai/research/2026-04-04-ai-agent-sandboxing-security-isolation
- awesome-ai-coding-sandboxes（安全姿态排名）: https://github.com/fhiltscher/awesome-ai-coding-sandboxes
- OpenAI Codex 沙箱架构（官方文档）: https://github.com/openai/codex/blob/main/docs/sandbox.md ｜ https://learn.chatgpt.com/docs/agent-approvals-security
- simonw — Codex 沙箱逆向研究: https://github.com/simonw/research/blob/main/codex-sandbox-investigation/notes.md
- Anthropic — Making Claude Code more secure with sandboxing（2025.10）
- Wiz — GhostApproval: https://www.wiz.io/blog/ghost-approval-vulnerability-ai-coding-assistants
- Pillar Security — sandbox escape research（CVE-2026-48124）
- 社区实现：nono（WSL2 Landlock）、isol8、ccairgap、sandfence
