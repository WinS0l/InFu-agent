/**
 * v2.4 设置界面 — 大弹窗 + 左侧分组导航（信息架构升级定稿 2026-08-13）
 *
 * 导航三组：
 *  - 基础设置：常规 / 外观 / 模型设置 / 浏览器（规划中）
 *  - Agent 能力：记忆（规划中）/ 插件 / 技能 / 子智能体（规划中）/ MCP 服务器 / 命令 / 钩子
 *  - 数据与统计：索引库（规划中）/ 使用统计（规划中）
 *
 * 插件/技能/MCP/钩子从独立弹窗内嵌（SettingsPanes）；「命令」= 原权限 Tab 重组
 * （审批档位 + 工具覆盖/禁用 + 命令白名单 + 高危命令说明）；未实现功能显示占位 + 规划中徽标。
 * 配置写 GET/PUT /api/config（服务端白名单只接受设置节，防提权）。
 */

import { useEffect, useRef, useState } from "react";
import {
  X, Check, ShieldCheck, Palette, Cpu, SlidersHorizontal, Loader2,
  Blocks, Database, BarChart3, BrainCircuit, Bot, Globe, Plug, Trash2, Plus,
} from "lucide-react";
import type { RiskLevel } from "@infu/shared";
import { useStore } from "../store";
import { fetchConfig, updateConfig, type ApprovalMode, type SettingsConfig, type ToolRiskOverrideInput } from "../api";
import { McpPane, PluginsPane, SkillsPane, HooksPane, ComingSoonPane } from "./SettingsPanes";
import ModelPane from "./ModelPane";

export type SettingsTab =
  | "general" | "appearance" | "model" | "browser"
  | "memory" | "plugins" | "skills" | "subagent" | "mcp" | "commands" | "hooks"
  | "index" | "stats";

interface Props {
  onClose: () => void;
  /** 初始定位 Tab（顶栏「设置」入口用） */
  initialTab?: SettingsTab;
}

/** 权限档位说明 */
const MODE_META: Record<ApprovalMode, { label: string; desc: string }> = {
  auto: { label: "全自动", desc: "非人工必需场景全部自动放行（等价 CLI -y）。联网放行/自注册等安全线仍需人工确认" },
  smart: { label: "智能（默认）", desc: "低风险自动放行，中/高风险人工确认" },
  confirm: { label: "全部确认", desc: "所有风险等级（含低风险）都弹窗人工确认，最安全" },
};

/** 沙箱档位说明 */
const SANDBOX_META: Record<string, { label: string; desc: string }> = {
  auto: { label: "自动（推荐）", desc: "按可用性选择：Docker → Windows 受限沙箱 → 软沙箱" },
  off: { label: "直连（off）", desc: "不经沙箱直接执行（仅故障排查用；命令审计仍保留）" },
  soft: { label: "L1 软沙箱", desc: "环境变量消毒 + 敏感路径写保护 + 命令审计（纯软，不隐式启用受限沙箱）" },
  restricted: { label: "L1.5 受限沙箱", desc: "Windows 受限令牌 + Job Object（OS 级强制；仅 Windows 可用，否则降级 L1）" },
  docker: { label: "L2 Docker 容器", desc: "断网 + 只读挂载 + 资源限制 + 任务后销毁（需 Docker；不可用时命令直接失败）" },
};

