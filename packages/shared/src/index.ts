/**
 * @infu/shared — 共享类型定义（前后端 + Agent 单一来源）
 */

/** 模型供应商类型（InFu 支持任意大模型） */
export type ProviderKind =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "zhipu"      // 智谱 GLM（OpenAI 兼容端点）
  | "qwen"       // 通义千问（OpenAI 兼容端点）
  | "ollama"     // 本地模型
  | "custom";    // 任意 OpenAI 兼容端点

/**
 * 供应商凭据（v2 模型管理重构）：一份 API Key 挂多个模型。
 * providers[] 存凭据与端点，models[] 通过 providerId 引用。
 */
export interface ProviderConfig {
  /** 唯一标识（如 "deepseek"；custom 多端点时 "custom-1"） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 供应商类型（模板/默认端点/思考参数映射依据） */
  kind: ProviderKind;
  /** 自定义端点（custom 必需；其余缺省走默认端点） */
  baseURL?: string;
  /** 可选；为空时读环境变量 INFU_<KIND>_API_KEY */
  apiKey?: string;
}

/** 用户可配置的模型（v2：经 providerId 引用供应商凭据；存 ~/.infu/config.json，Key 只在 providers[]） */
export interface ModelConfig {
  id: string;
  name: string;
  /** 上游模型 ID（供应商端定义的模型标识，如 my-model） */
  model: string;
  /** v2：所属供应商 id（providers[]）；v1 旧配置迁移后必有 */
  providerId?: string;
  /** v1 遗留：内嵌供应商信息（未迁移的旧配置兼容读取；新配置勿用） */
  provider?: ProviderKind;
  /** v1 遗留：内嵌端点 */
  baseURL?: string;
  /** v1 遗留：内嵌 API Key（v2 起凭据只存 providers[]） */
  apiKey?: string;
  /** 上下文窗口大小（token，上下文压缩预算依据；缺省按 kind/模型名推断） */
  contextWindow?: number;
  /** 实际推理级别数（思考级别 4 档 UI 的映射依据；1=无思考；模板自动填可改） */
  thinkingLevels?: number;
  /**
   * 思考参数覆盖（小众/自定义模型专用）：每档级别对应的请求体参数，
   * 数组第 i 项 = 第 i 级注入的字段（null = 该级不注入）；长度与 thinkingLevels 对齐，
   * 缺省走供应商协议自动映射。示例：[{"thinking":{"type":"disabled"}},{"thinking":{"type":"enabled"}},null]
   */
  thinkingOverride?: Array<Record<string, unknown> | null>;
  /** 备用模型 id 列表（v2.2 降级链：主模型失败时依次切换；引用 config 中其他模型） */
  fallbackModelIds?: string[];
  /** 适配角色（v2.2 轻量模型选择：声明该模型可担任的角色；低于 config 级 roles 显式指定） */
  roles?: Array<"planner" | "executor" | "reviewer">;
}

/** 角色模型引用：模型 id，或 {model, thinkingLevel}（角色独立思考级别） */
export type RoleModelRef = string | { model: string; thinkingLevel?: number };

// ── v2.3 MCP 服务器（扩展机制：MCP 客户端作为第一个插件类型）──

/** MCP 服务器传输类型：stdio = 本地子进程；http = 远程 Streamable HTTP 端点 */
export type McpServerType = "stdio" | "http";

/**
 * MCP 服务器配置（v2.3：工具动态注入 Agent 循环）。
 * 安全：MCP 工具默认 medium 审批（防 prompt 注入投毒），riskOverrides 可按工具名/前缀覆盖。
 */
export interface McpServerConfig {
  /** 唯一标识（如 "filesystem"） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 传输类型：stdio（本地命令）/ http（远程端点） */
  type: McpServerType;
  /** stdio 模式：启动命令（如 "npx"；Windows 下 npx 需写 npx.cmd，或用完整 node 路径） */
  command?: string;
  /** stdio 模式：命令参数（如 ["-y", "@modelcontextprotocol/server-filesystem", "C:\\workspace"]） */
  args?: string[];
  /** http 模式：Streamable HTTP 端点 URL */
  url?: string;
  /** 传给 MCP 服务器进程的环境变量（可选；敏感值会随 config.json 存储，仅 0600 本地） */
  env?: Record<string, string>;
  /** 是否启用（默认 true；禁用时不连接不注入） */
  enabled?: boolean;
  /**
   * 风险覆盖：工具名（精确）或前缀 + "*"（通配）→ 风险级别；未命中默认 medium。
   * 示例：{"read*": "low", "write_file": "high"}
   */
  riskOverrides?: Record<string, RiskLevel>;
}

/** MCP 工具元信息（探测/展示用：Web 工具列表与风险徽标） */
export interface McpToolMeta {
  name: string;
  description: string;
  risk: RiskLevel;
}

