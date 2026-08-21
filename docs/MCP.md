# InFu MCP 客户端（v2.3 批 1）— 扩展机制的第一个插件类型

> 版本：v2.3 批 1（v3.8 修订同步） ｜ 日期：2026-08-13 ｜ 依据：ROADMAP v2.3「MCP 客户端作为第一个插件类型（`infu mcp add <server>`，工具动态注入 Agent 循环，审批/审计覆盖）」

## 一、这是什么

MCP（Model Context Protocol）是 AI 工具生态的事实标准——社区有大量现成 MCP 服务器（文件系统、数据库、浏览器、GitHub、文档处理等）。InFu v2.3 落地 **MCP 客户端**：配置一台 MCP 服务器后，它的工具自动注入 Agent 执行阶段，与内置 52 工具并列可用。这是插件系统架构 v1 的**第一个实例**（批 2 再反推抽象插件协议）。

**一句话：`infu mcp add <名称>` → 任务执行阶段自动多出该服务器的全部工具。**

## 二、架构

```
用户配置（~/.infu/config.json mcpServers[]）
        │
        ▼
loadMcpTools()（src/mcp/index.ts）——只连接 enabled 的服务器；失败的跳过不阻塞任务
        │  connectMcp()（src/mcp/client.ts）
        │    stdio（本地子进程 spawn）/ http（Streamable HTTP 远程端点）
        ▼
listTools() → 每个 MCP 工具 → ToolDef 适配器（src/mcp/tools.ts）
        │    · schema：JSON Schema → zod（src/mcp/schema.ts，覆盖常用子集，未知回退 z.any）
        │    · risk：riskOverrides 精确 > 前缀* > 默认 medium
        ▼
注入 Agent 循环（仅 Executor 阶段与直接模式）
        │  · Planner/Reviewer 不注入（架构级只读保证不被破坏）
        ▼
调用时：审批（默认 medium，人工确认）→ callTool 转发 → 结果文本化回模型
        · tool-start / tool-result 事件全量落库 = 审计（会话回放即审计）
        ▼
任务结束：close() 关闭所有连接（防残留子进程）
```

## 三、命令（CLI）

```bash
npm run infu -- mcp add <名称>                  # 交互式添加（stdio/http）
npm run infu -- mcp add filesystem --type stdio --command npx.cmd --args "-y,@modelcontextprotocol/server-filesystem"
npm run infu -- mcp list                       # 列出服务器
npm run infu -- mcp remove <id>                # 删除
npm run infu -- mcp status [id]                # 探测连接 + 工具列表 + 风险级别
```

Web UI：设置弹窗 → 「Agent 能力 → MCP 服务器」Tab（添加/启停/探测工具/风险覆盖/删除），与 CLI 操作同一份配置。

## 四、风险策略（防 prompt 注入投毒）

MCP 工具没有原生风险概念，且**可读写任意文件、执行任意命令**——是 prompt 注入的潜在载体。策略：

| 优先级 | 规则 | 说明 |
|---|---|---|
| 1 | `riskOverrides` 工具名精确匹配 | 如 `"write_file": "high"` |
| 2 | `riskOverrides` 前缀通配（`key*`） | 如 `"read*": "low"`（命中 read_file/read_directory） |
| 3 | 默认 `medium` | **所有未覆盖的 MCP 工具每次调用需人工审批**（-y 自动批准也弹——medium 不走 requireExplicit，但 CLI 交互默认询问；Web 弹审批框） |

- 审批/审计复用现有通道：`approval-required`/`approval-result` 事件 + `tool-start`/`tool-result` 全量落库（会话回放 = 完整审计轨迹）
- **建议**：只把确定只读的工具（如 filesystem 的读取类）降为 low；写类工具保持审批

## 五、安全边界（已知限制，v1）

