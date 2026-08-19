# InFu 子智能体（v2.5）— opencode 式委派：独立上下文 / 真并发 / 结果回收

> 版本：v2.5 ｜ 日期：2026-08-13 ｜ 依据：ROADMAP v2.5「子智能体（opencode 式）：委派、独立上下文、并行执行、结果回收；agent 文件化定义」＋用户评审返工（对齐 ZCode/opencode/Claude Code）

## 一、这是什么

Executor 里的 Agent 面对复杂任务时可以**拆分子任务委派给子智能体**：子智能体以**全新独立上下文**再跑一个 Agent 循环（复用 `runAgent`），完成后把结果摘要回收给父级。**同轮可并行派发多个子智能体**（不同任务同时跑，最多 6 个），与 ZCode「同一消息多个工具调用并发运行」一致。

**一句话：模型调用 `delegate_task` 工具 → 一个（或 tasks 并行多个不同任务）子智能体独立干活 → 结果回收。角色由内置定义（general-purpose / explore）或 `.infu/agents/<name>.md` 文件定义。**

## 二、架构

```
父 Agent（Executor，独立上下文 A）
   │  调用 delegate_task { prompt / agent / tasks[] / tools / root / maxSteps / modelId }
   │  · 同一消息多个 delegate_task = 并行执行（loop 3.2 段 Promise.all，结果按序回填）
   ▼
delegateTasks()（src/agent/subagent.ts）
   │  · 解析角色（内置 general-purpose/explore > agent 文件 frontmatter + 正文）
   │  · 解析子模型（modelId 显式 > agent 文件 model > 继承父级模型 + 父降级链）
   │  · 工具：缺省 = 全部内置工具（对齐 ZCode general-purpose）；白名单可收窄
   │  · root 越界检查 · 深度限制（子智能体不可再委派）
   ▼
runAgent() 子循环（独立上下文 B/C/...，tasks[] = Promise.all 并行）
   │  · 事件带 subagentId 标全量落库（审计）· 内部权限按 agent 文件 permission 档位
   ▼
subagent-done 事件（完整摘要）+ 结果文本回填父级
   · Web：主对话流显示子智能体条目（可点击）→ 右侧栏弹窗 = 完整消息流
     （思考/文本/工具过程与父 Agent 一致，对齐 opencode/Claude Code）
```

## 三、内置 agent（对齐 ZCode）

| 名称 | 工具 | 说明 |
|---|---|---|
| `general-purpose` | **全部内置工具**（缺省） | 通用子智能体：写能力委派需一次授权审批；批准后内部自主执行 |
| `explore` | 只读 20 件（read_file / search_code / list_directory / project_scan / git_status / git_diff / use_skill + project_tree / os_info / current_time + list_agents / report / job_list / job_output / wait_task + code_symbols / lsp_definition / lsp_references / lsp_completion / ocr_image） | 只读探索：**委派免审批**（对齐 ZCode Explore 随便调） |

## 四、agent 文件化定义（文件系统即注册）

```
~/.infu/agents/<name>.md          # 用户级（同名胜出）
<root>/.infu/agents/<name>.md     # 项目级
```

```markdown
---
description: 只读审查代码质量，不修改文件（必填，发现层摘要）
tools: read_file, search_code, list_directory, project_scan, git_status, git_diff, use_skill
model: deepseek-v4                 # 可选：子模型 id（缺省继承父级）
maxSteps: 12                       # 可选：子循环步数上限（缺省 12）
thinkingLevel: 3                   # 可选：1-4，覆盖全局/父级
permission: allow                  # 可选：allow=继承委派授权内部不逐个问（默认）；ask=内部仍逐条审批
sandbox: restricted                # 可选：off / soft / restricted（缺省跟随全局设置）
---
正文 = 角色系统提示词（建议末尾约定输出格式与字数上限）
```

**设置面板「Agent 能力 → 子智能体」**：可视化创建/编辑/删除（工具多选、权限、沙箱、模型、推理强度、角色提示词）；内置两个不可编辑。

## 五、delegate_task 工具

| 参数 | 说明 |
|---|---|
| `prompt` | 委派的子任务指令（与 tasks 互斥） |
| `tasks[]` | **并行批量**（不同任务同时跑；每元素同构，最多 6 个；Promise.all + 结果合并） |
| `agent` | 角色名（内置 general-purpose/explore 或 `.infu/agents/<name>.md`） |
| `tools` | 工具白名单（缺省 = 全部内置工具） |
| `root` | 子工作目录（相对项目根；越界拒绝） |
| `maxSteps` | 子循环步数上限（1-50，缺省 12） |
| `modelId` | 子模型 id（缺省继承父级模型 + 父降级链） |
| `background` | **后台模式（v2.11）**：true 时立即返回子智能体 id（不阻塞父级循环），子 Agent 在注册表异步运行 |