// ── v2.3 批 2 插件系统架构 v1（从 MCP 适配器实例反推的插件协议）──

/**
 * 插件配置（config.plugins[]）：引用 JS/TS 插件模块（函数式）。
 * 插件 = 可注册 工具/钩子/技能 的包；MCP 服务器是插件协议的另一个实例（独立通道）。
 */
export interface PluginConfig {
  /** 唯一标识（如 "my-plugin"） */
  id: string;
  /** 插件模块路径（目录或文件；.ts/.mjs/.js；动态 import） */
  path: string;
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** v2.7 市场元数据：安装来源（如 "builtin" / 本地目录 / URL） */
  source?: string;
  /** v2.7 市场元数据：版本号 */
  version?: string;
}

/** 钩子输入（工具调用上下文；pre/postToolUse 通用） */
export interface ToolHookInput {
  tool: string;
  args: Record<string, unknown>;
  callId?: string;
  risk: RiskLevel;
  /** 编排阶段（直接模式无） */
  phase?: PhaseId;
}

/** PreToolUse 钩子结果：allow 放行（可改 args）/ block 拦截（reason 给模型） */
export interface PreToolUseResult {
  decision: "allow" | "block";
  reason?: string;
  args?: Record<string, unknown>;
}

/** PostToolUse 钩子结果：可改写返回给模型的工具结果文本 */
export interface PostToolUseResult {
  result?: string;
}

/** 钩子函数（插件内注册；抛错不阻塞主流程——emit 错误事件后放行） */
export type HookFn = (input: ToolHookInput) => Promise<PreToolUseResult | PostToolUseResult | void>;

/**
 * 插件定义（JS/TS 模块默认导出；函数式）。
 * tools 可为数组或函数（动态生成，便于引用 MCP 连接等运行时资源）。
 */
export interface PluginDef {
  id: string;
  name: string;
  description: string;
  version?: string;
  /** 注册的工具（ToolDef 数组或延迟生成函数）；工具 risk 缺失默认 medium */
  tools?: ToolDef[] | (() => ToolDef[]);
  /** 钩子（v2.3 批 2：preToolUse/postToolUse；插件级，对所有工具生效） */
  hooks?: {
    preToolUse?: HookFn;
    postToolUse?: HookFn;
  };
  /** 附加的 skill 目录（SKILL.md 所在目录的绝对路径列表） */
  skills?: string[];
}

/** SKILL.md 元信息（发现层：描述常驻 system；激活层：use_skill 读全文） */
export interface SkillMeta {
  name: string;
  description: string;
  /** SKILL.md 文件绝对路径 */
  path: string;
  /** 来源层级：用户级 > 项目级 > 显式引用 > 插件自带 > 内置（同名首个胜出） */
  level: "user" | "project" | "config" | "plugin" | "builtin";
}

/** skill 显式配置（config.skills[]：引用项目内或任意路径的 skill 目录） */
export interface SkillConfig {
  name: string;
  /** skill 目录路径（含 SKILL.md；缺省 = 按 name 在用户/项目级目录查找） */
  path?: string;
}

// ── v2.4 设置界面（权限等级 / 沙箱等级 / 常规 / 外观；全部可选节，passthrough 兼容）──

/**
 * 全局审批档位：
 * auto=非人工必需全自动放行；smart=低风险自动、中/高人工（默认）；confirm=全部人工；
 * full=完全信任（v3.5，对标 Codex --auto / harness danger-full-access）——所有审批
 * 自动放行（含联网/高危命令/自注册/写委派等安全红线），仅剩硬闸：工具被显式禁用、
 * 受保护路径/路径越界/SSRF/断网策略/INFU.md 路径作用域
 */
export type ApprovalMode = "auto" | "smart" | "confirm" | "full";

/** 工具级风险/禁用覆盖（工具名精确 或 前缀*通配；与 MCP riskOverrides 同模式） */
export interface ToolRiskOverride {
  /** 工具名（如 "run_command"）或前缀通配（如 "git*"） */
  tool: string;
  /** 覆盖为指定风险（缺省 = 保留工具声明） */
  risk?: RiskLevel;
  /** 禁用该工具（命中即拒绝执行；对全部工具含 MCP/插件生效） */
  disabled?: boolean;
}

/** 权限等级配置（v2.4：审批模式/按工具覆盖/命令白名单） */
export interface ApprovalPolicyConfig {
  /** 全局审批档位（缺省 smart） */
  mode?: ApprovalMode;
  /** 工具级覆盖列表（精确名 > 前缀* > 默认；按声明顺序，首个命中生效） */
  toolOverrides?: ToolRiskOverride[];
  /** 命令白名单（通配符 * 匹配任意字符序列；命中白名单的命令跳过高危命令审批；联网 requireExplicit 永不豁免） */
  commandAllowlist?: string[];
}