- ⚠️ **MCP 服务器子进程不受 L1.5 沙箱约束**——它是独立进程，InFu 的受限令牌/Job 管不到。**配置 MCP 服务器 = 信任该服务器**（与用户自己跑的程序同等信任级别）。防线是工具调用层的默认审批 + 只注入你配置的来源
- MCP 工具结果会进模型上下文——**不信任的服务器返回的内容可能诱导 Agent 调用危险工具**；medium 审批兜底此风险
- 命令审计 `commands.log` 是 `run_command` 专用；MCP 工具走事件流审计（不写 commands.log）
- `env` 字段可给服务器进程注入环境变量（如 API Key）——随 config.json 存储（0600 本地），勿放生产级密钥
- Windows 注意：stdio 的 `command` 用 npx 时需写 **`npx.cmd`**（Node spawn 不解析 .cmd）；或用完整 `node` 路径 + 脚本参数

## 六、阶段级精确续跑（v2.2 遗留，v2.3 落地）

继续会话（`--session <id>` / Web 带 sessionId）时从事件流推断续跑起点：

| 历史状态 | 续跑行为 |
|---|---|
| 尾部阶段 = planner/executor 且有计划事件 | **跳过规划阶段**，直接从 Executor 续跑（计划沿用上次确认的；不重跑 Planner 省 token、计划不被改写） |
| 仅 planner 且无计划 | 从头（重新规划） |
| 尾部 = reviewer | 从头（只读阶段中断重跑成本低，v1 不做 reviewer 起点） |
| 直接模式（无 phase-start） | 不受影响 |

## 六·五、自注册闭环：Agent 给自己写 MCP

**Agent 可以自主完成「编写 MCP server → 注册给 InFu 自己用」的完整闭环**，通过受控注册工具和审批完成。

```
Agent：read_file 参考示例 → write_file 编写 server → （可选 run_test 自测）
  → 调用 mcp_register（high 级 + requireExplicit 审批，-y 也不放行）
  → 注册成功 → 下一任务执行阶段自动注入该服务器工具
```

- **工具**：`mcp_register`（第 7 个内置工具——read_file/write_file/edit_file/search_code/list_directory/run_command 之后；仅 Executor/直接模式可用）
- **白名单边界**：只允许追加 `mcpServers` 节；`models/providers/roles/apiKey` 等其余配置字段不可达——Agent 无法自我提权（改自己的模型/凭据/角色）
- **审批**：high + requireExplicit（与联网放行同级特权），审批描述展示完整注册内容（command/args/url/riskOverrides）
- **闭环实测（2026-08-13）**：真实任务中 Agent 自主编写 `self-mcp-server.mjs`（get_time 工具，参考项目内示例）→ 调用 mcp_register 注册 `my-time`（high 审批批准）→ 下一任务自动注入并成功调用 `get_time`
- 注册信息与 CLI/API 同一份配置（`~/.infu/config.json`），Web 弹窗可见可删

## 七、配置示例（~/.infu/config.json）

```jsonc
{
  "version": 2,
  "providers": [/* ... */],
  "models": [/* ... */],
  "mcpServers": [
    {
      "id": "filesystem",
      "name": "文件系统",
      "type": "stdio",
      "command": "npx.cmd",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\workspace"],
      "riskOverrides": { "read*": "low", "write_file": "high" }
    },
    {
      "id": "remote-git",
      "name": "远程 Git 工具",
      "type": "http",
      "url": "https://mcp.example.com/git",
      "enabled": false
    }
  ]
}
```

## 八、验证

- `npm test` 全绿（新增 tests/mcp.test.ts 72 项：schema 转换 / 风险解析 / 适配器审批 / 加载合并去重 / config schema / API CRUD+探测 / 续跑推断）
- CLI 端到端：真实 stdio MCP 服务器（greet/add_note）——工具注入、`infu mcp status` 探测（风险徽标）、任务中模型调用、medium 审批拒绝（返回拒绝文本给模型）与批准（文件落盘）、事件落库可回放
- Web 端到端：MCP 管理弹窗（添加/启停/探测工具+风险徽标/删除）+ 任务中「MCP 服务器已连接」事件 + 模型调用 greet → 审批弹窗批准 → 回复回填与交付报告