**审批（v2.5 返工，对齐 ZCode）**：
- **只读委派免审批**（explore / 白名单全只读）——读文件搜索不打断
- **写能力委派一次授权审批**（high；描述含工具范围）——批准后内部自主执行
- 内部工具调用继承委派授权（不再逐个弹）；**requireExplicit（联网放行等安全红线）任何情况逐条询问**
- agent 文件 `permission: ask` 可要求内部工具仍逐条走父级审批

## 五·五、后台模式与控制工具（v2.11，对齐 Claude Code SendMessage 恢复 + Agent View）

- **`delegate_task background=true`**：立即返回 `sub-xxx` id，父级继续自己的任务；子 Agent 独立 AbortController（父级中止传播 + interrupt_agent 单独中止）；per-session 活跃上限 6 对后台同样生效
- 控制工具（全部 low，Agent 管理自有子任务）：
  - `list_agents` — 列出当前会话后台子智能体：id/名称/状态（运行中/等待消息/完成/异常）/模型/步数/委派任务
  - `report(agent_id)` — 回收结果：运行中返回进度；**等待消息时提示恢复方式**；已完成返回最终摘要
  - `send_message(agent_id, message)` — 恢复等待中的子智能体（其任务继续）
  - `interrupt_agent(agent_id | all=true)` — 中止一个或全部
- **子智能体内部 `agent_message`**（Claude Code SendMessage 语义）：子 Agent 需要父级决策时调用 → 暂停等待（`agent-waiting` 事件）→ 父级 `send_message` 恢复（`agent-resumed` 事件）→ 继续。**仅后台模式可用**（同步委派调用返回错误——防父级同步等待死锁）
- **生命周期**：父任务结束 → 按委派深度自动中止本深度启动的后台子智能体（子任务随父结束；server/cli 任务 finally 挂点）；已完成/异常的不再中止（report 仍可回收）

## 六、并发（真并发 = 不同任务并行）

- **同轮多个 delegate_task 并行执行**（loop 工具执行段 Promise.all，对齐 ZCode「同一消息多个工具调用并发运行」）；父级可一次派发多个子任务同时跑
- `tasks[]` 数组 = 显式并行批量（上限 6）；`ctx.callId` 按调用隔离（并行不串扰）
- 停止 = 共享 abortSignal 全停（后台子 Agent 独立 controller 跟随父级）；并行写文件冲突由 worktree 隔离兜底（建议并行用于读/分析或不同 root）

## 七、展示（v2.5 返工，对齐 opencode / Claude Code）

- **主对话流**：只显示子智能体**条目**（一行：名称 + 状态 + 委派任务摘要），不内嵌卡片/过程
- **右侧栏详情弹窗**：点击条目打开——子智能体**完整消息流**（思考/文本/工具过程，与父 Agent 一致，实时流式更新）+ 最终摘要
- 子智能体内部过程事件带 subagentId 全量落库（会话重放可恢复详情弹窗）

## 八、摘要与上下文

- **父 Agent 完整接收摘要**（不物理截断）：子智能体 system 注入输出约定（结构化摘要：结论/关键发现/建议，**总字数 ≤ 2000 字**），超限 20K 才兜底截断
- 子循环独立上下文；内部事件不进入父上下文（防上下文爆炸）

## 九、安全边界（已知限制，v1）

| 边界 | 说明 |
|---|---|
| 深度限制 | `MAX_DELEGATION_DEPTH = 1`：子智能体**不可再委派**（防递归失控） |
| 架构级排除 | `delegate_task`/`mcp_register`/`plugin_add` 白名单写明也**拒绝注入**（防提权投毒） |
| root 越界 | `root` 参数只能指向父级 root 内（相对/绝对路径均检查） |
| 审批 | 只读委派免审批；写能力委派一次授权；requireExplicit 安全红线始终逐条；tool-start/tool-result 全量落库 = 审计 |
| 工具范围 | v1 只注入**内置工具**；MCP/插件工具不注入子智能体 |
| 沙箱 | agent 文件 `sandbox` 档位解析/展示（执行层接入随沙箱体系后续完善） |
| 结果截断 | 摘要字数约束（2000 字约定）+ 20K 兜底（防失控） |

## 十、验证

- `npm test`：subagent 套件 94 项（agent 解析/内置 agent/只读免审批/写能力一次授权/并行执行/级联停止/深度/越界/rebuild 跳过）全绿，总计 643 项
- CLI 端到端：真实模型委派任务（agent 文件角色生效/子智能体执行/结果回收）
- Web 端到端：设置面板创建/编辑子智能体 + 主对话流条目 + 右侧栏详情弹窗（消息流/摘要）