/** 沙箱等级配置（v2.4：取代 INFU_SANDBOX 环境变量；off/L1/L1.5/L2/自动） */
export interface SandboxConfig {
  /** auto=按可用性自动选择（docker → win 受限 → 软沙箱）；off=直连；soft=L1 纯软；restricted=L1.5 Windows 受限；docker=L2 容器 */
  mode?: "auto" | "off" | "soft" | "restricted" | "docker";
}

/** 常规设置（v2.4：Web 默认值；v3.5 扩展对标 ZCode 常规设置） */
export interface GeneralConfig {
  /** 默认项目根目录（Web 输入框初始值） */
  defaultRoot?: string;
  /** 集成终端默认 shell（v3.0 批 12，常规设置参考）：auto（优先 Git Bash，回退 cmd）/ cmd / powershell / bash；缺省 auto */
  terminalShell?: "auto" | "cmd" | "powershell" | "bash";
  /** 开机自启（v3.0 批 12：桌面版可选，默认关闭——用户主动开启才生效） */
  autoLaunch?: boolean;
  /** 任务通知（v3.5）：任务完成/失败/需要确认时发送桌面通知（Electron Notification；缺省 true） */
  taskNotifications?: boolean;
  /** 通知声音（v3.5）：通知开启时可单独关闭提示音（缺省 true） */
  notificationSound?: boolean;
  /** 关闭窗口时隐藏到托盘（v3.5，仅 Windows）：点关闭按钮/快捷键隐藏窗口，托盘「退出」才完全退出（缺省 false） */
  closeToTray?: boolean;
  /** 保持电脑运行（v3.5，桌面端全局生效）：阻止系统因空闲进入休眠，仍可手动睡眠/合盖休眠（缺省 false） */
  preventSleep?: boolean;
  /** 提问自动继续（v3.5）：Agent 提问（ask_user）5 分钟未回答自动继续；关闭则一直等待（缺省 false） */
  autoContinueQuestions?: boolean;
  /** 显示思考过程（v3.5）：消息流展示完整思考内容；关闭时每轮仍展示第一次思考（缺省 true） */
  showThinking?: boolean;
  /** 显示待办（v3.5）：消息流展示 Todo 工具卡片（缺省 true） */
  showTodos?: boolean;
  /** 任务完成自动提交（v3.5）：git 仓库中任务成功且有改动时自动 git add -A + commit（消息=任务摘要，绝不 push；缺省 false） */
  autoCommit?: boolean;
  /** 自动归档旧任务（v3.5）：定时扫描已完成、未置顶、最后更新早于保留期的会话自动归档（缺省 true） */
  autoArchive?: boolean;
  /** 归档保留时长（天，v3.5）：任务最后更新早于该时长才进入自动归档候选（缺省 7） */
  archiveRetentionDays?: number;
}

/** 外观设置（v2.4：Web 界面偏好，随配置持久化） */
export interface AppearanceConfig {
  /** 界面字号（缺省 sm） */
  fontSize?: "xs" | "sm" | "base";
  /** 流式输出光标动画（缺省 true） */
  streamCursor?: boolean;
  /** 主题（v2.8：深/浅，缺省 dark；桌面端标题栏 overlay 配色联动） */
  theme?: "light" | "dark";
}

/** 记忆设置（v2.7：记忆系统开关；v3.5 加自动提炼） */
export interface MemoryConfig {
  /** 任务结束自动沉淀项目历史（.infu/history/）开关；缺省 true */
  autoSediment?: boolean;
  /** 任务结束自动提炼记忆（v3.5，对标 Codex 会话后提炼）：轻量模型把任务摘要分类提炼为
   *  conventions/lessons/preferences 写入项目记忆；失败静默不影响交付；缺省 true */
  autoRefine?: boolean;
}

/** 浏览器设置（v2.7：browser-use 插件运行配置） */
export interface BrowserConfig {
  /** 无头模式（缺省 true：Agent 自动化用无头；false = 有头可见，调试用） */
  headless?: boolean;
  /** chromium 可执行文件路径；缺省自动探测（ms-playwright 缓存 / INFU_BROWSER_PATH） */
  executablePath?: string;
}

