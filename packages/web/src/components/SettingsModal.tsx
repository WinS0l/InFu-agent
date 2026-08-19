/**
 * v2.4 设置界面 — 大弹窗 + 左侧分组导航（v3：重构——r24 双栏、
 * 188px 导航轨 / 54px 内容头 / 全屏高自适应；信息架构不变）
 *
 * 导航三组：
 *  - 基础设置：常规 / 外观 / 模型设置 / 浏览器
 *  - Agent 能力：记忆 / 插件 / 技能 / 子智能体 / MCP 服务器 / 命令 / 钩子
 *  - 数据与统计：索引库 / 使用统计
 *
 * 插件/技能/MCP/钩子从独立弹窗内嵌（SettingsPanes）；「命令」= 原权限 Tab 重组
 * （审批档位 + 工具覆盖/禁用 + 命令白名单 + 高危命令说明）。
 * 配置写 GET/PUT /api/config（服务端白名单只接受设置节，防提权）。
 */

import { useEffect, useRef, useState } from "react";
import {
  X, Check, Palette, Cpu, SlidersHorizontal, Loader2, ChevronDown, Terminal,
  Blocks, Database, BarChart3, BrainCircuit, Bot, Globe, Plug, Trash2, Plus,
  Moon, Sun, MonitorCog, FolderSearch, BookOpen, Workflow, Folder,
  Clock, ShieldAlert, Scale, ShieldCheck, AlertTriangle, ScrollText,
} from "lucide-react";
import type { RiskLevel } from "@infu/shared";
import { useStore, type SettingsTab } from "../store";
import { fetchConfig, updateConfig, apiFetch, type ApprovalMode, type SettingsConfig, type ToolRiskOverrideInput } from "../api";
import { McpPane, PluginsPane, SkillsPane, AgentsPane, HooksPane, BrowserPane, MemoryPane, StatsPane, IndexPane, SchedulePane, DataDirPane, AuditPane } from "./SettingsPanes";
import ModelPane from "./ModelPane";
import { Toggle, CapsuleButton } from "./ui";

interface Props {
  onClose: () => void;
  /** 初始定位 Tab（顶栏「设置」入口用） */
  initialTab?: SettingsTab;
}

