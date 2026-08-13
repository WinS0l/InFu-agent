# InFu 插件系统 v1 + 钩子 + skill（v2.3 批 2）

> 版本：v2.3 批 2 ｜ 日期：2026-08-13 ｜ 依据：ROADMAP v2.3「插件系统架构 v1（插件 = 可注册工具/命令/技能/钩子的包）+ 钩子系统（PreToolUse/PostToolUse）+ skill 加载机制（SKILL.md 社区标准兼容）」

## 一、设计来源

批 1 的 MCP 适配器是「外部进程工具」的第一个实例；批 2 从它反推出**插件协议**，并补上同进程能力通道与知识通道：

| 通道 | 形态 | 安全模型 |
|---|---|---|
| MCP 服务器（批 1） | 外部进程（stdio/http），工具经协议注入 | 配置即信任 + 工具默认 medium 审批 |
| **JS 插件（批 2）** | 同进程模块（opencode 式），可注册工具/钩子/技能 | 代码在 Agent 进程内运行（配置即信任）+ 工具默认 medium 审批 |
| **钩子（批 2）** | 插件内 JS 函数（preToolUse/postToolUse） | 抛错不阻塞（emit 错误后放行） |
| **skill（批 2）** | SKILL.md 社区标准（agentskills.io） | 只读知识注入（描述常驻 + use_skill 读全文） |

## 二、插件协议（PluginDef）

JS/TS 模块默认导出（`~/.infu/plugins/<name>/` 或任意路径，config `plugins[]` 引用）：

```ts
export default {
  id: "my-tools",              // 必填，唯一
  name: "我的工具",            // 必填
  description: "…",            // 必填
  tools: [                     // 或 () => ToolDef[]（延迟生成，便于引用运行时资源）
    { name: "hello", description: "打招呼", schema: z.object({...}), risk: "low",
      execute: async (args, ctx) => "hi" },
  ],
  hooks: {                     // 插件级钩子，对所有工具生效
    preToolUse: async ({tool, args, risk, phase}) => ({ decision: "allow", args }),
    postToolUse: async ({tool, args, result}) => ({ result }),
  },
  skills: ["C:/path/to/skill-dir"],  // 附加 skill 目录（SKILL.md）
};
```

- 工具 `risk` 缺失默认 **medium**（审批兜底，防注入投毒）；跨插件重名自动加插件 id 前缀
- 加载失败（坏导出/import 抛错）→ emit 提示后**跳过，不阻塞任务**
- 只注入 **Executor 阶段与直接模式**（Planner/Reviewer 架构级只读不暴露；suggestOnly 不加载）

## 三、钩子协议（函数式）

| 事件 | 时机 | 返回 | 语义 |
|---|---|---|---|
| `preToolUse` | tool-start 事件后、execute 前 | `{decision: "allow", args?}` 或 `{decision: "block", reason?}` | block → 不执行，返回「用户拒绝：reason」给模型；args 可改写 |
| `postToolUse` | execute 后 | `{result?}` | 改写回填模型的工具结果文本 |

- 对**所有工具生效**（含 MCP 工具、内置工具）——挂在统一执行段
- 钩子抛错：emit 错误事件 + 放行（不阻塞主流程）
- 输入：`{tool, args, callId?, risk, phase?}`（phase = planner/executor/reviewer，直接模式无）

## 四、skill 加载（SKILL.md 社区标准）

**progressive disclosure 三级**（agentskills.io 官方规范）：

1. **发现层**：任务开始时把全部 skill 的 `name + description` 追加到 Executor system prompt（约 100 token/个）——模型知道有哪些技能、何时用
2. **激活层**：任务匹配描述时调用内置工具 **`use_skill <name>`**（low risk，只读）读取 SKILL.md 全文
3. **执行层**：按需 `read_file` 读 `references/` `scripts/` `assets/`（use_skill 返回中提示相对路径）

目录约定（生态标准）：`SKILL.md` 必须大写、位于 skill 目录根、frontmatter `name` 必填（与目录名一致，不一致以目录名为准）且 `description` 必填；非法 skill 跳过并提示。

发现顺序：**config `skills[]` 显式引用 > `~/.infu/skills/`（用户级）> `<root>/.infu/skills/`（项目级）**；同名高优先级胜出。

## 五、命令与 API

```bash
npm run infu -- plugin add <id> --path <模块路径>   # 添加插件（交互向导）
npm run infu -- plugin list / remove <id> / status [id]  # 列表/删除/探测（工具+钩子数）
npm run infu -- skill add <name> [--path <目录>]    # 添加技能引用
npm run infu -- skill list / remove <name>          # 列表（用户/项目/显式）/移除引用
```

API：`/api/plugins` CRUD + `POST /api/plugins/:id/probe`；`/api/skills` list/add/delete。Web 管理 UI 并入 v2.4 设置界面（本批 CLI + API）。

**自注册闭环**：内置工具 `plugin_add`（high + requireExplicit 审批，-y 不放行；白名单只写 `plugins` 节）——Agent 可自主「编写插件 → 注册给 InFu 自己用」（与 `mcp_register` 同模式）。

## 四·五、技能自编写闭环（Agent 给自己写技能）

skill 走**文件系统即注册**——比 MCP/插件更顺，不需要注册环节：

```
Agent：write_file 写 <root>/.infu/skills/<name>/SKILL.md（工具边界内）
  → 下一任务自动发现（项目级扫描，描述注入 system）
  → 模型 use_skill 读取全文并按其执行
```

- 写保护已精确化（v2.3 批 2）：项目内 `.infu/` 放开写（技能目录是合法场景）；用户级 `~/.infu/`（全局配置/凭据/日志）仍受保护——**Agent 只能写项目级技能，用户级技能是你的资产**
- 实测（2026-08-13）：Agent 自主编写 review-checklist 技能（审查清单）→ 下一任务自动发现 → use_skill 读取 → 按清单真实执行代码审查

## 六、安全边界

- ⚠️ **插件代码在 Agent 进程内任意执行**——比 MCP 服务器信任级别更高（MCP 是子进程，插件是同进程）。**配置插件 = 完全信任该代码**；防线是工具层默认 medium 审批 + 你只添加信任来源的插件
- 插件无法修改配置自身（`plugin_add` 只写 `plugins` 节；models/providers/roles/apiKey 不可达）
- 钩子可拦截任意工具（含审批后的）——设计如此（安全策略钩子），信任模型同上
- skill 是纯只读知识（SKILL.md 内容会进模型上下文——不信任的 skill 描述可能诱导 Agent 行为，use_skill 读取前模型已见描述，注意来源）

## 七、验证

- `npm test` 全绿（新增 tests/plugin.test.ts 61 项：加载器/钩子链/skill 解析/config schema/API/工具层）
- 端到端实测：示例插件（注册工具 + preToolUse 拦截钩子）→ CLI 添加 → 任务中工具调用 + 钩子生效；SKILL.md 放入项目 → 任务中模型 use_skill 读取执行