/** 全局配置（v2：providers[] 凭据 + models[] 引用；未知字段保留前向兼容） */
export interface InfuConfig {
  /** 配置 schema 版本（v2 = 供应商凭据两级结构） */
  version?: number;
  /** v2：供应商凭据列表（v1 配置自动迁移生成） */
  providers?: ProviderConfig[];
  models: ModelConfig[];
  defaultModelId?: string;
  /** 按角色指定模型（轻量模型选择：planner/executor/reviewer 可分别用不同模型与思考级别） */
  roles?: {
    planner?: RoleModelRef;
    executor?: RoleModelRef;
    reviewer?: RoleModelRef;
  };
  /** v2.3：MCP 服务器列表（工具动态注入 Agent 循环；默认 medium 审批，riskOverrides 可覆盖） */
  mcpServers?: McpServerConfig[];
  /** v2.3 批 2：JS/TS 插件列表（可注册工具/钩子/技能；配置即信任） */
  plugins?: PluginConfig[];
  /** v2.3 批 2：skill 显式引用（缺省按 name 在 ~/.infu/skills 与项目 .infu/skills 查找） */
  skills?: SkillConfig[];
  /** v2.4：权限等级设置（审批档位/工具覆盖/命令白名单） */
  approvalPolicy?: ApprovalPolicyConfig;
  /** v2.4：沙箱等级设置（取代 INFU_SANDBOX 环境变量） */
  sandbox?: SandboxConfig;
  /** v2.4：常规设置 */
  general?: GeneralConfig;
  /** v2.4：外观设置 */
  appearance?: AppearanceConfig;
  /** v2.7：浏览器设置（browser-use 插件运行配置） */
  browser?: BrowserConfig;
  /** v2.7：记忆设置（记忆系统开关） */
  memory?: MemoryConfig;
}

/** 风险级别（审批挂钩） */
export type RiskLevel = "low" | "medium" | "high";

/** 分层编排的阶段 */
export type PhaseId = "planner" | "executor" | "reviewer";

/**
 * Agent 过程事件（CLI 打印 / SSE 推送前端；v2.1 起全量落库 ~/.infu/infu.db）。
 * v2.5：过程事件（text/step/tool/审批/降级/压缩）可携带可选 `subagentId`——
 * 子智能体委派（delegate_task 内部事件打标，用于审计归属；UI 不再内嵌展示内部过程）。
 */