const RISK_OPTIONS: Array<{ value: "" | RiskLevel; label: string }> = [
  { value: "", label: "— 继承 —" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

const inputCls =
  "h-8 rounded-md border border-line bg-muted px-2 font-mono text-xs text-text placeholder:text-sub/60 focus:border-accent focus:outline-none";
const selectCls =
  "h-8 cursor-pointer rounded-md border border-line bg-muted px-2 text-xs text-text hover:border-accent focus:outline-none";

/** 手写开关（与 McpManagerModal 同款） */
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={`relative h-4 w-8 shrink-0 cursor-pointer rounded-full transition-colors ${on ? "bg-accent/70" : "bg-muted"}`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full transition-all ${on ? "left-[18px] bg-text" : "left-0.5 bg-sub"}`}
      />
    </button>
  );
}

/** 导航分组定义 */
const NAV_GROUPS: Array<{ label: string; items: Array<{ id: SettingsTab; label: string; icon: typeof Cpu; planned?: boolean }> }> = [
  {
    label: "基础设置",
    items: [
      { id: "general", label: "常规", icon: SlidersHorizontal },
      { id: "appearance", label: "外观", icon: Palette },
      { id: "model", label: "模型设置", icon: Cpu },
      { id: "browser", label: "浏览器", icon: Globe, planned: true },
    ],
  },
  {
    label: "Agent 能力",
    items: [
      { id: "memory", label: "记忆", icon: BrainCircuit, planned: true },
      { id: "plugins", label: "插件", icon: Blocks },
      { id: "skills", label: "技能", icon: Bot },
      { id: "subagent", label: "子智能体", icon: Bot, planned: true },
      { id: "mcp", label: "MCP 服务器", icon: Plug },
      { id: "commands", label: "命令", icon: ShieldCheck },
      { id: "hooks", label: "钩子", icon: Blocks },
    ],
  },
  {
    label: "数据与统计",
    items: [
      { id: "index", label: "索引库", icon: Database, planned: true },
      { id: "stats", label: "使用统计", icon: BarChart3, planned: true },
    ],
  },
];

/** 规划中功能的占位说明 */
const PLANNED: Record<string, { name: string; desc: string; roadmap: string }> = {
  browser: {
    name: "浏览器",
    desc: "浏览器自动化（browser-use 类工具）的设置：默认浏览器、视口、截图目录等。当前版本暂无浏览器工具，落地后在此配置。",
    roadmap: "规划：随 browser-use 插件生态落地（v2.7 生态与数据）",
  },
  memory: {
    name: "记忆",
    desc: "三层记忆系统（项目记忆 / 任务总和记忆 / 全局记忆）的管理：启用开关、来源与检索。形态实施前需单独讨论定稿。",
    roadmap: "规划：v2.6 记忆与任务",
  },
  subagent: {
    name: "子智能体",
    desc: "子智能体（opencode 式）：委派、独立上下文、并行执行、结果回收；agent 文件化定义（markdown 定义角色/工具/模型）。",
    roadmap: "规划：v2.5 子智能体与并行",
  },
  index: {
    name: "索引库",
    desc: "代码索引/检索库：为 Agent 提供项目级语义检索。当前 search_code 为文件级搜索，索引库落地后在此配置。",
    roadmap: "规划：随记忆系统一并评估（v2.6+）",
  },
  stats: {
    name: "使用统计",
    desc: "成本/用量追踪 + 审计可视化 + 任务回放：token 消耗、工具调用、会话统计。",
    roadmap: "规划：v2.7 生态与数据",
  },
};

export default function SettingsModal({ onClose, initialTab = "general" }: Props) {
  const { models, setAppearance, setRoot, root } = useStore();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [cfg, setCfg] = useState<SettingsConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  // 命令 Tab：新建命令（快速加入白名单，顶置）
  const [newCommandOpen, setNewCommandOpen] = useState(false);
  const [newCommandText, setNewCommandText] = useState("");
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    fetchConfig().then(setCfg).catch((e) => setError((e as Error).message));
  }, []);

  if (!cfg) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
        <div className="flex h-56 w-[820px] flex-col items-center justify-center gap-3 rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
          <div className="text-xs text-sub">正在加载设置…</div>
        </div>
      </div>
    );
  }

  const { approvalPolicy, sandbox, general, appearance, defaultModelId: cfgDefaultModel } = cfg;
  const policyMode: ApprovalMode = approvalPolicy.mode ?? "smart";
  const sandboxMode = sandbox.mode ?? "auto";
  const fontSize = appearance.fontSize ?? "sm";
  const streamCursor = appearance.streamCursor ?? true;

  const patch = (p: Partial<SettingsConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const patchPolicy = (p: Partial<SettingsConfig["approvalPolicy"]>) =>
    setCfg((c) => (c ? { ...c, approvalPolicy: { ...c.approvalPolicy, ...p } } : c));
  const overrides = approvalPolicy.toolOverrides ?? [];
  const allowlist = approvalPolicy.commandAllowlist ?? [];

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const { dockerAvailable: _d, winRestrictedOk: _w, ...sandboxOut } = cfg.sandbox;
      await updateConfig({
        approvalPolicy: cfg.approvalPolicy,
        sandbox: sandboxOut,
        general: cfg.general,
        appearance: cfg.appearance,
        defaultModelId: cfg.defaultModelId,
      });
      setAppearance({ fontSize, streamCursor });
      if (general.defaultRoot && root === "E:\\InFu(test)") setRoot(general.defaultRoot);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateOverride = (i: number, p: Partial<ToolRiskOverrideInput>) => {
    patchPolicy({ toolOverrides: overrides.map((o, j) => (j === i ? { ...o, ...p } : o)) });
  };
  const removeOverride = (i: number) => patchPolicy({ toolOverrides: overrides.filter((_, j) => j !== i) });

  /** 新建命令：加入命令白名单并置顶（去重） */
  const submitNewCommand = () => {
    const cmd = newCommandText.trim();
    if (!cmd) return;
    patchPolicy({ commandAllowlist: [cmd, ...allowlist.filter((x) => x !== cmd)] });
    setNewCommandText("");
    setNewCommandOpen(false);
  };

  const currentItem = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === tab);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-[600px] w-[880px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <ShieldCheck className="h-4 w-4 text-accent" />
          <div className="text-sm font-semibold text-text">设置</div>
          <div className="text-xs text-sub">基础设置 · Agent 能力 · 数据与统计</div>
          <button className="ml-auto cursor-pointer rounded p-1 text-sub hover:bg-muted hover:text-text" onClick={onClose} title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* 左侧分组导航 */}
          <nav className="w-44 shrink-0 overflow-y-auto border-r border-line p-2">
            {NAV_GROUPS.map((g) => (
              <div key={g.label} className="mb-2">
                <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-sub/60">{g.label}</div>
                {g.items.map((item) => (
                  <button
                    key={item.id}
                    disabled={item.planned}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors ${
                      item.planned
                        ? "cursor-not-allowed text-sub/40"
                        : tab === item.id
                          ? "bg-accent/10 text-accent"
                          : "text-sub hover:bg-muted hover:text-text"
                    }`}
                    onClick={() => setTab(item.id)}
                    title={item.planned ? `规划中（${PLANNED[item.id].roadmap}）` : item.label}
                  >
                    <item.icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.planned && (
                      <span className="shrink-0 rounded border border-warn/30 bg-warn/5 px-1 py-px text-[9px] text-warn/80">
                        规划中
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          {/* 右侧内容区 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {tab === "general" && (
              <div className="space-y-5">
                <SectionTitle title="常规" desc="任务与界面默认值（写入 ~/.infu/config.json）" />
                <div className="space-y-2">
                  <Label text="默认项目根目录" />
                  <input
                    className={`${inputCls} w-full`}
                    value={general.defaultRoot ?? ""}
                    onChange={(e) => patch({ general: { ...general, defaultRoot: e.target.value } })}
                    placeholder="如 E:\workspace\my-project（留空 = 不预设）"
                    spellCheck={false}
                  />
                  <div className="text-[11px] text-sub">Web 输入框为空时的默认值；Agent 任务仍以每次输入为准</div>
                </div>
                <div className="space-y-2">
                  <Label text="默认模型" />
                  <select
                    className={`${selectCls} w-full`}
                    value={cfgDefaultModel ?? ""}
                    onChange={(e) => patch({ defaultModelId: e.target.value || null })}
                  >
                    <option value="">— 未设置（自动选首个可用模型）—</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}（{m.id}）</option>
                    ))}
                  </select>
                  <div className="text-[11px] text-sub">「模型设置」Tab 提供完整角色路由；此处为全局默认（可空）</div>
                </div>
              </div>
            )}

            {tab === "appearance" && (
              <div className="space-y-6">
                <SectionTitle title="外观" desc="界面偏好（随配置持久化，跨浏览器一致）" />
                <div className="space-y-2">
                  <Label text="界面字号" />
                  <div className="flex gap-2">
                    {(["xs", "sm", "base"] as const).map((f) => (
                      <button
                        key={f}
                        className={`cursor-pointer rounded-md border px-4 py-1.5 text-xs transition-colors ${
                          fontSize === f ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-sub hover:border-line hover:bg-muted"
                        }`}
                        onClick={() => patch({ appearance: { ...appearance, fontSize: f } })}
                      >
                        {f === "xs" ? "紧凑" : f === "sm" ? "标准" : "大"}
                      </button>
                    ))}
                  </div>
                  <div className="text-[11px] text-sub">整体界面缩放（含间距）；实时预览见按钮下方</div>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-line bg-muted/30 p-3">
                  <div>
                    <div className="text-xs font-medium text-text">流式输出光标</div>
                    <div className="mt-0.5 text-[11px] text-sub">AI 流式回复时显示绿色闪烁光标</div>
                  </div>
                  <Toggle on={streamCursor} onChange={(v) => patch({ appearance: { ...appearance, streamCursor: v } })} />
                </div>
              </div>
            )}

            {tab === "model" && (
              <div className="space-y-4">
                <SectionTitle title="模型设置" desc="供应商凭据 / 上游模型 / 角色路由（写入 ~/.infu/config.json）" />
                <ModelPane />
              </div>
            )}

            {tab === "plugins" && <PluginsPane />}
            {tab === "skills" && <SkillsPane />}
            {tab === "mcp" && <McpPane />}
            {tab === "hooks" && <HooksPane />}

            {tab === "commands" && (
              <div className="space-y-6">
                <SectionTitle title="命令" desc="审批策略：全局档位 + 工具级覆盖/禁用 + 命令白名单（Agent 工具调用与命令执行）" />

                {/* 新建命令（顶置）：快速加入命令白名单 */}
                <div className="space-y-2">
                  <Label text="命令白名单" hint="命中白名单的命令跳过高危命令审批（联网 requireExplicit 永不豁免）；* 匹配任意字符；新建的命令置顶" />
                  {!newCommandOpen ? (
                    <button
                      className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-accent/50 bg-accent/10 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
                      onClick={() => setNewCommandOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5" />新建命令
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 p-2">
                      <input
                        className={`${inputCls} flex-1`}
                        value={newCommandText}
                        onChange={(e) => setNewCommandText(e.target.value)}
                        placeholder="如 npm run build 或 git*"
                        spellCheck={false}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitNewCommand();
                          if (e.key === "Escape") { setNewCommandOpen(false); setNewCommandText(""); }
                        }}
                      />
                      <button
                        className="flex h-8 cursor-pointer items-center gap-1 rounded bg-accent px-3 text-xs font-medium text-ink transition-colors hover:bg-accent/85 disabled:opacity-50"
                        onClick={submitNewCommand}
                        disabled={!newCommandText.trim()}
                      >
                        <Check className="h-3.5 w-3.5" />添加
                      </button>
                      <button
                        className="h-8 cursor-pointer rounded border border-line px-3 text-xs text-sub transition-colors hover:bg-muted hover:text-text"
                        onClick={() => { setNewCommandOpen(false); setNewCommandText(""); }}
                      >
                        取消
                      </button>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {allowlist.map((a, i) => (
                      <div key={`${a}-${i}`} className="flex items-center gap-2">
                        <span className="flex-1 rounded-md border border-line bg-muted px-2 py-1.5 font-mono text-xs text-text">{a}</span>
                        <button className="cursor-pointer rounded p-1 text-sub hover:bg-muted hover:text-danger" onClick={() => patchPolicy({ commandAllowlist: allowlist.filter((_, j) => j !== i) })} title="删除">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label text="全局审批档位" />
                  <div className="grid grid-cols-3 gap-2">
                    {(Object.keys(MODE_META) as ApprovalMode[]).map((m) => (
                      <button
                        key={m}
                        className={`cursor-pointer rounded-lg border p-3 text-left transition-colors ${
                          policyMode === m ? "border-accent/60 bg-accent/10" : "border-line bg-muted/30 hover:border-line hover:bg-muted/60"
                        }`}
                        onClick={() => patchPolicy({ mode: m })}
                      >
                        <div className="flex items-center gap-1.5 text-xs font-medium text-text">
                          <span className={`h-2 w-2 rounded-full ${policyMode === m ? "bg-accent" : "bg-sub/50"}`} />
                          {MODE_META[m].label}
                        </div>
                        <div className="mt-1 text-[11px] leading-relaxed text-sub">{MODE_META[m].desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label text="工具覆盖" hint="工具名精确 或 前缀*通配（如 git*）；覆盖风险或禁用工具（对 MCP/插件工具同样生效）" />
                  <div className="space-y-1.5">
                    {overrides.map((o, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          className={`${inputCls} flex-1`}
                          value={o.tool}
                          onChange={(e) => updateOverride(i, { tool: e.target.value })}
                          placeholder="run_command 或 git*"
                          spellCheck={false}
                        />
                        <select
                          className={selectCls}
                          value={o.risk ?? ""}
                          onChange={(e) => updateOverride(i, { risk: (e.target.value as RiskLevel) || undefined })}
                        >
                          {RISK_OPTIONS.map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                        <div className="flex items-center gap-1.5 text-[11px] text-sub">
                          禁用
                          <Toggle on={o.disabled === true} onChange={(v) => updateOverride(i, { disabled: v })} />
                        </div>
                        <button className="cursor-pointer rounded p-1 text-sub hover:bg-muted hover:text-danger" onClick={() => removeOverride(i)} title="删除">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    className="w-full cursor-pointer rounded-lg border border-dashed border-line py-2 text-xs text-sub transition-colors hover:border-accent hover:text-accent"
                    onClick={() => patchPolicy({ toolOverrides: [...overrides, { tool: "" }] })}
                  >
                    <Plus className="mr-1 inline h-3.5 w-3.5" />添加工具覆盖
                  </button>
                </div>

                <div className="space-y-2">
                  <Label text="沙箱等级" hint="取代 INFU_SANDBOX 环境变量（环境变量仍可临时覆盖）；影响 run_command / run_test" />
                  <div className="space-y-2">
                    {(Object.keys(SANDBOX_META) as Array<"auto" | "off" | "soft" | "restricted" | "docker">).map((m) => {
                      const unavailable =
                        (m === "docker" && sandbox.dockerAvailable === false) ||
                        (m === "restricted" && sandbox.winRestrictedOk === false);
                      return (
                        <button
                          key={m}
                          className={`w-full cursor-pointer rounded-lg border p-2.5 text-left transition-colors ${
                            sandboxMode === m ? "border-accent/60 bg-accent/10" : "border-line bg-muted/30 hover:bg-muted/60"
                          }`}
                          onClick={() => patch({ sandbox: { ...sandbox, mode: m } })}
                        >
                          <div className="flex items-center gap-1.5 text-xs font-medium text-text">
                            <span className={`h-2 w-2 rounded-full ${sandboxMode === m ? "bg-accent" : "bg-sub/50"}`} />
                            {SANDBOX_META[m].label}
                            {unavailable && (
                              <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-px text-[10px] text-warn">当前机器不可用</span>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] leading-relaxed text-sub">{SANDBOX_META[m].desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-lg border border-line bg-muted/30 p-3 text-[11px] leading-relaxed text-sub">
                  <span className="text-text">高危命令红线：</span>
                  rm -rf / del /f / format / mkfs / dd if= 等删除/格式化类命令始终 high 级审批（命令白名单可豁免；
                  联网放行 requireExplicit 任何档位不豁免）；Web 终端（右下角）中的高危命令同样需人工确认。
                </div>
              </div>
            )}

            {currentItem?.planned && <ComingSoonPane {...PLANNED[tab]} />}
          </div>
        </div>

        {/* 底部操作条 */}
        <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-2.5">
          <div className="text-[11px] text-sub/70">
            写入 ~/.infu/config.json（服务端白名单：仅设置节可写）；插件/技能/MCP/钩子实时生效
          </div>
          <div className="ml-auto flex items-center gap-2">
            {saved && (
              <span className="flex items-center gap-1 text-xs text-accent">
                <Check className="h-3.5 w-3.5" />已保存
              </span>
            )}
            <button
              className="cursor-pointer rounded border border-line px-3 py-1.5 text-xs text-sub transition-colors hover:bg-muted hover:text-text"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="flex cursor-pointer items-center gap-1.5 rounded bg-accent px-4 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-accent/85 disabled:opacity-50"
              onClick={save}
              disabled={saving}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              保存设置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <div className="text-sm font-semibold text-text">{title}</div>
      <div className="mt-0.5 text-[11px] text-sub">{desc}</div>
    </div>
  );
}

function Label({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-medium text-text">{text}</span>
      {hint && <span className="text-[11px] text-sub/70">{hint}</span>}
    </div>
  );
}