/** 权限档位说明（图标与 composer 下拉一致：full = 红色警示三角——一切审批自动放行） */
const MODE_META: Record<ApprovalMode, { label: string; desc: string; icon: typeof Scale; iconCls: string }> = {
  auto: { label: "全自动", desc: "非人工必需场景全部自动放行（等价 CLI -y）。联网放行/自注册等安全线仍需人工确认", icon: ShieldAlert, iconCls: "text-warn" },
  smart: { label: "智能（默认）", desc: "低风险自动放行，中/高风险人工确认", icon: Scale, iconCls: "text-sub" },
  confirm: { label: "全部确认", desc: "所有风险等级（含低风险）都弹窗人工确认，最安全", icon: ShieldCheck, iconCls: "text-sub" },
  // v3.5：最大权限档（对齐 Codex 完全信任 / harness danger-full-access）——所有审批自动放行，
  // 含联网/自注册等安全红线；仅剩硬闸（显式禁用工具/受保护路径/断网策略/路径作用域）仍拦截
  full: { label: "全权放行", desc: "完全信任 Agent：一切审批（含安全红线）自动放行，零弹窗。仅显式禁用工具/受保护路径仍拦截。审计照常记录", icon: AlertTriangle, iconCls: "text-danger" },
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
  "h-8 rounded-lg border border-line bg-input px-2.5 font-mono text-xs text-text placeholder:text-caption focus:border-info/60 focus:outline-none";
const selectCls =
  "h-8 cursor-pointer rounded-lg border border-line bg-input px-2 text-xs text-text hover:border-info/60 focus:outline-none";

/** 导航分组定义 */
const NAV_GROUPS: Array<{ label: string; items: Array<{ id: SettingsTab; label: string; icon: typeof Cpu }> }> = [
  {
    label: "基础设置",
    items: [
      { id: "general", label: "常规", icon: SlidersHorizontal },
      { id: "appearance", label: "外观", icon: Palette },
      { id: "model", label: "模型设置", icon: Cpu },
      { id: "browser", label: "浏览器", icon: Globe },
    ],
  },
  {
    label: "Agent 能力",
    items: [
      { id: "memory", label: "记忆", icon: BrainCircuit },
      { id: "plugins", label: "插件", icon: Blocks },
      { id: "skills", label: "技能", icon: BookOpen },
      { id: "subagent", label: "子智能体", icon: Bot },
      { id: "mcp", label: "MCP 服务器", icon: Plug },
      { id: "commands", label: "命令", icon: Terminal },
      { id: "hooks", label: "钩子", icon: Workflow },
      { id: "schedule", label: "定时任务", icon: Clock },
    ],
  },
  {
    label: "数据与统计",
    items: [
      { id: "datadir", label: "数据存储", icon: Folder },
      { id: "index", label: "索引库", icon: Database },
      { id: "audit", label: "命令审计", icon: ScrollText },
      { id: "stats", label: "使用统计", icon: BarChart3 },
    ],
  },
];

/** v3.0 批 12：自定义模型下拉（与主题选择一致的面板样式；原生 select 视觉不统一） */
function ModelDropdown({ value, models, onChange }: {
  value: string;
  models: Array<{ id: string; name?: string }>;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const current = models.find((m) => m.id === value);
  return (
    <div ref={ref} className="relative">
      <button
        className="flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-line bg-input px-2.5 text-xs text-text transition-colors hover:border-info/60"
        onClick={() => setOpen(!open)}
      >
        <span className="truncate">{current ? `${current.name ?? current.id}（${current.id}）` : "— 未设置（自动选首个可用模型）—"}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-sub transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-xl border border-line bg-elevated p-1 shadow-lv3">
          <button
            className="flex h-8 w-full cursor-pointer items-center rounded-lg px-2.5 text-left text-xs text-sub transition-colors hover:bg-hover hover:text-text"
            onClick={() => { onChange(""); setOpen(false); }}
          >
            — 未设置（自动选首个可用模型）—
          </button>
          {models.map((m) => (
            <button
              key={m.id}
              className={`flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 text-left text-xs transition-colors hover:bg-hover ${
                m.id === value ? "text-info" : "text-text"
              }`}
              onClick={() => { onChange(m.id); setOpen(false); }}
            >
              <span className="min-w-0 truncate">{m.name ?? m.id}（{m.id}）</span>
              {m.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  // v3：默认会话根目录「浏览」——目录选择器 → 服务端解析候选路径（浏览器拿不到绝对路径）
  const fileRef = useRef<HTMLInputElement>(null);
  const [browseHints, setBrowseHints] = useState("");
  const loaded = useRef(false);

  /** v3.0 批 12：浏览文件夹——桌面版 = Electron 原生系统对话框（openDirectory）直接拿绝对路径；
   *  Web 版回退 webkitdirectory → /api/projects/resolve 解析候选 */
  const onBrowseDefaultRoot = async () => {
    const d = window.infuDesktop;
    if (d) {
      const paths = await d.selectPaths({ directories: true });
      if (paths.length) {
        patch({ general: { ...cfg!.general, defaultRoot: paths[0] } });
        setBrowseHints(`已填入：${paths[0]}`);
      }
      return;
    }
    fileRef.current?.click();
  };

  /** Web 兜底：webkitdirectory → 服务端解析候选路径 */
  const onBrowseDefaultRootWeb = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const dirName = f.webkitRelativePath.split("/")[0] || f.name;
    setBrowseHints(`已选择「${dirName}」，解析路径中…`);
    try {
      const res = await apiFetch(`/api/projects/resolve?name=${encodeURIComponent(dirName)}`);
      const data = await res.json();
      const candidates: string[] = data.candidates ?? [];
      if (candidates.length === 1) {
        patch({ general: { ...cfg!.general, defaultRoot: candidates[0] } });
        setBrowseHints(`已填入：${candidates[0]}`);
      } else if (candidates.length > 1) {
        setBrowseHints(`找到 ${candidates.length} 个同名目录：${candidates.join("；")}——请手动确认路径`);
      } else {
        setBrowseHints("常见位置未找到同名目录，请手动填写路径");
      }
    } catch {
      setBrowseHints("解析文件夹路径失败，请手动填写");
    }
  };

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    fetchConfig().then(setCfg).catch((e) => setError((e as Error).message));
  }, []);

  if (!cfg) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: "var(--mask)" }}
        onClick={onClose}
      >
        <div
          className="flex h-56 w-[420px] flex-col items-center justify-center gap-3 rounded-3xl border border-line bg-elevated shadow-lv3"
          onClick={(e) => e.stopPropagation()}
        >
          <Loader2 className="h-6 w-6 animate-spin text-info" />
          <div className="text-[13px] text-sub">正在加载设置…</div>
        </div>
      </div>
    );
  }

  const { approvalPolicy, sandbox, general, appearance, defaultModelId: cfgDefaultModel } = cfg;
  const policyMode: ApprovalMode = approvalPolicy.mode ?? "smart";
  const sandboxMode = sandbox.mode ?? "auto";
  const fontSize = appearance.fontSize ?? "sm";
  const streamCursor = appearance.streamCursor ?? true;
  const theme: "light" | "dark" | "system" = appearance.theme === "system" ? "system" : appearance.theme === "light" ? "light" : "dark";

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
      setAppearance({ fontSize, streamCursor, theme });
      // v3.5 补：设置保存后同步全局审批档位——composer 下拉与设置「命令」Tab 双向联动
      useStore.getState().setApprovalMode(cfg.approvalPolicy.mode ?? "smart");
      // v3 修复：仅当 root 为空时应用默认根目录
      if (general.defaultRoot && !root) setRoot(general.defaultRoot);
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "var(--mask)" }}
      onClick={onClose}
    >
      <div
        className="flex overflow-hidden rounded-3xl border border-line bg-elevated shadow-lv3"
        style={{ width: "min(880px, 94vw)", height: "min(800px, calc(100vh - 48px))" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧导航轨（主流 188px：标题 + 分组 + 40px 单元格） */}
        <nav className="w-[188px] shrink-0 overflow-y-auto border-r border-line px-3 py-5">
          <div className="px-3 pb-2 text-base font-medium text-text">设置</div>
          {NAV_GROUPS.map((g) => (
            <div key={g.label} className="mb-1.5">
              <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-caption">{g.label}</div>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  className={`flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 text-left text-[13px] transition-colors ${
                    tab === item.id ? "bg-hover font-medium text-text" : "text-sub hover:bg-hover/60 hover:text-text"
                  }`}
                  onClick={() => setTab(item.id)}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* 右侧内容列 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 内容头（54px：标题 + 关闭） */}
          <div className="flex h-[54px] shrink-0 items-center gap-2 border-b border-line px-6">
            <span className="text-base font-medium text-text">{currentItem?.label ?? "设置"}</span>
            <span className="hidden text-xs text-caption sm:inline">基础设置 · Agent 能力 · 数据与统计</span>
            <button
              className="ml-auto flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl text-sub transition-colors hover:bg-hover hover:text-text"
              onClick={onClose}
              title="关闭（Esc）"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {error && (
            <div className="shrink-0 border-b border-danger/30 bg-danger-soft px-6 py-2 text-xs text-danger">{error}</div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {tab === "general" && (
              <div className="space-y-5">
                <SectionTitle title="常规" desc="任务与界面默认值（写入 ~/.infu/config.json）" />
                <div className="space-y-2">
                  <Label text="默认会话根目录" hint="会话区「新建会话」默认落在这里；该目录为只读容器（自由会话不能修改其中任何内容，已注册项目豁免）" />
                  <div className="flex items-center gap-2">
                    <input
                      className={`${inputCls} flex-1`}
                      value={general.defaultRoot ?? ""}
                      onChange={(e) => patch({ general: { ...general, defaultRoot: e.target.value } })}
                      placeholder="如 E:\workspace\my-project（留空 = 不预设，回落当前目录）"
                      spellCheck={false}
                    />
                    <button
                      className="flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-line bg-elevated px-2.5 text-xs font-medium text-text transition-colors hover:bg-hover"
                      onClick={() => void onBrowseDefaultRoot()}
                      title="选择文件夹（桌面版原生对话框，直接填入绝对路径）"
                    >
                      <FolderSearch className="h-3.5 w-3.5" />
                      选择文件夹
                    </button>
                    <input
                      ref={fileRef}
                      type="file"
                      className="hidden"
                      {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                      onChange={(e) => void onBrowseDefaultRootWeb(e.target.files)}
                    />
                  </div>
                  {browseHints && (
                    <div className="text-xs leading-5 text-sub">
                      {browseHints}
                    </div>
                  )}
                  <div className="text-xs text-sub">自由会话的只读容器：Agent 任务必须绑定项目后才可写文件</div>
                </div>
                {/* v3.0 批 12：集成终端默认 shell（常规设置参考——自动/CMD/PowerShell/Git Bash） */}
                <div className="space-y-2">
                  <Label text="集成终端" hint="仅新会话生效；auto = 自动优先 Git Bash，找不到回退 cmd.exe（同语义）" />
                  <div className="flex gap-1.5">
                    {(["auto", "cmd", "powershell", "bash"] as const).map((sh) => (
                      <button
                        key={sh}
                        className={`h-8 cursor-pointer rounded-lg border px-3 text-xs transition-colors ${
                          (general.terminalShell ?? "auto") === sh
                            ? "border-info/60 bg-info/10 text-info"
                            : "border-line bg-elevated text-sub hover:text-text"
                        }`}
                        onClick={() => patch({ general: { ...general, terminalShell: sh } })}
                      >
                        {sh === "auto" ? "自动" : sh === "cmd" ? "CMD" : sh === "powershell" ? "PowerShell" : "Git Bash"}
                      </button>
                    ))}
                  </div>
                  <div className="text-xs text-sub">终端面板位于聊天输入框右上「终端」按钮；也可在面板内临时切换</div>
                </div>
                {/* v5.0（B4）：快速回复模型——寒暄/极短非任务消息自动用快模型（省钱提速，用户无感） */}
                <div className="space-y-2">
                  <Label text="快速回复模型（可选）" hint="寒暄与极短的非任务消息（如「你好」「在吗」）自动用该模型回复，不消耗旗舰模型额度；任务类消息仍走默认模型。留空 = 不启用" />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {models.slice(0, 12).map((m) => (
                      <button
                        key={m.id}
                        className={`h-8 cursor-pointer rounded-lg border px-3 text-xs transition-colors ${
                          (general.quickModelId ?? "") === m.id
                            ? "border-info/60 bg-info/10 text-info"
                            : "border-line bg-elevated text-sub hover:text-text"
                        }`}
                        onClick={() => patch({ general: { ...general, quickModelId: (general.quickModelId ?? "") === m.id ? undefined : m.id } })}
                      >
                        {m.name ?? m.id}
                      </button>
                    ))}
                    {models.length === 0 && <div className="text-xs text-caption">暂无模型（先到「模型设置」配置）</div>}
                  </div>
                </div>
                {/* v3.0 批 12：开机自启（默认关闭，用户主动开启；仅桌面版生效） */}
                <div className="space-y-2">
                  <Label text="开机自启" hint="登录 Windows 后自动启动 InFu（默认关闭，需手动开启）" />
                  <div className="flex items-center gap-2.5">
                    <Toggle checked={general.autoLaunch === true} onChange={(v) => patch({ general: { ...general, autoLaunch: v } })} title={general.autoLaunch === true ? "已开启（随系统启动）" : "未开启（默认）"} />
                    <span className="text-xs text-sub">{general.autoLaunch === true ? "已开启（随系统启动）" : "未开启（默认）"}</span>
                  </div>
                  <div className="text-xs text-sub">仅桌面版生效；Web 版无此能力</div>
                </div>
                {/* v3.5 常规设置（对齐 ZCode 常规设置项） */}
                <div className="space-y-2.5">
                  <Label text="任务与通知" hint="Agent 任务相关行为（写入 config.general 节）" />
                  {[
                    { key: "taskNotifications" as const, label: "任务完成通知", desc: "任务完成/失败时发送系统通知（仅桌面版；Web 版无系统通知能力）" },
                    { key: "notificationSound" as const, label: "通知声音", desc: "通知同时播放系统提示音" },
                    { key: "autoContinueQuestions" as const, label: "提问自动继续", desc: "Agent 提问 5 分钟未回答自动继续执行；关闭 = 一直等待你的回答（可随时中止任务）" },
                    { key: "showThinking" as const, label: "显示思考过程", desc: "对话流中显示模型思考折叠行（点击即时生效）" },
                    { key: "showTodos" as const, label: "显示待办列表", desc: "对话输入框上方显示任务清单面板（点击即时生效）" },
                    { key: "autoCommit" as const, label: "任务完成自动提交", desc: "git 仓库中任务成功且有改动时自动 git add -A + commit（消息=任务摘要，绝不 push；需已配置 git 身份；默认关）" },
                    { key: "autoVerify" as const, defaultOn: true, label: "写后自动验证", desc: "写文件/编辑文件成功后自动运行测试（自动检测框架，按会话去抖 60s），结果反馈给 Agent 及时修复（默认开）" },
                    { key: "autoArchive" as const, label: "自动归档旧会话", desc: "超过保留期的会话自动移入归档（不删除；侧栏「归档」可恢复）" },
                    { key: "compressArchivedEvents" as const, label: "归档事件压缩", desc: "归档超 30 天的会话事件压缩为「摘要 + 最近 200 条」，控制会话库长期膨胀（默认关——开启后继续被压缩会话时早期历史为摘要）" },
                  ].map(({ key, label, desc, defaultOn }) => (
                    <div key={key} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-elevated px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-text">{label}</div>
                        <div className="mt-0.5 text-xs leading-4 text-sub">{desc}</div>
                      </div>
                      <Toggle
                        checked={(general[key] ?? defaultOn) === true}
                        onChange={(v) => {
                          patch({ general: { ...general, [key]: v } });
                          if (key === "showThinking" || key === "showTodos") {
                            useStore.getState().setUiFlags({ showThinking: key === "showThinking" ? v : undefined, showTodos: key === "showTodos" ? v : undefined });
                          }
                        }}
                        title={(general[key] ?? defaultOn) === true ? "已开启" : "已关闭（默认）"}
                      />
                    </div>
                  ))}
                  {general.autoArchive === true && (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-elevated px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-text">归档保留期</div>
                        <div className="mt-0.5 text-xs leading-4 text-sub">N 天前未活动的会话自动归档（默认 7 天）</div>
                      </div>
                      <input
                        type="number"
                        min={1}
                        max={365}
                        className={`${inputCls} w-24`}
                        value={general.archiveRetentionDays ?? 7}
                        onChange={(e) => patch({ general: { ...general, archiveRetentionDays: Math.max(1, Math.min(365, Number(e.target.value) || 7)) } })}
                      />
                    </div>
                  )}
                  {[
                    { key: "closeToTray" as const, label: "关闭到托盘", desc: "点击窗口关闭按钮时最小化到系统托盘而非退出（仅桌面版；托盘菜单可退出）" },
                    { key: "preventSleep" as const, label: "运行中防休眠", desc: "Agent 任务运行时阻止系统进入睡眠（仅桌面版）" },
                  ].map(({ key, label, desc }) => (
                    <div key={key} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-elevated px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-text">{label}</div>
                        <div className="mt-0.5 text-xs leading-4 text-sub">{desc}</div>
                      </div>
                      <Toggle checked={general[key] === true} onChange={(v) => patch({ general: { ...general, [key]: v } })} title={general[key] === true ? "已开启" : "未开启（默认）"} />
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <Label text="默认模型" />
                  {/* v3.0 批 12：原生 select → 自定义下拉（与设置内其他下拉一致的面板样式） */}
                  <ModelDropdown
                    value={cfgDefaultModel ?? ""}
                    models={models}
                    onChange={(id) => patch({ defaultModelId: id || null })}
                  />
                  <div className="text-xs text-sub">「模型设置」Tab 提供完整角色路由；此处为全局默认（可空）</div>
                </div>
              </div>
            )}

            {tab === "appearance" && (
              <div className="space-y-6">
                <SectionTitle title="外观" desc="界面偏好（随配置持久化，跨浏览器一致）" />
                {/* v3 主题切换（主题方块） */}
                <div className="space-y-2">
                  <Label text="主题" />
                  <div className="flex gap-2">
                    {([
                      { id: "system", label: "跟随系统", Icon: MonitorCog },
                      { id: "dark", label: "深色", Icon: Moon },
                      { id: "light", label: "浅色", Icon: Sun },
                    ] as const).map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        className={`flex w-[150px] cursor-pointer flex-col items-center gap-1.5 rounded-2xl border p-3.5 transition-colors ${
                          theme === id ? "border-line bg-hover text-text" : "border-line text-sub hover:bg-hover/60 hover:text-text"
                        }`}
                        onClick={() => {
                          patch({ appearance: { ...appearance, theme: id } });
                          useStore.getState().setTheme(id); // 即时生效；保存后随配置持久化
                        }}
                      >
                        <Icon className="h-5 w-5" />
                        <span className="text-[13px] font-medium">{label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="text-xs text-sub">深色默认；跟随系统 = 随操作系统深浅自动切换；点击即时生效，保存后持久化</div>
                </div>
                <div className="space-y-2">
                  <Label text="界面字号" />
                  <div className="flex gap-2">
                    {(["xs", "sm", "base"] as const).map((f) => (
                      <button
                        key={f}
                        className={`h-7 cursor-pointer rounded-[14px] border px-3 text-[13px] transition-colors ${
                          fontSize === f ? "border-line bg-hover text-text" : "border-line text-sub hover:bg-hover/60 hover:text-text"
                        }`}
                        onClick={() => {
                          const next = { appearance: { ...appearance, fontSize: f } };
                          patch(next);
                          // v3.0 UI 审查：字号即时生效（与主题一致），保存后持久化
                          useStore.getState().setAppearance({ fontSize: f, streamCursor, theme });
                        }}
                      >
                        {f === "xs" ? "紧凑" : f === "sm" ? "标准" : "大"}
                      </button>
                    ))}
                  </div>
                  <div className="text-xs text-sub">整体界面缩放（含间距）；点击即时生效，保存后持久化</div>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-line p-3.5">
                  <div>
                    <div className="text-sm leading-[22px] text-text">流式输出光标</div>
                    <div className="mt-0.5 text-xs leading-[18px] text-sub">AI 流式回复时显示闪烁光标</div>
                  </div>
                  <Toggle
                    checked={streamCursor}
                    onChange={(v) => {
                      patch({ appearance: { ...appearance, streamCursor: v } });
                      // v3.0 UI 审查：光标开关即时生效（与主题一致），保存后持久化
                      useStore.getState().setAppearance({ fontSize, streamCursor: v, theme });
                    }}
                  />
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
            {tab === "subagent" && <AgentsPane />}
            {tab === "mcp" && <McpPane />}
            {tab === "hooks" && <HooksPane />}
            {tab === "browser" && <BrowserPane />}
            {tab === "memory" && <MemoryPane />}
            {tab === "stats" && <StatsPane />}
            {tab === "datadir" && <DataDirPane />}
            {tab === "audit" && <AuditPane />}
            {tab === "index" && <IndexPane />}
            {tab === "schedule" && <SchedulePane />}

            {tab === "commands" && (
              <div className="space-y-6">
                <SectionTitle title="命令" desc="审批策略：全局档位 + 工具级覆盖/禁用 + 命令白名单（Agent 工具调用与命令执行）" />

                {/* 新建命令（顶置）：快速加入命令白名单 */}
                <div className="space-y-2">
                  <Label text="命令白名单" hint="命中白名单的命令跳过高危命令审批（联网 requireExplicit 永不豁免）；* 匹配任意字符；新建的命令置顶" />
                  {!newCommandOpen ? (
                    <button
                      className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-xl border border-dashed border-line py-2 text-[13px] text-sub transition-colors hover:border-info/60 hover:text-info"
                      onClick={() => setNewCommandOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5" />新建命令
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 rounded-xl border border-info/40 bg-info-soft/50 p-2">
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
                        className="flex h-8 cursor-pointer items-center gap-1 rounded-lg bg-primary px-3 text-xs font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-50"
                        onClick={submitNewCommand}
                        disabled={!newCommandText.trim()}
                      >
                        <Check className="h-3.5 w-3.5" />添加
                      </button>
                      <button
                        className="h-8 cursor-pointer rounded-lg border border-line px-3 text-xs text-sub transition-colors hover:bg-hover hover:text-text"
                        onClick={() => { setNewCommandOpen(false); setNewCommandText(""); }}
                      >
                        取消
                      </button>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {allowlist.map((a, i) => (
                      <div key={`${a}-${i}`} className="flex items-center gap-2">
                        <span className="flex-1 rounded-lg border border-line bg-elevated px-2.5 py-1.5 font-mono text-xs text-text">{a}</span>
                        <button className="cursor-pointer rounded-lg p-1 text-sub hover:bg-hover hover:text-danger" onClick={() => patchPolicy({ commandAllowlist: allowlist.filter((_, j) => j !== i) })} title="删除">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {/* v2.10 批 9：内置默认白名单说明（只读命令自动放行，不弹窗） */}
                  <div className="mt-2 rounded-lg bg-hover/50 px-2.5 py-1.5 text-[11px] leading-4 text-caption">
                    内置默认放行（无需配置，不可删除）：只读查询（ls/pwd/date/whoami/which/echo 等）、git 只读（status/diff/log/show/branch 等）、版本查询（node --version 等）、包本地查询（npm ls 等）。以上命令执行不再弹窗。
                  </div>
                </div>

                <div className="space-y-2">
                  <Label text="全局审批档位" />
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(MODE_META) as ApprovalMode[]).map((m) => {
                      const ModeIcon = MODE_META[m].icon;
                      return (
                        <button
                          key={m}
                          className={`cursor-pointer rounded-xl border p-3 text-left transition-colors ${
                            policyMode === m ? "border-line bg-hover" : "border-line bg-elevated hover:bg-hover/60"
                          }`}
                          onClick={() => patchPolicy({ mode: m })}
                        >
                          <div className="flex items-center gap-1.5 text-[13px] font-medium text-text">
                            <span className={`h-2 w-2 rounded-full ${policyMode === m ? (m === "full" ? "bg-danger" : "bg-primary") : "bg-sub/50"}`} />
                            <ModeIcon className={`h-4 w-4 shrink-0 ${MODE_META[m].iconCls}`} />
                            {MODE_META[m].label}
                          </div>
                          <div className="mt-1 text-xs leading-5 text-sub">{MODE_META[m].desc}</div>
                        </button>
                      );
                    })}
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
                        <div className="flex items-center gap-1.5 text-xs text-sub">
                          禁用
                          <Toggle checked={o.disabled === true} onChange={(v) => updateOverride(i, { disabled: v })} />
                        </div>
                        <button className="cursor-pointer rounded-lg p-1 text-sub hover:bg-hover hover:text-danger" onClick={() => removeOverride(i)} title="删除">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    className="w-full cursor-pointer rounded-xl border border-dashed border-line py-2 text-[13px] text-sub transition-colors hover:border-info/60 hover:text-info"
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
                          className={`w-full cursor-pointer rounded-xl border p-2.5 text-left transition-colors ${
                            sandboxMode === m ? "border-line bg-hover" : "border-line bg-elevated hover:bg-hover/60"
                          }`}
                          onClick={() => patch({ sandbox: { ...sandbox, mode: m } })}
                        >
                          <div className="flex items-center gap-1.5 text-[13px] font-medium text-text">
                            <span className={`h-2 w-2 rounded-full ${sandboxMode === m ? "bg-primary" : "bg-sub/50"}`} />
                            {SANDBOX_META[m].label}
                            {unavailable && (
                              <span className="rounded border border-warn/40 bg-warn-soft px-1.5 py-px text-[11px] text-warn">当前机器不可用</span>
                            )}
                          </div>
                          <div className="mt-0.5 text-xs leading-5 text-sub">{SANDBOX_META[m].desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-line bg-elevated p-3 text-xs leading-5 text-sub">
                  <span className="text-text">高危命令红线：</span>
                  rm -rf / del /f / format / mkfs / dd if= 等删除/格式化类命令始终 high 级审批（命令白名单可豁免；
                  联网放行 requireExplicit 任何档位不豁免）；Web 终端（右下角）中的高危命令同样需人工确认。
                </div>
              </div>
            )}
          </div>

          {/* 底部操作条 */}
          <div className="flex shrink-0 items-center gap-3 border-t border-line px-6 py-3">
            <div className="min-w-0 flex-1 truncate text-xs text-caption">
              写入 ~/.infu/config.json（服务端白名单：仅设置节可写）；插件/技能/MCP/钩子实时生效
            </div>
            <div className="flex items-center gap-2">
              {saved && (
                <span className="flex items-center gap-1 text-xs text-success">
                  <Check className="h-3.5 w-3.5" />已保存
                </span>
              )}
              <CapsuleButton variant="outline" size="md" onClick={onClose}>
                取消
              </CapsuleButton>
              <CapsuleButton variant="primary" size="md" onClick={save} disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                保存设置
              </CapsuleButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <div className="text-[15px] font-medium text-text">{title}</div>
      <div className="mt-0.5 text-xs leading-[18px] text-sub">{desc}</div>
    </div>
  );
}

function Label({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-sm leading-[22px] text-text">{text}</span>
      {hint && <span className="text-xs text-sub/70">{hint}</span>}
    </div>
  );
}