export type AgentEvent =
  | { type: "text"; text: string; subagentId?: string }
  | { type: "reasoning"; text: string; subagentId?: string }
  | { type: "step-start"; step: number; subagentId?: string }
  | { type: "phase-start"; phase: PhaseId; label: string; /** v2.2：该阶段实际使用的模型（角色路由后） */ model?: string; subagentId?: string }
  | { type: "tool-start"; tool: string; args: Record<string, unknown>; risk: RiskLevel; callId?: string; subagentId?: string }
  | { type: "tool-result"; tool: string; ok: boolean; summary: string; callId?: string; subagentId?: string }
  | { type: "approval-required"; id: string; description: string; risk: RiskLevel; subagentId?: string }
  | { type: "approval-result"; id: string; approved: boolean; subagentId?: string }
  | { type: "report"; content: string }
  | { type: "review"; content: string }
  | { type: "plan"; id: string; content: string }
  | { type: "done"; text: string; toolCount: number; steps: number; usage?: { cacheHit: number; cacheMiss: number; promptTokens: number; completionTokens: number } }
  | { type: "error"; message: string }
  // ── v2.2 模型可靠性新增 ──
  /** 模型降级切换（主模型失败 → 备用模型；Timeline 展示与审计） */
  | { type: "model-fallback"; from: string; to: string; reason: string; subagentId?: string }
  /** 上下文压缩（v2.2：历史超预算时摘要化，before/after 为估算 token；DB 事件流无损） */
  | { type: "context-compressed"; before: number; after: number; summary: string; subagentId?: string }
  // ── v3.2：断网/瞬时故障重试可见性（对齐 主流 ModelRetryItem）──
  /** 模型调用重试（429/5xx/网络/超时退避期间 emit；前端状态行显示倒计时，审计可查） */
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; message: string; subagentId?: string }
  // ── v3.0 UI 审查：统计页真实数据源 ──
  /** 单次模型调用（loop 每轮成功流式结束后 emit；子 Agent 自动带 subagentId 归属；
   *  统计页按天×模型聚合真实 token，替代 phase-start 阶段数占比近似；
   *  summary=true：上下文压缩的摘要调用（v3.4——此前压缩调用不计入统计，长会话用量被低估） */
  | { type: "model-call"; model: string; promptTokens: number; completionTokens: number; cacheHit?: number; cacheMiss?: number; subagentId?: string; summary?: boolean }
  // ── v2.5 子智能体委派新增 ──
  /** 子智能体启动（delegate_task 委派；parentCallId 关联父级委派工具调用的 callId；readOnly=只读委派免审批；background=v2.11 后台模式） */
  | { type: "subagent-start"; id: string; name: string; prompt: string; parentCallId?: string; model?: string; readOnly?: boolean; background?: boolean }
  /** 子智能体完成（结果回收：最终摘要文本/步数/工具次数） */
  | { type: "subagent-done"; id: string; text: string; steps: number; toolCount: number; ok: boolean }
  // ── v2.11 子智能体控制新增 ──
  /** 后台子智能体暂停等待父级消息（agent_message 工具；父级用 send_message 恢复） */
  | { type: "agent-waiting"; id: string; name: string; message: string }
  /** 后台子智能体被 send_message 恢复继续 */
  | { type: "agent-resumed"; id: string }
  // ── v2.11 后台任务（job）新增 ──
  /** 后台命令启动（run_command background=true；job 工具管理） */
  | { type: "job-start"; id: string; command: string }
  /** 后台命令结束（正常退出/失败/被杀） */
  | { type: "job-done"; id: string; code: number | null; ok: boolean }
  // ── v3.3 异步任务编排新增（对齐 ZCode <task-notification> 机制）──
  /** 后台任务完成通知（子智能体/job 结束时 emit；前端显示 EventRow 通知行，
   *  运行时注入父循环上下文（loop drain → user XML 消息），rebuild 同格式恢复——
   *  模型「实时感知等待的任务已完成」，自主决定回收结果或继续其他工作） */
  | {
      type: "task-notification";
      taskType: "subagent" | "job";
      taskId: string;
      /** 子智能体名 / job 命令（展示用） */
      name: string;
      /** completed=正常完成 / failed=失败或异常 / stopped=任务中止 / killed=被杀 */
      status: "completed" | "failed" | "stopped" | "killed";
      /** 完成摘要（子智能体=最终摘要；job=输出尾部+退出码） */
      summary: string;
      /** 结果输出文件（job 时可选；.infu-outputs 落盘路径） */
      outputFile?: string;
    }
  // ── v2.1 会话持久化新增 ──
  /** SSE 首帧：回传新会话 id（Web 端绑定 activeSessionId） */
  | { type: "session"; id: string }
  /** 用户消息（服务端落库/重放历史用；模型不消费） */
  | { type: "user-message"; text: string }
  // ── v2.6 记忆系统新增 ──
  /** 任务结束自动沉淀（项目历史归档；path 为归档文件，summary 为条目摘要） */
  | { type: "memory-sediment"; path: string; summary: string }
  // ── v2.6 收尾新增 ──
  /** Agent 向用户提问（ask_user 工具；id 回填答案入口 POST /api/ask/:id；Web 弹窗/CLI 输入） */
  | {
      type: "ask-user";
      id: string;
      question: string;
      /** v2.10：问题补充说明（弹窗展示） */
      description?: string;
      /** v2.10：多选（默认单选） */
      multiSelect?: boolean;
      /** v2.10：选项可结构化（label + desc + recommended）；旧事件为纯 string[] 兼容 */
      options?: Array<string | { label: string; desc?: string; recommended?: boolean }>;
      subagentId?: string;
    }
  // ── v3.1 附件新增 ──
  /** 用户附加的文件/文件夹/图片（落库供重放展示；图片字节不落库，仅当次请求内走视觉） */
  | { type: "attachments"; items: AttachmentMeta[] }
  // ── v2.10 任务清单新增 ──
  /** todo_write 任务清单快照（前端 Todo 面板展示；整体替换 last-write-wins） */
  | { type: "todo-write"; items: Array<{ text: string; status: "pending" | "in_progress" | "completed" }> }
  // ── v2.14 回滚标记新增 ──
  /** 历史回滚标记（rewind 截断后落库；rebuild 时注入 system 提示——AI 意识到已回滚并知道位置） */
  | { type: "rewind"; to: number; at: number };

/** v3.1 附件元数据（重放展示用） */
export interface AttachmentMeta {
  /** 显示名（文件名或文件夹名） */
  name: string;
  /** 绝对路径（文件/文件夹引用）；图片为 null（字节不落库） */
  path?: string;
  /** 类型：file=文件 / dir=文件夹 / image=图片 */
  kind: "file" | "dir" | "image";
  /** 字节大小（文件/图片） */
  size?: number;
}

/** 运行时模型信息（v2.5：ToolContext 携带，子智能体委派解析子模型用；结构同 registry toRuntimeModel 返回值） */
export interface RuntimeModelInfo {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey: string;
  contextWindow?: number;
  thinkingLevels?: number;
  thinkingOverride?: Array<Record<string, unknown> | null>;
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 项目根目录（工具操作边界） */
  root: string;
  /** 当前工作目录 */
  cwd: string;
  /**
   * 审批请求（Web UI 挂接；CLI 可自动批准）
   * requireExplicit：联网放行等必须人工确认的场景——-y 自动批准也不放行（默认 false）
   */
  requestApproval: (
    description: string,
    risk: RiskLevel,
    requireExplicit?: boolean
  ) => Promise<boolean>;
  /** 事件推送 */
  emit: (event: AgentEvent) => void;
  // ── v2.5 子智能体委派（runAgent 填充；delegate_task 解析子模型/深度限制）──
  /** 当前 Agent 的模型配置（子智能体缺省继承；modelId 显式指定时覆盖） */
  modelConfig?: RuntimeModelInfo;
  /** 备用模型降级链（子智能体继承父级） */
  fallbackModelConfigs?: RuntimeModelInfo[];
  /** 思考级别（4 档 UI；子智能体继承，agent 文件 thinkingLevel 可覆盖） */
  thinkingLevel?: number;
  /** 委派深度（0=顶层；子智能体 +1；超 MAX_DELEGATION_DEPTH 拒绝再委派） */
  delegationDepth?: number;
  /** 中止信号（子智能体循环跟随父级） */
  abortSignal?: AbortSignal;
  /** v2.5：当前工具调用的 callId（loop 每次 execute 前填充；delegate_task 作 subagent-start 的 parentCallId） */
  callId?: string;
  /** v2.6：路径作用域规则（来自项目指令 INFU.md「路径作用域」节；文件类工具校验用） */
  scopeRules?: ScopeRule[];
  /** v2.6 收尾：向用户提问（ask_user 工具；未接线时返回 null——工具层提示不可用） */
  askUser?: (
    question: string,
    options?: Array<string | { label: string; desc?: string; recommended?: boolean }>
  ) => Promise<string | null>;
  /** v3.1 附件：用户附加文件/文件夹的只读白名单（read_file/read_files 放行；
   *  写工具不放行——附件目录不可被 Agent 修改） */
  extraReadDirs?: string[];
  /** v2.9：当前会话 id（per-session 子 Agent 上限计数用；子智能体继承） */
  sessionId?: string;
  /** v2.11：后台子智能体的父级消息通道（agent_message 工具用；仅后台委派注入；
   *  waitForMessage 暂停子循环等待父级 send_message 回复，父级中止时 resolve(null)） */
  agentChannel?: {
    waitForMessage: (message: string) => Promise<string | null>;
  };
  /** v2.14 批 18：沙箱档位覆盖（子智能体 agent 文件 sandbox 字段；缺省跟随全局设置） */
  sandboxMode?: "off" | "soft" | "restricted" | "docker" | "auto";
  /** v3.0 vision 底座：工具注入的视觉图片队列（base64 data URL）——
   *  read_image / screen_capture 等把图片推入，loop 下一轮请求合并为 image part（视觉模型）；
   *  非视觉模型由既有降级机制（图片转文本）兜底 */
  visionQueue?: string[];
  /** v3.3 异步任务编排：后台任务（子智能体/job）完成时向父循环通知队列入队——
   *  loop 每步开始 drain 为 user XML 消息（<task-notification>），模型实时感知；
   *  delegate_task/run_command 后台分支注入给 startBackgroundSubagent/startBackgroundJob */
  enqueueTaskNotification?: (note: {
    taskType: "subagent" | "job";
    taskId: string;
    name: string;
    status: "completed" | "failed" | "stopped" | "killed";
    summary: string;
    outputFile?: string;
  }) => void;
}

/** v2.6：路径作用域规则（INFU.md 声明式；语义对齐主流：deny > allow，命中禁止直接拒绝） */
export interface ScopeRule {
  /** true=允许（白名单）；false=禁止（黑名单） */
  allow: boolean;
  /** 相对项目根的 glob（** 跨段、* 单段；如 packages/agent/src/**） */
  pattern: string;
}

/** 工具定义（统一接口） */
export interface ToolDef {
  name: string;
  description: string;
  /** zod schema：参数校验 */
  schema: import("zod").ZodType<any, any, any>;
  /** 风险级别：low=直接执行；medium/high=需审批 */
  risk: RiskLevel;
  /** 执行函数，返回给模型的文本结果 */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

/** 模板任务的参数占位字段（小白引导：填写后渲染进 prompt） */
export interface TemplateField {
  name: string;
  label: string;
  placeholder?: string;
  default?: string;
}

/** 模板任务定义（小白引导：一键初始化项目 / 修复测试失败等） */
export interface TaskTemplate {
  id: string;
  name: string;
  /** 分类：初始化 / 修复 / 分析 / 开发 */
  category: string;
  description: string;
  /** 提示词模板，支持 {fieldName} 占位符 */
  prompt: string;
  fields?: TemplateField[];
}

/** 渲染模板 prompt：替换 {fieldName} 占位符（缺失字段用默认值或空串） */
export function renderTemplate(tpl: TaskTemplate, values: Record<string, string>): string {
  let out = tpl.prompt;
  for (const f of tpl.fields ?? []) {
    const v = (values[f.name] ?? f.default ?? "").trim();
    out = out.split(`{${f.name}}`).join(v);
  }
  // 兜底：values 中未定义在 fields 里的键也直接替换，防残留占位符
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}

// ── v2.1 会话持久化（服务端 / Web 共享的 API 形状）──

/** 会话状态（Web 列表徽标 / 继续会话判断） */
export type SessionStatus = "running" | "done" | "error" | "stopped";

/** 会话元数据（列表项 / 详情） */
export interface SessionMeta {
  id: string;
  title: string;
  root: string;
  modelId?: string;
  mode?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  /** 统计（列表展示用） */
  eventCount: number;
  toolCount: number;
  promptCount: number;
  /** v2.6.1：顶置（置顶区显示） */
  pinned: boolean;
  /** v2.6.1：归档（归档回收站；常规列表不显示） */
  archived: boolean;
}

/** 事件流条目（seq 全局有序；ts 为事件时间戳） */
export interface StoredEvent {
  seq: number;
  ts: number;
  event: AgentEvent;
}

/** /api/chat 任务请求体 */
export interface TaskRequest {
  prompt: string;
  /** 项目根目录（Agent 操作边界） */
  root?: string;
  modelId?: string;
  /** 思考级别（v2 模型管理：4 档 UI，按模型实际级别数自动映射；1-4，缺省 2） */
  thinkingLevel?: number;
  /** 备用模型 id 列表（v2.2 降级链，覆盖模型自身 fallbackModelIds） */
  fallbackModelIds?: string[];
  /** 按角色指定模型（v2.2 轻量模型选择：planner/executor/reviewer 模型 id，覆盖 config roles） */
  roleModelIds?: {
    planner?: string;
    executor?: string;
    reviewer?: string;
  };
  maxSteps?: number;
  /** Planner 计划是否需用户确认后执行（默认 true；-y 自动批准） */
  planApproval?: boolean;
}

// ── v2 配置 schema（供应商凭据两级结构；passthrough 保留未知字段）──
import { z } from "zod";

const providerConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["openai", "anthropic", "google", "deepseek", "zhipu", "qwen", "ollama", "custom"]),
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .passthrough();

const modelConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    model: z.string().min(1),
    providerId: z.string().optional(),
    // v1 遗留字段（兼容读取；新配置勿用）
    provider: z.enum(["openai", "anthropic", "google", "deepseek", "zhipu", "qwen", "ollama", "custom"]).optional(),
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    thinkingLevels: z.number().int().positive().optional(),
    thinkingOverride: z.array(z.record(z.string(), z.unknown()).nullable()).optional(),
    fallbackModelIds: z.array(z.string()).optional(),
    roles: z.array(z.enum(["planner", "executor", "reviewer"])).optional(),
  })
  .passthrough();

const roleModelRefSchema = z.union([
  z.string().min(1),
  z.object({ model: z.string().min(1), thinkingLevel: z.number().int().min(1).max(4).optional() }).passthrough(),
]);

/** MCP 服务器配置 schema（v2.3：工具动态注入 Agent 循环；passthrough 保留未知字段） */
const mcpServerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["stdio", "http"]).default("stdio"),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    riskOverrides: z.record(z.string(), z.enum(["low", "medium", "high"])).optional(),
  })
  .passthrough();

/** 插件配置 schema（v2.3 批 2：JS/TS 模块引用；配置即信任） */
const pluginConfigSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    enabled: z.boolean().optional(),
  })
  .passthrough();

/** skill 显式引用 schema（v2.3 批 2） */
const skillConfigSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().optional(),
  })
  .passthrough();

// ── v2.4 设置界面 schema（权限等级 / 沙箱等级 / 常规 / 外观；export 供 API 校验）──

const toolRiskOverrideSchema = z
  .object({
    tool: z.string().min(1),
    risk: z.enum(["low", "medium", "high"]).optional(),
    disabled: z.boolean().optional(),
  })
  .passthrough();

export const approvalPolicySchema = z
  .object({
    mode: z.enum(["auto", "smart", "confirm", "full"]).optional(),
    toolOverrides: z.array(toolRiskOverrideSchema).optional(),
    commandAllowlist: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export const sandboxConfigSchema = z
  .object({
    mode: z.enum(["auto", "off", "soft", "restricted", "docker"]).optional(),
  })
  .passthrough();

export const generalConfigSchema = z
  .object({
    defaultRoot: z.string().optional(),
    terminalShell: z.enum(["auto", "cmd", "powershell", "bash"]).optional(),
    autoLaunch: z.boolean().optional(),
    taskNotifications: z.boolean().optional(),
    notificationSound: z.boolean().optional(),
    closeToTray: z.boolean().optional(),
    preventSleep: z.boolean().optional(),
    autoContinueQuestions: z.boolean().optional(),
    showThinking: z.boolean().optional(),
    showTodos: z.boolean().optional(),
    autoCommit: z.boolean().optional(),
    autoArchive: z.boolean().optional(),
    archiveRetentionDays: z.number().int().min(1).max(365).optional(),
  })
  .passthrough();

export const appearanceConfigSchema = z
  .object({
    fontSize: z.enum(["xs", "sm", "base"]).optional(),
    streamCursor: z.boolean().optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .passthrough();

export const browserConfigSchema = z
  .object({
    headless: z.boolean().optional(),
    executablePath: z.string().optional(),
  })
  .passthrough();

export const memoryConfigSchema = z
  .object({
    autoSediment: z.boolean().optional(),
  })
  .passthrough();

/** InfuConfig 校验 schema（未知字段保留；version 缺省补 1） */
export const infuConfigSchema = z
  .object({
    models: z.array(modelConfigSchema).default([]),
    providers: z.array(providerConfigSchema).optional(),
    defaultModelId: z.string().optional(),
    roles: z
      .object({
        planner: roleModelRefSchema.optional(),
        executor: roleModelRefSchema.optional(),
        reviewer: roleModelRefSchema.optional(),
      })
      .passthrough()
      .optional(),
    mcpServers: z.array(mcpServerSchema).optional(),
    plugins: z.array(pluginConfigSchema).optional(),
    skills: z.array(skillConfigSchema).optional(),
    approvalPolicy: approvalPolicySchema.optional(),
    sandbox: sandboxConfigSchema.optional(),
    general: generalConfigSchema.optional(),
    appearance: appearanceConfigSchema.optional(),
    browser: browserConfigSchema.optional(),
    memory: memoryConfigSchema.optional(),
    version: z.number().int().positive().default(1),
  })
  .passthrough();

/**
 * v1 → v2 迁移（模型管理重构）：旧 models[]（自带 provider/baseURL/apiKey）
 * 按 kind+baseURL 归并为 providers[]，模型条目经 providerId 引用。
 * - API Key 从模型层迁到供应商层（v2 起模型不再存 key）
 * - defaultModelId / roles / fallbackModelIds / contextWindow 等保留
 * - 幂等：已是 v2（providers 非空）时原样返回
 */
export function migrateConfigV1(raw: unknown): InfuConfig {
  const r = infuConfigSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    throw new Error(`${where}${issue?.message ?? "配置格式错误"}`);
  }
  const cfg = r.data as unknown as InfuConfig;
  if (cfg.providers?.length) return cfg; // 已是 v2

  const providers: ProviderConfig[] = [];
  const providerByKey = new Map<string, ProviderConfig>();
  const seenKinds = new Map<string, number>();
  for (const m of cfg.models) {
    const kind = m.provider ?? "custom";
    const baseURL = m.baseURL;
    const pkey = `${kind}|${baseURL ?? ""}`;
    let p = providerByKey.get(pkey);
    if (!p) {
      const n = (seenKinds.get(kind) ?? 0) + 1;
      seenKinds.set(kind, n);
      p = {
        id: n === 1 ? kind : `${kind}-${n}`,
        name: kind === "custom" ? `自定义 ${n}` : baseURL ? `${kind} (${baseURL})` : kind,
        kind: kind as ProviderKind,
        baseURL,
        apiKey: m.apiKey,
      };
      providerByKey.set(pkey, p);
      providers.push(p);
    } else if (!p.apiKey && m.apiKey) {
      p.apiKey = m.apiKey; // 同供应商内后出现的 key 补充
    }
  }

  const models: ModelConfig[] = cfg.models.map((m) => {
    const pkey = `${m.provider ?? "custom"}|${m.baseURL ?? ""}`;
    const p = providerByKey.get(pkey)!;
    const { provider: _p, baseURL: _b, apiKey: _k, ...rest } = m;
    return { ...rest, providerId: p.id };
  });
  return { ...cfg, version: 2, providers, models };
}

/** 校验并归一化配置：返回 { ok:true, config } 或 { ok:false, error }（损坏文件不抛异常，由调用方备份处理） */
export function parseInfuConfig(raw: unknown): { ok: true; config: InfuConfig } | { ok: false; error: string } {
  const r = infuConfigSchema.safeParse(raw);
  if (!r.success) {
    // 只报第一条错误，消息保持简洁（zod v4 的 issues 数组）
    const issue = r.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${issue?.message ?? "配置格式错误"}` };
  }
  try {
    // v1 旧结构（models 自带 provider/baseURL/apiKey）→ 在线迁移为 v2（providers + providerId 引用）
    return { ok: true, config: migrateConfigV1(r.data) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
