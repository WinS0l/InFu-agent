/**
 * v2.4 设置界面信息架构升级 — 内容面板集合
 *
 * 从独立弹窗（McpManagerModal / ExtensionsModal）抽取的内容区，内嵌进设置弹窗导航：
 *  - McpPane：MCP 服务器管理（列表/启停/探测/添加/两段式删除）
 *  - PluginsPane：插件管理（添加/启停/加载探测/删除）
 *  - SkillsPane：技能管理（SKILL.md 发现列表/添加显式引用/移除）
 *  - HooksPane：钩子总览（插件属性：preToolUse/postToolUse 聚合展示）
 *  - 各能力面板：MCP/插件/技能/子智能体/钩子/浏览器/记忆/统计/索引
 */

import { useEffect, useRef, useState } from "react";
import {
  Plus, Trash2, Loader2, RefreshCw, ChevronDown, ChevronRight, Check, Blocks, Pencil,
  Coins, MessageSquare, MessagesSquare, CalendarCheck, Flame, Sparkles, FolderOpen,
} from "lucide-react";
import {
  fetchMcpServers, addMcpServer, updateMcpServer, deleteMcpServer, probeMcpTools,
  fetchPlugins, addPlugin, updatePlugin, deletePlugin, probePlugin, generatePlugin,
  fetchSkills, addSkill, deleteSkill,
  fetchAgents, saveAgent, deleteAgent, type AgentInfo,
  fetchBrowserStatus, fetchMemory, updateConfig, clearBrowserData, fetchConfig, fetchStats, fetchIndexStatus, rebuildIndex,
  type McpServerInfo, type McpToolProbe, type PluginInfo, type PluginProbeResult, type SkillInfo,
  type BrowserStatus, type MemoryInfo, type UsageStats, type IndexStatus,
} from "../api";
import { useStore } from "../store";
import { apiFetch } from "../api";
import { Toggle } from "./ui";

/** 风险徽标颜色（low 绿 / medium 黄 / high 红；v3 语义色 token 化） */
export const RISK_STYLE: Record<string, string> = {
  low: "border-success/40 bg-success-soft text-success",
  medium: "border-warn/40 bg-warn-soft text-warn",
  high: "border-danger/40 bg-danger-soft text-danger",
};

const inputCls =
  "h-8 w-full rounded-lg border border-line bg-input px-2 font-mono text-xs text-text placeholder:text-caption focus:border-info/60 focus:outline-none";
const dashedAddCls =
  "flex w-full cursor-pointer items-center justify-center gap-1 rounded-xl border border-dashed border-line py-2 text-[13px] text-sub transition-colors hover:border-info/60 hover:text-info";

/** 错误横幅（面板内） */
export function PaneError({ error }: { error: string }) {
  if (!error) return null;
  return <div className="mb-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-1.5 text-xs text-danger">{error}</div>;
}

/** 分组标题（设置面板内） */
function SectionTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-2">
      <div className="text-sm font-semibold text-text">{title}</div>
      <div className="mt-0.5 text-[11px] text-sub">{desc}</div>
    </div>
  );
}

// ─────────────────────────── MCP 服务器 ───────────────────────────

interface McpProbeState { busy: boolean; tools?: McpToolProbe[]; error?: string }
interface McpAddForm { name: string; type: "stdio" | "http"; command: string; args: string; url: string; risk: string }
const EMPTY_MCP_FORM: McpAddForm = { name: "", type: "stdio", command: "", args: "", url: "", risk: "" };

export function McpPane() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<McpAddForm>(EMPTY_MCP_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<Record<string, McpProbeState>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = async () => setServers(await fetchMcpServers());
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  const submitAdd = async () => {
    const name = form.name.trim();
    if (!name) { setError("名称不能为空"); return; }
    const body: Record<string, unknown> = {
      id: name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""),
      name, type: form.type,
    };
    if (form.type === "stdio") {
      if (!form.command.trim()) { setError("stdio 类型需要启动命令（Windows 下 npx 需写 npx.cmd）"); return; }
      body.command = form.command.trim();
      if (form.args.trim()) body.args = form.args.split(",").map((a) => a.trim()).filter(Boolean);
    } else {
      if (!form.url.trim()) { setError("http 类型需要端点 URL"); return; }
      body.url = form.url.trim();
    }
    if (form.risk.trim()) {
      const ro: Record<string, "low" | "medium" | "high"> = {};
      for (const pair of form.risk.split(",")) {
        const [k, v] = pair.split(":").map((x) => x.trim());
        if (k && (v === "low" || v === "medium" || v === "high")) ro[k] = v;
      }
      if (Object.keys(ro).length) body.riskOverrides = ro;
    }
    setBusy(true); setError("");
    try {
      await addMcpServer(body);
      setForm(EMPTY_MCP_FORM); setAdding(false);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const toggleEnabled = async (s: McpServerInfo) => {
    setError("");
    try { await updateMcpServer(s.id, { enabled: !s.enabled }); await load(); }
    catch (e) { setError((e as Error).message); }
  };

  const runProbe = async (s: McpServerInfo) => {
    setProbe((p) => ({ ...p, [s.id]: { busy: true } }));
    setExpanded((prev) => new Set(prev).add(s.id));
    try {
      const tools = await probeMcpTools(s.id);
      setProbe((p) => ({ ...p, [s.id]: { busy: false, tools } }));
    } catch (e) {
      setProbe((p) => ({ ...p, [s.id]: { busy: false, error: (e as Error).message } }));
    }
  };

  const doDelete = async (s: McpServerInfo) => {
    setBusy(true); setError("");
    try { await deleteMcpServer(s.id); setConfirmId(null); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <PaneError error={error} />
      {!adding ? (
        <button className={dashedAddCls} onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />添加 MCP 服务器
        </button>
      ) : (
        <div className="rounded-lg border border-line bg-muted/40 p-3">
          <div className="mb-2 text-xs font-medium text-text">添加 MCP 服务器</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-sub">
              名称
              <input className={inputCls} value={form.name} placeholder="如 filesystem"
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="text-[11px] text-sub">
              类型
              <select
                className="h-8 w-full cursor-pointer rounded-md border border-line bg-muted px-2 text-xs text-text focus:border-accent focus:outline-none"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as "stdio" | "http" })}
              >
                <option value="stdio">stdio（本地进程）</option>
                <option value="http">http（远程端点）</option>
              </select>
            </label>
            {form.type === "stdio" ? (
              <>
                <label className="col-span-2 text-[11px] text-sub">
                  启动命令（Windows 下 npx 需写 npx.cmd）
                  <input className={inputCls} value={form.command} placeholder="如 npx.cmd"
                    onChange={(e) => setForm({ ...form, command: e.target.value })} />
                </label>
                <label className="col-span-2 text-[11px] text-sub">
                  命令参数（逗号分隔）
                  <input className={inputCls} value={form.args} placeholder="如 -y,@modelcontextprotocol/server-filesystem,C:\workspace"
                    onChange={(e) => setForm({ ...form, args: e.target.value })} />
                </label>
              </>
            ) : (
              <label className="col-span-2 text-[11px] text-sub">
                Streamable HTTP 端点 URL
                <input className={inputCls} value={form.url} placeholder="如 https://mcp.example.com/mcp"
                  onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </label>
            )}
            <label className="col-span-2 text-[11px] text-sub">
              风险覆盖（可选，默认所有工具 medium 审批；格式 工具名或前缀*:级别）
              <input className={inputCls} value={form.risk} placeholder="如 read*:low,write_file:high"
                onChange={(e) => setForm({ ...form, risk: e.target.value })} />
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
              onClick={submitAdd} disabled={busy}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}添加
            </button>
            <button
              className="h-7 cursor-pointer rounded-md border border-line px-3 text-xs text-sub transition-colors hover:text-text"
              onClick={() => { setAdding(false); setError(""); }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {servers.length === 0 && !adding ? (
        <div className="mt-6 text-center text-xs text-sub">
          暂无 MCP 服务器。
          <br />
          <span className="text-sub/70">
            示例：npx @modelcontextprotocol/server-filesystem（文件系统工具），或 infu mcp add 命令行添加
          </span>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {servers.map((s) => {
            const p = probe[s.id];
            const isOpen = expanded.has(s.id);
            return (
              <div key={s.id} className="rounded-lg border border-line bg-muted/30 p-3">
                <div className="flex items-center gap-2">
                  <button
                    className="cursor-pointer rounded p-0.5 text-sub transition-colors hover:text-text"
                    onClick={() => {
                      const next = new Set(expanded);
                      if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                      setExpanded(next);
                    }}
                    title={isOpen ? "收起" : "展开"}
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  <span className="text-sm font-medium text-text">{s.name}</span>
                  <span className="rounded border border-line bg-muted px-1 py-px font-mono text-[10px] text-sub">{s.type}</span>
                  <span className="font-mono text-[11px] text-sub">{s.id}</span>
                  <span className={`rounded px-1.5 py-px text-[10px] ${s.enabled ? "border border-accent/40 bg-accent/10 text-accent" : "border border-line bg-muted text-sub"}`}>
                    {s.enabled ? "已启用" : "已禁用"}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <Toggle checked={s.enabled} onChange={() => toggleEnabled(s)} title={s.enabled ? "禁用（不再注入工具）" : "启用"} />
                    <button
                      className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line px-2 text-[11px] text-sub transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                      onClick={() => runProbe(s)} disabled={!s.enabled || p?.busy}
                      title="连接并拉取工具列表"
                    >
                      {p?.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}工具
                    </button>
                    {confirmId === s.id ? (
                      <button
                        className="h-6 cursor-pointer rounded-md border border-danger/50 bg-danger/10 px-2 text-[11px] text-danger"
                        onClick={() => doDelete(s)} disabled={busy}
                      >
                        确认删除？
                      </button>
                    ) : (
                      <button className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger" onClick={() => setConfirmId(s.id)} title="删除服务器">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-1.5 pl-5 font-mono text-[11px] text-sub/80">
                  {s.type === "stdio"
                    ? `${s.command ?? ""} ${(s.args ?? []).join(" ")}`.trim() || "（未配置命令）"
                    : s.url ?? "（未配置 URL）"}
                  {s.riskOverrides && Object.keys(s.riskOverrides).length > 0 && (
                    <span className="ml-2 text-warn">
                      风险覆盖 {Object.entries(s.riskOverrides).map(([k, v]) => `${k}→${v}`).join("、")}
                    </span>
                  )}
                </div>
                {isOpen && (
                  <div className="mt-2 pl-5">
                    {!p ? (
                      <button className="text-[11px] text-accent hover:underline" onClick={() => runProbe(s)}>点击探测工具列表</button>
                    ) : p.busy ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-sub"><Loader2 className="h-3 w-3 animate-spin" /> 连接中…</div>
                    ) : p.error ? (
                      <div className="text-[11px] text-danger">连接失败：{p.error}</div>
                    ) : (
                      <div className="space-y-1">
                        <div className="text-[11px] text-sub">工具 {p.tools!.length} 个（默认 medium 审批，可配置 riskOverrides 覆盖）</div>
                        {p.tools!.map((t) => (
                          <div key={t.name} className="flex items-start gap-2 text-[11px] text-text">
                            <span className={`shrink-0 rounded border px-1 py-px text-[10px] ${RISK_STYLE[t.risk] ?? RISK_STYLE.medium}`}>{t.risk}</span>
                            <span className="font-mono">{t.name}</span>
                            {t.description && <span className="text-sub/70">— {t.description.slice(0, 90)}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-3 border-t border-line pt-2 text-[11px] text-sub/70">
        ⚠ MCP 服务器进程不受沙箱约束（配置即信任）；工具调用层默认需人工审批。CLI 等价命令：infu mcp add / list / remove / status
      </div>
    </div>
  );
}

// ─────────────────────────── 插件 ───────────────────────────

interface PluginProbeState { busy: boolean; result?: PluginProbeResult; error?: string }

export function PluginsPane() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [adding, setAdding] = useState(false);
  const [pId, setPId] = useState("");
  const [pPath, setPPath] = useState("");
  const [probe, setProbe] = useState<Record<string, PluginProbeState>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadPlugins = async () => setPlugins(await fetchPlugins());
  useEffect(() => { loadPlugins().catch((e) => setError((e as Error).message)); }, []);

  const submitAdd = async () => {
    const id = pId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!id || !pPath.trim()) { setError("id 与模块路径不能为空"); return; }
    setBusy(true); setError("");
    try {
      await addPlugin({ id, path: pPath.trim() });
      setPId(""); setPPath(""); setAdding(false);
      await loadPlugins();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const togglePlugin = async (p: PluginInfo) => {
    setError("");
    try { await updatePlugin(p.id, { enabled: !(p.enabled !== false) }); await loadPlugins(); }
    catch (e) { setError((e as Error).message); }
  };

  const runProbe = async (p: PluginInfo) => {
    setProbe((s) => ({ ...s, [p.id]: { busy: true } }));
    setExpanded((prev) => new Set(prev).add(p.id));
    try {
      const result = await probePlugin(p.id);
      setProbe((s) => ({ ...s, [p.id]: { busy: false, result } }));
    } catch (e) {
      setProbe((s) => ({ ...s, [p.id]: { busy: false, error: (e as Error).message } }));
    }
  };

  const doDelete = async (p: PluginInfo) => {
    setBusy(true); setError("");
    try { await deletePlugin(p.id); setConfirmId(null); await loadPlugins(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <PaneError error={error} />
      {!adding ? (
        <button className={dashedAddCls} onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />添加插件（JS 模块：工具/钩子/技能）
        </button>
      ) : (
        <div className="rounded-lg border border-line bg-muted/40 p-3">
          <div className="mb-2 text-xs font-medium text-text">添加插件</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-sub">
              插件 id（自动规范化）
              <input className={inputCls} value={pId} placeholder="如 my-tools"
                onChange={(e) => setPId(e.target.value)} />
            </label>
            <label className="text-[11px] text-sub">
              模块绝对路径（.ts/.mjs/.js，默认导出 PluginDef）
              <input className={inputCls} value={pPath} placeholder="C:\plugins\my-tools.mjs"
                onChange={(e) => setPPath(e.target.value)} />
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
              onClick={submitAdd} disabled={busy}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}添加
            </button>
            <button className="h-7 cursor-pointer rounded-md border border-line px-3 text-xs text-sub transition-colors hover:text-text"
              onClick={() => { setAdding(false); setError(""); }}>
              取消
            </button>
          </div>
        </div>
      )}

      {plugins.length === 0 && !adding ? (
        <div className="mt-6 text-center text-xs text-sub">
          暂无插件（可先用 CLI：infu plugin add，或参考 docs/PLUGINS.md 的插件协议）
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {plugins.map((p) => {
            const pr = probe[p.id];
            const isOpen = expanded.has(p.id);
            const enabled = p.enabled !== false;
            return (
              <div key={p.id} className="rounded-lg border border-line bg-muted/30 p-3">
                <div className="flex items-center gap-2">
                  <button
                    className="cursor-pointer rounded p-0.5 text-sub transition-colors hover:text-text"
                    onClick={() => {
                      const next = new Set(expanded);
                      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                      setExpanded(next);
                    }}
                    title={isOpen ? "收起" : "展开"}
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  <span className="text-sm font-medium text-text">{p.name ?? p.id}</span>
                  {p.builtin && (
                    <span className="rounded border border-accent/40 bg-accent/5 px-1.5 py-px text-[10px] text-accent" title="随 InFu 分发的官方插件">
                      内置{p.version ? ` v${p.version}` : ""}
                    </span>
                  )}
                  <span className={`rounded px-1.5 py-px text-[10px] ${enabled ? "border border-accent/40 bg-accent/10 text-accent" : "border border-line bg-muted text-sub"}`}>
                    {enabled ? "已启用" : "已禁用"}
                  </span>
                  {pr?.result && (
                    <span className="text-[10px] text-sub">
                      {pr.result.tools.length} 工具 · 钩子 pre×{pr.result.hooks.preToolUse} post×{pr.result.hooks.postToolUse}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <Toggle checked={enabled} onChange={() => togglePlugin(p)} title={enabled ? "禁用" : "启用"} />
                    <button
                      className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line px-2 text-[11px] text-sub transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                      onClick={() => runProbe(p)} disabled={!enabled || pr?.busy}
                      title="加载插件并列出工具/钩子"
                    >
                      {pr?.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}加载
                    </button>
                    {p.builtin ? null : (
                      confirmId === p.id ? (
                        <button
                          className="h-6 cursor-pointer rounded-md border border-danger/50 bg-danger/10 px-2 text-[11px] text-danger"
                          onClick={() => doDelete(p)} disabled={busy}
                        >
                          确认删除？
                        </button>
                      ) : (
                        <button className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger" onClick={() => setConfirmId(p.id)} title="删除插件">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )
                    )}
                  </div>
                </div>
                <div className="mt-1.5 pl-5 font-mono text-[11px] text-sub/80">{p.path}</div>
                {isOpen && (
                  <div className="mt-2 pl-5">
                    {!pr ? (
                      <button className="text-[11px] text-accent hover:underline" onClick={() => runProbe(p)}>点击加载，查看工具与钩子</button>
                    ) : pr.busy ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-sub"><Loader2 className="h-3 w-3 animate-spin" /> 加载中…</div>
                    ) : pr.error ? (
                      <div className="text-[11px] text-danger">加载失败：{pr.error}</div>
                    ) : (
                      <div className="space-y-1">
                        <div className="text-[11px] text-sub">
                          钩子：preToolUse ×{pr.result!.hooks.preToolUse} · postToolUse ×{pr.result!.hooks.postToolUse}（插件级，对所有工具生效）
                        </div>
                        {pr.result!.tools.map((t) => (
                          <div key={t.name} className="flex items-start gap-2 text-[11px] text-text">
                            <span className={`shrink-0 rounded border px-1 py-px text-[10px] ${RISK_STYLE[t.risk] ?? RISK_STYLE.medium}`}>{t.risk}</span>
                            <span className="font-mono">{t.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-3 border-t border-line pt-2 text-[11px] text-sub/70">
        ⚠ 插件代码在 Agent 进程内运行（配置即信任）；插件工具默认 medium 审批，钩子对所有工具生效（含 MCP）。
      </div>
    </div>
  );
}

// ─────────────────────────── 技能 ───────────────────────────

const LEVEL_STYLE: Record<string, string> = {
  user: "border-success/40 bg-success-soft text-success",
  project: "border-line bg-hover text-sub",
  config: "border-warn/40 bg-warn-soft text-warn",
  plugin: "border-info/40 bg-info-soft text-info",
  builtin: "border-info/40 bg-info-soft/60 text-info",
};
const LEVEL_LABEL: Record<string, string> = { user: "用户级", project: "项目级", config: "显式引用", plugin: "插件", builtin: "内置" };

export function SkillsPane() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [adding, setAdding] = useState(false);
  const [sName, setSName] = useState("");
  const [sPath, setSPath] = useState("");
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadSkills = async () => setSkills(await fetchSkills());
  useEffect(() => { loadSkills().catch((e) => setError((e as Error).message)); }, []);

  const submitAdd = async () => {
    const name = sName.trim();
    if (!name) { setError("技能名不能为空"); return; }
    setBusy(true); setError("");
    try {
      await addSkill({ name, path: sPath.trim() || undefined });
      setSName(""); setSPath(""); setAdding(false);
      await loadSkills();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const doDelete = async (s: SkillInfo) => {
    setBusy(true); setError("");
    try { await deleteSkill(s.name); setConfirmName(null); await loadSkills(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <PaneError error={error} />
      {!adding ? (
        <button className={dashedAddCls} onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />添加技能（SKILL.md 社区标准）
        </button>
      ) : (
        <div className="rounded-lg border border-line bg-muted/40 p-3">
          <div className="mb-2 text-xs font-medium text-text">添加技能</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-sub">
              技能名（与 SKILL.md frontmatter name 一致）
              <input className={inputCls} value={sName} placeholder="如 review-checklist"
                onChange={(e) => setSName(e.target.value)} />
            </label>
            <label className="text-[11px] text-sub">
              技能目录路径（可选；留空按 name 在用户/项目级查找）
              <input className={inputCls} value={sPath} placeholder="C:\skills\my-skill"
                onChange={(e) => setSPath(e.target.value)} />
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
              onClick={submitAdd} disabled={busy}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}添加
            </button>
            <button className="h-7 cursor-pointer rounded-md border border-line px-3 text-xs text-sub transition-colors hover:text-text"
              onClick={() => { setAdding(false); setError(""); }}>
              取消
            </button>
          </div>
        </div>
      )}

      {skills.length === 0 && !adding ? (
        <div className="mt-6 text-center text-xs text-sub">
          暂无可用技能（把 SKILL.md 放到 ~/.infu/skills/&lt;name&gt;/ 或项目 .infu/skills/&lt;name&gt;/ 自动发现；
          任务中模型可调用 use_skill 读取）
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {skills.map((s) => (
            <div key={s.name} className="rounded-lg border border-line bg-muted/30 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text">{s.name}</span>
                <span className={`rounded border px-1.5 py-px text-[10px] ${LEVEL_STYLE[s.level] ?? ""}`}>
                  {LEVEL_LABEL[s.level] ?? s.level}
                </span>
                <div className="ml-auto">
                  {s.level === "config" ? (
                    confirmName === s.name ? (
                      <button
                        className="h-6 cursor-pointer rounded-md border border-danger/50 bg-danger/10 px-2 text-[11px] text-danger"
                        onClick={() => doDelete(s)} disabled={busy}
                      >
                        确认移除引用？
                      </button>
                    ) : (
                      <button className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger" onClick={() => setConfirmName(s.name)} title="移除显式引用（不删除文件）">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )
                  ) : (
                    <span className="text-[10px] text-sub/70">自动发现（目录级，无需管理）</span>
                  )}
                </div>
              </div>
              <div className="mt-1.5 text-[11px] text-sub/80">{s.description}</div>
              <div className="mt-0.5 font-mono text-[10px] text-sub/60">{s.path}</div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 border-t border-line pt-2 text-[11px] text-sub/70">
        技能描述会自动注入 Agent 上下文，任务匹配时模型调用 use_skill 读取全文。
      </div>
    </div>
  );
}

// ─────────────────────────── 子智能体（v2.5）───────────────────────────

const AGENT_LEVEL_STYLE: Record<string, string> = {
  builtin: "border-info/40 bg-info-soft text-info",
  user: "border-accent/40 bg-accent/10 text-accent",
  project: "border-warn/40 bg-warn/10 text-warn",
};
const AGENT_LEVEL_LABEL: Record<string, string> = { builtin: "内置", user: "用户级", project: "项目级" };

/** 可注入子智能体的内置工具（delegate_task/mcp_register/plugin_add 架构级排除） */
const AGENT_TOOL_OPTIONS = [
  "read_file", "write_file", "edit_file", "search_code", "list_directory", "project_scan",
  "git_status", "git_diff", "run_test", "run_command", "use_skill",
];

interface AgentForm {
  name: string;
  level: "user" | "project";
  description: string;
  tools: string[];
  model: string;
  maxSteps: string;
  thinkingLevel: string;
  permission: "allow" | "ask";
  sandbox: "" | "off" | "soft" | "restricted";
  body: string;
}
const EMPTY_AGENT_FORM: AgentForm = {
  name: "", level: "user", description: "", tools: [],
  model: "", maxSteps: "", thinkingLevel: "", permission: "allow", sandbox: "", body: "",
};

/** 表单 → agent 文件 markdown（frontmatter + 正文） */
function buildAgentMarkdown(f: AgentForm): string {
  const fm: string[] = ["---", `description: ${f.description.trim()}`];
  if (f.tools.length) fm.push(`tools: ${f.tools.join(", ")}`);
  if (f.model.trim()) fm.push(`model: ${f.model.trim()}`);
  if (f.maxSteps.trim()) fm.push(`maxSteps: ${f.maxSteps.trim()}`);
  if (f.thinkingLevel.trim()) fm.push(`thinkingLevel: ${f.thinkingLevel.trim()}`);
  if (f.permission === "ask") fm.push("permission: ask");
  if (f.sandbox) fm.push(`sandbox: ${f.sandbox}`);
  return fm.join("\n") + "\n---\n\n" + f.body.trim();
}

/** 子智能体管理（agent 文件化定义：内置 > ~/.infu/agents > 项目 .infu/agents；可创建/编辑/删除） */
export function AgentsPane() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<AgentForm>(EMPTY_AGENT_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const models = useStore((s) => s.models);

  const load = async () => {
    setLoading(true);
    setError("");
    try { setAgents(await fetchAgents()); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const startCreate = () => { setForm(EMPTY_AGENT_FORM); setEditing(true); setError(""); };
  const startEdit = (a: AgentInfo) => {
    setForm({
      name: a.name,
      level: a.level === "project" ? "project" : "user",
      description: a.description,
      tools: a.tools ?? [],
      model: a.model ?? "",
      maxSteps: a.maxSteps ? String(a.maxSteps) : "",
      thinkingLevel: a.thinkingLevel ? String(a.thinkingLevel) : "",
      permission: a.permission === "ask" ? "ask" : "allow",
      sandbox: a.sandbox ?? "",
      body: a.body,
    });
    setEditing(true);
    setError("");
  };

  const submitSave = async () => {
    if (!form.name.trim()) { setError("名称不能为空"); return; }
    if (!form.description.trim()) { setError("描述不能为空（发现层摘要）"); return; }
    if (!form.body.trim()) { setError("角色提示词正文不能为空"); return; }
    setSaving(true);
    setError("");
    try {
      await saveAgent({ name: form.name.trim(), level: form.level, content: buildAgentMarkdown(form) });
      setEditing(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (a: AgentInfo) => {
    setSaving(true);
    setError("");
    try {
      await deleteAgent(a.name);
      setConfirmDel(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleTool = (t: string) =>
    setForm((f) => ({ ...f, tools: f.tools.includes(t) ? f.tools.filter((x) => x !== t) : [...f.tools, t] }));

  return (
    <div>
      <PaneError error={error} />
      {!editing ? (
        <button className={dashedAddCls} onClick={startCreate}>
          <Plus className="h-3.5 w-3.5" />新建子智能体（自定义工具 / 权限 / 沙箱 / 模型 / 推理强度）
        </button>
      ) : (
        <div className="rounded-lg border border-line bg-muted/40 p-3">
          <div className="mb-2 text-xs font-medium text-text">
            {form.name && agents.some((a) => a.name === form.name && a.level !== "builtin") ? `编辑子智能体「${form.name}」` : "新建子智能体"}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-sub">
              名称（= 文件名；delegate_task agent 参数引用）
              <input className={inputCls} value={form.name} placeholder="如 code-reviewer"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} spellCheck={false} />
            </label>
            <label className="text-[11px] text-sub">
              保存位置
              <select className={inputCls} value={form.level}
                onChange={(e) => setForm((f) => ({ ...f, level: e.target.value as "user" | "project" }))}>
                <option value="user">用户级（~/.infu/agents）</option>
                <option value="project">项目级（项目 .infu/agents）</option>
              </select>
            </label>
          </div>
          <label className="mt-2 block text-[11px] text-sub">
            描述（必填；发现层摘要，注入 Executor 上下文）
            <input className={inputCls} value={form.description} placeholder="只读审查代码质量，不修改文件"
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </label>
          <div className="mt-2 text-[11px] text-sub">
            工具白名单（不选 = 全部内置工具；仅勾选只读工具 = 委派免审批）
            <div className="mt-1 grid max-h-28 grid-cols-3 gap-1 overflow-y-auto">
              {AGENT_TOOL_OPTIONS.map((t) => (
                <button key={t}
                  className={`cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                    form.tools.includes(t)
                      ? "border-accent/50 bg-accent/15 text-accent"
                      : "border-line bg-muted text-sub/70 hover:text-text"
                  }`}
                  onClick={() => toggleTool(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-[11px] text-sub">
              内部工具权限
              <select className={inputCls} value={form.permission}
                onChange={(e) => setForm((f) => ({ ...f, permission: e.target.value as "allow" | "ask" }))}>
                <option value="allow">allow（继承委派授权，内部不逐个询问）</option>
                <option value="ask">ask（内部工具仍逐条审批）</option>
              </select>
            </label>
            <label className="text-[11px] text-sub">
              沙箱档位
              <select className={inputCls} value={form.sandbox}
                onChange={(e) => setForm((f) => ({ ...f, sandbox: e.target.value as AgentForm["sandbox"] }))}>
                <option value="">跟随全局设置</option>
                <option value="off">off（直连）</option>
                <option value="soft">soft（软沙箱）</option>
                <option value="restricted">restricted（L1.5 受限令牌）</option>
              </select>
            </label>
            <label className="text-[11px] text-sub">
              模型（缺省继承父级）
              <select className={inputCls} value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}>
                <option value="">继承父级模型</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}（{m.model}）</option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-sub">
              推理强度 / 步数（可选）
              <div className="flex gap-1">
                <select className={inputCls} value={form.thinkingLevel} title="思考级别（1-4）"
                  onChange={(e) => setForm((f) => ({ ...f, thinkingLevel: e.target.value }))}>
                  <option value="">思考级别：跟随全局</option>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>思考级别 {n}</option>)}
                </select>
                <input className={inputCls} value={form.maxSteps} placeholder="步数上限"
                  onChange={(e) => setForm((f) => ({ ...f, maxSteps: e.target.value }))} spellCheck={false} />
              </div>
            </label>
          </div>
          <label className="mt-2 block text-[11px] text-sub">
            角色提示词（正文 = 子智能体 system prompt；建议末尾约定输出格式与字数上限）
            <textarea className={`${inputCls} mt-1 h-28 w-full resize-y py-1.5`}
              value={form.body}
              placeholder={"你是资深代码审查员…\n完成后输出结构化摘要：结论 / 关键发现 / 建议，总字数不超过 2000 字。"}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} spellCheck={false} />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
              onClick={submitSave} disabled={saving}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}保存
            </button>
            <button className="h-7 cursor-pointer rounded-md border border-line px-3 text-xs text-sub transition-colors hover:text-text"
              onClick={() => { setEditing(false); setError(""); }}>
              取消
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-sub">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />正在加载子智能体…
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {agents.map((a) => (
            <div key={a.name} className="rounded-lg border border-line bg-muted/30 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text">{a.name}</span>
                <span className={`rounded border px-1.5 py-px text-[10px] ${AGENT_LEVEL_STYLE[a.level] ?? ""}`}>
                  {AGENT_LEVEL_LABEL[a.level] ?? a.level}
                </span>
                {a.model && (
                  <span className="rounded border border-line bg-muted px-1.5 py-px font-mono text-[10px] text-sub">模型 {a.model}</span>
                )}
                {a.permission === "ask" && (
                  <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-px text-[10px] text-warn">内部逐条审批</span>
                )}
                {a.sandbox && (
                  <span className="rounded border border-line bg-muted px-1.5 py-px font-mono text-[10px] text-sub">沙箱 {a.sandbox}</span>
                )}
                {a.maxSteps && (
                  <span className="rounded border border-line bg-muted px-1.5 py-px font-mono text-[10px] text-sub">≤{a.maxSteps} 步</span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  {a.level !== "builtin" ? (
                    <>
                      <button className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-accent"
                        onClick={() => startEdit(a)} title="编辑">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {confirmDel === a.name ? (
                        <button className="h-6 cursor-pointer rounded-md border border-danger/50 bg-danger/10 px-2 text-[11px] text-danger"
                          onClick={() => doDelete(a)} disabled={saving}>确认删除？</button>
                      ) : (
                        <button className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger"
                          onClick={() => setConfirmDel(a.name)} title="删除 agent 文件">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="text-[10px] text-sub/60">内置（不可编辑）</span>
                  )}
                </div>
              </div>
              <div className="mt-1.5 text-[11px] text-sub/80">{a.description}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <span className="text-[10px] text-sub/60">工具：</span>
                {a.tools && a.tools.length > 0 ? (
                  a.tools.map((t) => (
                    <span key={t} className="rounded border border-line bg-muted px-1.5 py-px font-mono text-[10px] text-sub/80">{t}</span>
                  ))
                ) : (
                  <span className="text-[10px] text-sub/60">全部内置工具（缺省）</span>
                )}
              </div>
              <div className="mt-1 font-mono text-[10px] text-sub/60">{a.path}</div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 border-t border-line pt-2 text-[11px] text-sub/70">
        agent 描述自动注入 Executor 上下文，模型用 delegate_task（agent 参数）委派执行；
        只读委派免审批，写能力委派需一次授权；子智能体不可再委派/自注册。
      </div>
    </div>
  );
}

// ─────────────────────────── 钩子总览 ───────────────────────────

interface HooksPaneItem {
  plugin: string;
  pre: number;
  post: number;
  busy: boolean;
  error?: string;
}

/** 钩子插件默认模板（新建钩子时预填；用户可自由编辑整个模块） */
const HOOK_PLUGIN_TEMPLATE = `/**
 * 钩子插件（设置界面创建；钩子是插件属性，对所有工具含 MCP 生效）
 * preToolUse：工具执行前调用——{ decision: "allow" } 放行（可返回 args 改参），{ decision: "block", reason } 拦截
 * postToolUse：工具执行后调用——可返回 { result } 改写回填模型的工具结果
 * 抛错放行不阻塞；代码在 Agent 进程内运行（配置即信任）
 */
export default {
  id: "my-hooks",
  name: "我的钩子",
  description: "设置界面创建的钩子插件",
  hooks: {
    preToolUse: async (input) => {
      // input: { tool, args, callId, risk, phase }
      console.log("[hook] pre:", input.tool, input.risk);
      return { decision: "allow" };
    },
    postToolUse: async (input) => {
      return {};
    },
  },
};
`;

/** 钩子总览：聚合所有已启用插件的 preToolUse/postToolUse（钩子是插件属性） */
export function HooksPane() {
  const [items, setItems] = useState<Record<string, HooksPaneItem>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 新建钩子表单
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("my-hooks");
  const [newCode, setNewCode] = useState(HOOK_PLUGIN_TEMPLATE);
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const plugins = await fetchPlugins();
      const enabled = plugins.filter((p) => p.enabled !== false);
      if (enabled.length === 0) {
        setItems({});
        setLoading(false);
        return;
      }
      const results = await Promise.all(
        enabled.map(async (p) => {
          setItems((s) => ({ ...s, [p.id]: { plugin: p.id, pre: 0, post: 0, busy: true } }));
          try {
            const r = await probePlugin(p.id);
            return { plugin: p.id, pre: r.hooks.preToolUse, post: r.hooks.postToolUse, busy: false } as HooksPaneItem;
          } catch (e) {
            return { plugin: p.id, pre: 0, post: 0, busy: false, error: (e as Error).message } as HooksPaneItem;
          }
        })
      );
      const next: Record<string, HooksPaneItem> = {};
      for (const r of results) next[r.plugin] = r;
      setItems(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  /** 提交新建钩子（生成插件文件 + 注册） */
  const submitCreate = async () => {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!id) { setCreateErr("插件 id 不能为空"); return; }
    if (!newCode.trim()) { setCreateErr("插件代码不能为空"); return; }
    setCreateBusy(true);
    setCreateErr("");
    try {
      const r = await generatePlugin({ id, code: newCode });
      setCreating(false);
      setNewId("my-hooks");
      setNewCode(HOOK_PLUGIN_TEMPLATE);
      await load();
      setError(`已生成钩子插件「${r.plugin}」→ ${r.path}（下一任务起对所有工具生效；可在「插件」页启停/删除）`);
    } catch (e) {
      setCreateErr((e as Error).message);
    } finally {
      setCreateBusy(false);
    }
  };

  const list = Object.values(items);
  const totalPre = list.reduce((acc, i) => acc + (i.error ? 0 : i.pre), 0);
  const totalPost = list.reduce((acc, i) => acc + (i.error ? 0 : i.post), 0);

  return (
    <div>
      <PaneError error={error} />
      {!creating ? (
        <button className={dashedAddCls} onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" />新建钩子（生成带钩子的插件并注册）
        </button>
      ) : (
        <div className="rounded-lg border border-line bg-muted/40 p-3">
          <div className="mb-2 text-xs font-medium text-text">新建钩子</div>
          {createErr && <div className="mb-2 text-xs text-danger">{createErr}</div>}
          <label className="block text-[11px] text-sub">
            插件 id（钩子属于插件；自动规范化）
            <input className={`${inputCls} mt-1`} value={newId} placeholder="如 my-hooks"
              onChange={(e) => setNewId(e.target.value)} spellCheck={false} />
          </label>
          <label className="mt-2 block text-[11px] text-sub">
            插件模块代码（默认含 preToolUse + postToolUse 模板，可编辑或自行扩展 tools/skills）
            <textarea
              className={`${inputCls} mt-1 h-52 w-full resize-y py-1.5 font-mono`}
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="mt-2 text-[11px] leading-relaxed text-sub/70">
            ⚠ 生成后写入 ~/.infu/plugins/&lt;id&gt;.mjs 并注册（配置即信任，代码在 Agent 进程内运行）；可到「插件」页启停/删除。
          </div>
          <div className="mt-2 flex gap-2">
            <button
              className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
              onClick={submitCreate} disabled={createBusy}
            >
              {createBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}生成并注册
            </button>
            <button
              className="h-7 cursor-pointer rounded-md border border-line px-3 text-xs text-sub transition-colors hover:text-text"
              onClick={() => { setCreating(false); setCreateErr(""); }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-sub">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />正在加载插件钩子…
        </div>
      ) : list.length === 0 ? (
        <div className="mt-6 text-center text-xs text-sub">
          暂无启用插件，因此没有钩子。
          <br />
          <span className="text-sub/70">点击上方「新建钩子」创建一个带钩子的插件；钩子对所有工具（含 MCP）生效。</span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-line bg-muted/30 p-3 text-[11px] leading-relaxed text-sub">
            <span className="text-text">共 {totalPre} 个 preToolUse · {totalPost} 个 postToolUse</span>
            <br />
            钩子是插件属性（函数式函数钩子）：preToolUse 可在工具执行前拦截/改参，postToolUse 可改写工具结果；抛错放行不阻塞。
          </div>
          {list.map((i) => (
            <div key={i.plugin} className="rounded-lg border border-line bg-muted/30 p-3">
              <div className="flex items-center gap-2">
                <Blocks className="h-3.5 w-3.5 text-accent" />
                <span className="text-sm font-medium text-text">{i.plugin}</span>
                {i.busy ? (
                  <span className="flex items-center gap-1 text-[11px] text-sub"><Loader2 className="h-3 w-3 animate-spin" />加载中…</span>
                ) : i.error ? (
                  <span className="text-[11px] text-danger">加载失败：{i.error}</span>
                ) : (
                  <>
                    <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10px] text-accent">preToolUse ×{i.pre}</span>
                    <span className="rounded border border-line bg-muted px-1.5 py-px text-[10px] text-sub">postToolUse ×{i.post}</span>
                  </>
                )}
              </div>
              {!i.busy && !i.error && i.pre === 0 && i.post === 0 && (
                <div className="mt-1.5 pl-5 text-[11px] text-sub/70">该插件未注册钩子（仅工具）</div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 border-t border-line pt-2 text-[11px] text-sub/70">
        「零插件配钩子」的独立 config 通道不在规划内（函数式统一：钩子 = 插件内 JS 函数）。
      </div>
    </div>
  );
}

// ─────────────────────────── 浏览器（browser-use）───────────────────────────

export function BrowserPane() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [headless, setHeadless] = useState(true);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [confirmClear, setConfirmClear] = useState<"cache" | "all" | null>(null);

  const load = async () => {
    const s = await fetchBrowserStatus();
    setStatus(s); setHeadless(s.headless); setPath(s.executablePath);
  };
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  const togglePlugin = async () => {
    setBusy(true); setError("");
    try { await updatePlugin("browser-use", { enabled: !(status?.pluginEnabled ?? true) }); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const save = async (next: { headless?: boolean; executablePath?: string }) => {
    setBusy(true); setError(""); setSaved("");
    try {
      await updateConfig({ browser: { headless: next.headless ?? headless, executablePath: next.executablePath ?? path } });
      await load(); setSaved("已保存"); setTimeout(() => setSaved(""), 2000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const doClear = async (scope: "cache" | "all") => {
    setBusy(true); setError(""); setConfirmClear(null);
    try { const msg = await clearBrowserData(scope); setSaved(msg); setTimeout(() => setSaved(""), 3000); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const enabled = status?.pluginEnabled ?? true;

  return (
    <div>
      <PaneError error={error} />
      {saved && <div className="mb-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">{saved}</div>}

      <SectionTitle title="浏览器控制" desc="启用 Browser Use 插件，让新会话可通过内置浏览器访问和操作网页" />

      <div className="space-y-2">
        <div className="flex items-center justify-between rounded-lg border border-line bg-muted/30 px-3 py-2.5">
          <div>
            <div className="text-xs text-text">开启内置浏览器控制</div>
            <div className="mt-0.5 text-[11px] text-sub">启用 browser-use 插件（browser_navigate / snapshot / click / fill / screenshot 等 7 个工具）</div>
          </div>
          <Toggle checked={enabled} onChange={() => void togglePlugin()} title={enabled ? "已开启" : "已关闭"} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-line bg-muted/30 px-3 py-2.5">
          <div>
            <div className="text-xs text-text">无头模式</div>
            <div className="mt-0.5 text-[11px] text-sub">关闭后有头可见（调试用）；开启则后台无头运行</div>
          </div>
          <Toggle checked={headless} onChange={() => { const v = !headless; setHeadless(v); save({ headless: v }); }} title={headless ? "无头" : "有头"} />
        </div>

        <div className="rounded-lg border border-line bg-muted/30 px-3 py-2.5">
          <div className="text-xs text-text">浏览器可执行文件路径</div>
          <div className="mt-0.5 text-[11px] text-sub">留空则自动探测（ms-playwright 缓存）；当前：{status?.chromiumPath ? (status.available ? "已找到" : "未找到") : "未探测"}</div>
          <div className="mt-2 flex gap-2">
            <input className={inputCls} value={path} placeholder="留空自动探测" onChange={(e) => setPath(e.target.value)} />
            <button className="h-8 shrink-0 cursor-pointer rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50" onClick={() => save({ executablePath: path.trim() })} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "保存"}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-5"><SectionTitle title="浏览器数据" desc="清除内置浏览器缓存与站点数据" /></div>

      <div className="space-y-2">
        <div className="flex items-center justify-between rounded-lg border border-line bg-muted/30 px-3 py-2.5">
          <div>
            <div className="text-xs text-text">清除内置浏览器缓存</div>
            <div className="mt-0.5 text-[11px] text-sub">清除 HTTP 缓存、Cache Storage 和 Service Worker，保留 Cookie 和本地站点数据</div>
          </div>
          <button className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-text transition-colors hover:border-accent hover:text-accent disabled:opacity-50" onClick={() => doClear("cache")} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "清除缓存"}
          </button>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-line bg-muted/30 px-3 py-2.5">
          <div>
            <div className="text-xs text-text">清除全部浏览器数据</div>
            <div className="mt-0.5 text-[11px] text-sub">删除 Cookie、站点数据和缓存。此操作不可撤销</div>
          </div>
          {confirmClear === "all" ? (
            <div className="flex gap-1">
              <button className="h-8 cursor-pointer rounded-md border border-danger/50 bg-danger/10 px-3 text-xs text-danger" onClick={() => doClear("all")} disabled={busy}>确认清除？</button>
              <button className="h-8 cursor-pointer rounded-md border border-line px-2 text-xs text-sub hover:text-text" onClick={() => setConfirmClear(null)}>取消</button>
            </div>
          ) : (
            <button className="h-8 cursor-pointer rounded-md border border-danger/40 px-3 text-xs text-danger transition-colors hover:bg-danger/10 disabled:opacity-50" onClick={() => setConfirmClear("all")} disabled={busy}>清除全部</button>
          )}
        </div>
      </div>

      <div className="mt-3 border-t border-line pt-2 text-[11px] text-sub/70">
        安全说明：browser_navigate 走联网门禁（默认断网，需人工审批放行）；click/type/fill 有页面副作用 → medium 审批；截图存 .infu/browser/ 目录。
      </div>
    </div>
  );
}

// ─────────────────────────── 记忆 ───────────────────────────

export function MemoryPane() {
  const [mem, setMem] = useState<MemoryInfo | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [autoSediment, setAutoSediment] = useState(true);
  useEffect(() => {
    fetchMemory().then(setMem).catch((e) => setError((e as Error).message));
    fetchConfig().then((c) => setAutoSediment(c.memory?.autoSediment !== false)).catch(() => {});
  }, []);

  const toggleSediment = async () => {
    const v = !autoSediment;
    setAutoSediment(v);
    try { await updateConfig({ memory: { autoSediment: v } }); }
    catch (e) { setError((e as Error).message); setAutoSediment(!v); }
  };

  const renderGroup = (label: string, dir: string, topics: MemoryInfo["global"]) => (
    <div className="rounded-lg border border-line bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-text">{label}</span>
        <span className="text-[10px] text-sub">{topics.length} 个主题</span>
      </div>
      <div className="mt-1 break-all font-mono text-[10px] text-sub/60">{dir}</div>
      {topics.length === 0 ? (
        <div className="mt-2 text-[11px] text-sub/60">暂无记忆（Agent 用 memory_write 写入后在此出现）</div>
      ) : (
        <div className="mt-2 space-y-1">
          {topics.map((t) => (
            <div key={t.name} className="rounded-md border border-line bg-muted/20">
              <button className="flex w-full cursor-pointer items-center gap-1 px-2 py-1.5 text-left text-xs text-text hover:bg-muted/40" onClick={() => setOpen(open === t.name ? null : t.name)}>
                {open === t.name ? <ChevronDown className="h-3 w-3 text-sub" /> : <ChevronRight className="h-3 w-3 text-sub" />}
                <span className="font-mono">{t.name}</span>
                <span className="truncate text-[10px] text-sub/70">{t.hint}</span>
              </button>
              {open === t.name && (
                <pre className="max-h-48 overflow-auto border-t border-line px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-text/80">{t.content}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <PaneError error={error} />
      <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-[11px] leading-relaxed text-sub">
        四层记忆：「必须遵守」INFU.md 指令 →「下次怎么干」全局/项目记忆（memory_read/write）→「总结」项目历史（.infu/history/ 自动沉淀）→「发生的事」会话历史。记忆由 Agent 在任务中主动读写。
      </div>

      <div className="mb-3 flex items-center justify-between rounded-lg border border-line bg-muted/30 px-3 py-2.5">
        <div>
          <div className="text-xs text-text">自动沉淀项目历史</div>
          <div className="mt-0.5 text-[11px] text-sub">任务完成后自动归档 .infu/history/（报告 + 改动概览）；关闭后不再自动记录</div>
        </div>
        <Toggle checked={autoSediment} onChange={() => void toggleSediment()} title={autoSediment ? "已开启" : "已关闭"} />
      </div>

      {mem?.instruction && (
        <div className="mb-3 rounded-lg border border-line bg-muted/30 p-3">
          <div className="text-xs font-semibold text-text">项目指令（INFU.md / AGENTS.md）</div>
          <div className="mt-1 break-all font-mono text-[10px] text-sub/60">{mem.instruction.path}</div>
          <pre className="mt-2 max-h-40 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap text-text/80">{mem.instruction.content}</pre>
        </div>
      )}
      <div className="space-y-3">
        {renderGroup("全局记忆（跨项目）", mem?.globalDir ?? "~/.infu/memory/", mem?.global ?? [])}
        {renderGroup("项目记忆（当前项目）", mem?.projectDir ?? "<root>/.infu/memory/", mem?.project ?? [])}
      </div>
      <div className="mt-3 border-t border-line pt-2 text-[11px] text-sub/70">
        memory_read / memory_write 工具：Agent 在任务中按需读记忆、把「值得下次复用」的稳定约定写入记忆（敏感凭据自动拦截）。
      </div>
    </div>
  );
}

// ─────────────────────────── 使用统计 ───────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + " 亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
  return String(n);
}

// v3.0 UI 审查：模型调色板（横向条形图同日多模型并列条 + 底部图例；按模型名哈希稳定分配）
const MODEL_COLORS = ["#22C55E", "#679EFE", "#F5A623", "#A78BFA", "#F472B6", "#34D399", "#F87171", "#38BDF8", "#FBBF24", "#E879F9"];
function modelColor(model: string): string {
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return MODEL_COLORS[h % MODEL_COLORS.length];
}

export function StatsPane() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState("");
  useEffect(() => { fetchStats(days).then(setStats).catch((e) => setError((e as Error).message)); }, [days]);

  // v3.0 UI 审查批 2：统计卡片改 ZCode 同款（图标 + label + value + sub）
  const card = (label: string, value: string, icon: React.ReactNode, sub?: string) => (
    <div className="min-w-0 rounded-lg border border-line bg-muted/30 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-sub">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 truncate text-lg font-semibold text-text">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[10px] text-sub/70">{sub}</div>}
    </div>
  );

  // v3.0 UI 审查批 2：横向条形图归一化基准 = 各日总量最大值（byModel 真实数据优先）
  const maxDayTotal = Math.max(1, ...(stats?.dailyTrend.map((d) => Math.max(d.tokens, d.byModel.reduce((s, m) => s + m.tokens, 0))) ?? [1]));
  // v3.3 补 12（用户拍板）：统一标尺 8.5 亿 tokens = 100%——按天趋势 Y 轴上限固定
  // 8.5 亿（不再随数据浮动），热力图色阶同样按 8.5 亿的比例分档（口径一致）：
  // 日常消耗（几万-几十万 ≈ 0.1% 以下）落在最浅档，真·重度（>1.7 亿）才深色
  const TOKEN_Y_MAX = 850_000_000;
  /** 热力图档位说明（i = 档位+1：i 1-5 对应 8.5 亿的 0-20%/20-40%/40-60%/60-80%/80-100%；i 0 = 无） */
  const LEVEL_HINTS = (i: number): string => {
    if (i === 0) return "无";
    const lo = fmtTokens((TOKEN_Y_MAX * ((i - 1) * 20)) / 100);
    const hi = i === 5 ? "∞" : fmtTokens((TOKEN_Y_MAX * (i * 20)) / 100);
    return `${lo} - ${hi}（${(i - 1) * 20}-${Math.min(100, i * 20)}%）`;
  };
  // 图例模型列表（去重，保持出现顺序，最多 6 个——ZCode 同款）
  const allModels = [...new Set(stats?.dailyTrend.flatMap((d) => d.byModel.map((m) => m.model)) ?? [])].slice(0, 6);
  const hasEstimated = stats?.dailyTrend.some((d) => d.estimated) ?? false;

  return (
    <div>
      <PaneError error={error} />
      <div className="mb-3 flex items-center justify-between">
        <SectionTitle title="时间范围" desc="" />
        <div className="flex gap-1">
          {[7, 30].map((d) => (
            <button key={d} className={days === d ? "h-7 cursor-pointer rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent" : "h-7 cursor-pointer rounded-md border border-line px-3 text-xs text-sub hover:text-text"} onClick={() => setDays(d)}>
              最近 {d} 天
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {card("tokens 用量", stats ? fmtTokens(stats.tokens) : "—", <Coins className="h-3.5 w-3.5 shrink-0" />)}
        {card("会话数量", stats ? String(stats.sessions) : "—", <MessagesSquare className="h-3.5 w-3.5 shrink-0" />)}
        {card("消息数量", stats ? String(stats.messages) : "—", <MessageSquare className="h-3.5 w-3.5 shrink-0" />)}
        {card("活跃天数", stats ? String(stats.activeDays) : "—", <CalendarCheck className="h-3.5 w-3.5 shrink-0" />)}
        {card("当前连续天数", stats ? String(stats.streak) : "—", <Flame className="h-3.5 w-3.5 shrink-0" />)}
        {card("最常用模型", stats?.topModel ? stats.topModel.model : "—", <Sparkles className="h-3.5 w-3.5 shrink-0" />, stats?.topModel ? "占比 " + stats.topModel.share + "%" : undefined)}
      </div>

      {stats && stats.dailyTrend.length > 0 && (
        <>
        {/* v3.0 审计后重写：活跃热力图改 ZCode 同款（GitHub 贡献图式）——
           横向周列（时间从左到右）、纵向周一~周日；5 级绿色色阶；
           色阶图例在标题行右侧横排「少 → 多」；hover 放大 + 提示；自动滚动到最新 */}
        <div className="mt-4">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-text">活跃热力图</div>
              <div className="mt-0.5 text-[11px] text-sub">方格颜色越深代表当日 Token 消耗越高</div>
            </div>
            {/* 色阶图例（ZCode 同款：标题右侧横排 少→多；v3.3 补 10：hover 显示各档 token 区间） */}
            <div className="flex shrink-0 items-center gap-1 pt-0.5 text-[10px] text-sub">
              <span className="mr-0.5">少</span>
              {[0.15, 0.35, 0.55, 0.75, 0.95].map((a, i) => (
                <span
                  key={a}
                  className="size-3.5 cursor-default rounded-[4px] border border-line transition-transform hover:scale-125"
                  style={{ background: `rgba(34,197,94,${a})` }}
                  title={`当日 Token：${LEVEL_HINTS(i + 1)}`}
                />
              ))}
              <span className="ml-0.5">多</span>
            </div>
          </div>
          <div className="rounded-lg border border-line bg-muted/30 p-3">
            {(() => {
              const fmtDate = (d: Date) =>
                `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              const byDate = new Map(stats.dailyTrend.map((d) => [d.date, d.tokens]));
              // v3.3 补 14（用户拍板）：热力图改 GitHub 贡献图式周列——列 = 自然周
              // （周一~周日），每周一新增一列；最后一列永远 = 最新一周（今天之后的日子为
              // 未来占位格——列不空）。32 周 ≈ 224 天（保持 18px 格子密度铺满卡片宽）
              const HM_WEEKS = 32;
              const now = new Date();
              const todayKey = fmtDate(now);
              const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
              const weeksArr = Array.from({ length: HM_WEEKS }, (_, w) => {
                const monday = new Date(
                  thisMonday.getFullYear(), thisMonday.getMonth(),
                  thisMonday.getDate() - (HM_WEEKS - 1 - w) * 7
                );
                const days = Array.from({ length: 7 }, (_, d) => {
                  const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + d);
                  const key = fmtDate(date);
                  return { date, tokens: byDate.get(key) ?? 0, future: key > todayKey };
                });
                return { monday, days };
              });
              // v3.3 补 12：色阶与按天趋势同标尺（8.5 亿 = 100% 等分 5 档）——
              // level = floor(当日 / 8.5亿 × 5)：日常消耗（几十万 ≈ 0.1% 以下）落最浅档，
              // 重度（>1.7 亿 = 20%）逐档加深；口径与趋势图 Y 轴一致（用户拍板）
              const levelBg = (tokens: number) => {
                if (tokens <= 0) return null;
                const lvl = Math.min(4, Math.floor((tokens / TOKEN_Y_MAX) * 5));
                return `rgba(34,197,94,${[0.15, 0.35, 0.55, 0.75, 0.95][lvl]})`;
              };
              return <HeatmapGrid weeks={weeksArr} levelBg={levelBg} fmtDate={fmtDate} />;
            })()}
          </div>
        </div>

        {/* v3.0 审计后重写：按天 Token 趋势（竖向堆叠柱状图）——
            用户定稿：日期轴完整显现（范围天数每天一个标签，今天最右）；
            柱 = 按范围天数均分槽位（30 天细柱 / 7 天粗柱），有数据的天在对应槽位出柱；
            柱内按模型分段着色；Y 轴隐藏（网格虚线分档）；图例在图表下方 3 列网格 */}
        <div className="mt-4">
          <SectionTitle
            title="按天 Token 趋势（模型色标区分）"
            desc={stats.dailyTrend.some((d) => !d.estimated) ? "真实模型返回用量（模型色板区分）" : "字符数/4 估算（无 usage 数据的旧会话）"}
          />
          <div className="rounded-lg border border-line bg-muted/30 p-3">
            {(() => {
              const gapCls = days <= 14 ? "gap-2" : "gap-px";
              const fmtShort = (date: string) => `${+date.slice(5, 7)}/${+date.slice(8, 10)}`;
              // 范围日期轴：i=0 最早 → days-1 = 今天（最右）
              const now = new Date();
              const rangeDates = Array.from({ length: days }, (_, i) => {
                const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i));
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              });
              const byDate = new Map(stats.dailyTrend.map((d) => [d.date, d]));
              return (
                <>
                  <div className="relative h-60">
                    {/* 水平网格虚线（0/25/50/75/100%——相对固定上限 8.5 亿） */}
                    {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                      <div key={f} className="absolute inset-x-0 border-t border-dashed border-line/50" style={{ bottom: `${f * 100}%` }} />
                    ))}
                    {/* v3.3 补 12：Y 轴上限固定 8.5 亿（用户拍板）刻度小标 */}
                    <div className="absolute right-0 top-0 z-10 rounded bg-ink/80 px-1 text-[10px] leading-4 text-caption">
                      100% = {fmtTokens(TOKEN_Y_MAX)}
                    </div>
                    {/* 柱区：槽位 = 范围天数均分（30 天细柱 / 7 天粗柱），有数据的天出柱 */}
                    <div className={`absolute inset-0 flex items-end px-1 ${gapCls}`}>
                      {rangeDates.map((date) => {
                        const d = byDate.get(date);
                        if (!d) return <div key={date} className="h-full min-w-0 flex-1" />;
                        const models = d.byModel.length > 0 ? d.byModel : [{ model: "", tokens: d.tokens }];
                        const dayTotal = models.reduce((s, m) => s + m.tokens, 0);
                        const tip =
                          `${d.date}：${fmtTokens(dayTotal)} tokens${d.estimated ? "（估算）" : ""}` +
                          models.filter((m) => m.model).map((m) => `\n${m.model}：${fmtTokens(m.tokens)} tokens`).join("");
                        return (
                          <div key={date} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={tip}>
                            <div
                              className="flex w-full flex-col overflow-hidden rounded-t-[3px]"
                              style={{ height: `${Math.max(0.5, (dayTotal / TOKEN_Y_MAX) * 100)}%` }}
                            >
                              {models.map((m, i) => (
                                <div
                                  key={i}
                                  style={{
                                    height: `${(m.tokens / dayTotal) * 100}%`,
                                    background: m.model ? modelColor(m.model) : "var(--color-accent)",
                                    opacity: m.model ? 1 : 0.65,
                                  }}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {/* 日期轴：7 天模式每天显示；30 天模式每隔 5 天一个（今天 8/16 必有，往前 8/11/8/6/8/1…） */}
                  <div className={`mt-1.5 flex px-1 ${gapCls}`}>
                    {rangeDates.map((date, i) => {
                      // i = 从最早往今天数；从今天往回数 = days-1-i；30 天模式 (days-1-i)%5===0（今天必显示）
                      const show = days <= 7 || (days - 1 - i) % 5 === 0;
                      return (
                        <div key={date} className="min-w-0 flex-1 text-center">
                          {show && (
                            <span className="whitespace-nowrap font-mono text-[9px] text-sub/60">{fmtShort(date)}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
            {/* 底部图例（3 列网格 色块 + 模型名；估算单条单独标注） */}
            <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1">
              {allModels.map((m) => (
                <div key={m} className="flex min-w-0 items-center gap-1.5 text-[11px] text-sub">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: modelColor(m) }} />
                  <span className="truncate">{m}</span>
                </div>
              ))}
              {hasEstimated && (
                <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-sub">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: "var(--color-accent)", opacity: 0.65 }} />
                  <span className="truncate">估算（旧数据）</span>
                </div>
              )}
            </div>
          </div>
        </div>
        </>
      )}

      {stats && stats.modelUsage.length > 0 && (
        <div className="mt-4">
          <SectionTitle title="模型用量" desc="" />
          <div className="space-y-1.5">
            {stats.modelUsage.map((m) => (
              <div key={m.model} className="rounded-lg border border-line bg-muted/30 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-text">{m.model}</span>
                  <span className="text-[11px] text-sub">{fmtTokens(m.tokens)} tokens · {m.share}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-muted">
                  <div className="h-1.5 rounded-full bg-accent" style={{ width: Math.min(100, m.share) + "%" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 热力图矩阵（v3.3 补 14 周列制：列 = 自然周（周一~周日，每周一新增一列），
 *  行 = 周一~周日；左端星期标签；最新一周永远在最右列（今天之后 = 未来浅底占位——列不空）；
 *  自动滚动到最新；18px 固定格子（GitHub 贡献图式）） */
function HeatmapGrid({ weeks, levelBg, fmtDate }: {
  weeks: Array<{ monday: Date; days: Array<{ date: Date; tokens: number; future: boolean }> }>;
  levelBg: (tokens: number) => string | null;
  fmtDate: (d: Date) => string;
}) {
  const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
  const scrollRef = useRef<HTMLDivElement>(null);
  // 自动滚动到最新（最右列 = 最新一周）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks]);
  return (
    <div className="flex items-stretch gap-[2px]">
      {/* 左侧星期标签（周一~周日，与格子同高 18px） */}
      <div className="flex shrink-0 flex-col gap-[2px]">
        {weekdays.map((w) => (
          <span key={w} className="flex h-[18px] w-5 items-center justify-center text-[10px] leading-none text-sub">
            {w}
          </span>
        ))}
      </div>
      {/* 周列区（32 周；每周一新增一列，自动滚动到最新周） */}
      <div ref={scrollRef} className="no-scrollbar flex min-w-0 flex-1 gap-[2px] overflow-x-auto">
        {weeks.map((week) => (
          <div key={fmtDate(week.monday)} className="flex shrink-0 flex-col gap-[2px]" title={`${fmtDate(week.monday)} 周`}>
            {week.days.map((day) => {
              if (day.future) {
                // 未来（本周今天之后）：浅底占位——最新一周列不空（用户拍板）
                return <div key={fmtDate(day.date)} className="h-[18px] w-[18px] rounded-[4px] border border-line/40 bg-muted/15" />;
              }
              const bg = levelBg(day.tokens);
              return (
                <div
                  key={fmtDate(day.date)}
                  className={`h-[18px] w-[18px] rounded-[4px] border transition-transform duration-150 hover:scale-110 ${
                    bg ? "border-line/70" : "border-line/60 bg-muted/40"
                  }`}
                  style={bg ? { background: bg } : undefined}
                  title={`${fmtDate(day.date)}：${fmtTokens(day.tokens)} tokens`}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── 索引库 ───────────────────────────

// ─────────────────────────── 数据存储（v3.5：根目录可选、内部结构固定） ───────────────────────────

interface DataDirInfo {
  dir: string;
  default: string;
  redirected: boolean;
}

/** 数据目录查看与迁移（对齐 ZCode「根目录可整体更换」）：
 *  迁移 = 复制到目标（旧目录保留备份）→ 旧主目录留 ~/.infu-redirect.json 指针 → 进程内即刻生效；
 *  内部结构（config.json/infu.db/projects/schedules/memory/skills/agents/plugins/logs）固定不可改。 */
export function DataDirPane() {
  const [info, setInfo] = useState<DataDirInfo | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState("");

  const load = () => {
    apiFetch("/api/data-dir")
      .then((r) => r.json())
      .then((d) => setInfo(d as DataDirInfo))
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const runMigrate = async (target: string) => {
    setBusy(true); setError(""); setNotice(""); setConfirming(false);
    try {
      const r = await apiFetch("/api/data-dir", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      });
      const res = (await r.json()) as { ok: boolean; message: string };
      if (!r.ok || !res.ok) {
        setError(res.message || "迁移失败");
      } else {
        setNotice(res.message);
        setManual("");
        await load();
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const pickDesktop = async () => {
    const d = window.infuDesktop;
    if (!d?.selectPaths) return;
    const dirs = await d.selectPaths({ directories: true });
    if (dirs && dirs.length > 0) {
      setPending(dirs[0]);
      setConfirming(true);
      setError("");
    }
  };

  return (
    <div>
      <PaneError error={error} />
      {notice && <div className="mb-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">{notice}</div>}
      <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-[11px] leading-relaxed text-sub">
        数据目录存放全部本地数据（配置 / 会话库 / 记忆 / 技能 / 插件 / 日志等）。迁移 = <span className="text-text">整体复制</span>
        到新位置（旧目录保留为备份），此后所有进程从新位置读取；内部结构固定不可拆分。
      </div>

      <div className="rounded-lg border border-line bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-text">数据目录</span>
          <span className={info?.redirected ? "rounded border border-warn/40 bg-warn/10 px-1.5 py-px text-[10px] text-warn" : "rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10px] text-accent"}>
            {info?.redirected ? "已迁移" : "默认位置"}
          </span>
        </div>
        <div className="mt-2 break-all font-mono text-[11px] text-text">{info?.dir ?? "加载中…"}</div>
        <div className="mt-1 text-[10px] text-sub/60">默认：{info?.default ?? "—"}</div>

        <button
          className="mt-3 flex h-8 cursor-pointer items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
          onClick={pickDesktop}
          disabled={busy || !window.infuDesktop?.selectPaths}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
          选择新位置…
        </button>
      </div>

      {!window.infuDesktop?.selectPaths && (
        <div className="mt-3 rounded-lg border border-line bg-muted/30 p-3">
          <div className="text-xs font-semibold text-text">手动输入路径（Web 版）</div>
          <div className="mt-2 flex gap-2">
            <input
              className={inputCls}
              placeholder="例如 D:\InFuData（须为空文件夹或不存在）"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button
              className="h-8 shrink-0 cursor-pointer rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
              disabled={busy || !manual.trim()}
              onClick={() => { setPending(manual.trim()); setConfirming(true); setError(""); }}
            >
              迁移到此处
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-3">
          <div className="text-xs font-semibold text-text">确认迁移数据目录？</div>
          <div className="mt-1 break-all font-mono text-[11px] text-text">{pending}</div>
          <div className="mt-1.5 text-[11px] leading-relaxed text-sub">
            将把当前数据目录整体复制到上述位置，旧目录完整保留（不删除任何数据）；复制完成后所有进程立即切换到新位置读取。
          </div>
          <div className="mt-2 flex gap-2">
            <button
              className="h-8 cursor-pointer rounded-md border border-danger/50 bg-danger-soft px-3 text-xs text-danger transition-colors hover:bg-danger-soft/70 disabled:opacity-50"
              disabled={busy}
              onClick={() => void runMigrate(pending)}
            >
              确认迁移
            </button>
            <button
              className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-sub transition-colors hover:text-text disabled:opacity-50"
              disabled={busy}
              onClick={() => { setConfirming(false); setPending(""); }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function IndexPane() {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => fetchIndexStatus().then(setStatus).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); }, []);

  const rebuild = async () => {
    setBusy(true); setError(""); setMsg("");
    try {
      const r = await rebuildIndex();
      setMsg("已重建索引：" + r.fileCount + " 个文件");
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const fmtTime = (t: number | null) => (t ? new Date(t).toLocaleString() : "—");
  const fmtSize = (b: number) => (b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(2) + " MB" : (b / 1024).toFixed(1) + " KB");

  return (
    <div>
      <PaneError error={error} />
      {msg && <div className="mb-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">{msg}</div>}
      <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-[11px] leading-relaxed text-sub">
        索引库：为项目建一份文件清单缓存（跳过 node_modules/.git/dist 等噪音目录），search_code 搜索时优先复用，大幅加速。语义检索（embedding）留待后续。
      </div>

      <div className="rounded-lg border border-line bg-muted/30 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-text">索引状态</span>
          <span className={status?.built ? "rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10px] text-accent" : "rounded border border-warn/40 bg-warn/10 px-1.5 py-px text-[10px] text-warn"}>
            {status?.built ? "已构建" : "未构建"}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-sub">
          <div>文件数：<span className="text-text">{status?.fileCount ?? "—"}</span></div>
          <div>大小：<span className="text-text">{status ? fmtSize(status.sizeBytes) : "—"}</span></div>
          <div>构建时间：<span className="text-text">{fmtTime(status?.builtAt ?? null)}</span></div>
        </div>
        {status?.path && <div className="mt-2 break-all font-mono text-[10px] text-sub/60">{status.path}</div>}
      </div>

      <button className="mt-3 flex h-8 cursor-pointer items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-3 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50" onClick={rebuild} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        {status?.built ? "重建索引" : "构建索引"}
      </button>
    </div>
  );
}


// ─────────────────────────── 定时任务（v3.0 批 11） ───────────────────────────

interface ScheduleItem {
  id: string;
  cron: string;
  prompt: string;
  root: string;
  enabled: boolean;
  lastRun?: string;
  lastStatus?: string;
  nextRun?: string;
}

/** 定时任务管理：列表 / 添加（cron + 任务描述）/ 启停 / 删除。
 *  无人值守审批语义：等价 CLI -y——low/medium 自动批准，联网/自注册等安全红线一律拒绝 */
export function SchedulePane() {
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cron, setCron] = useState("");
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  // v3.0 UI 审查：删除两段式（替代原生 window.confirm，与全站一致）
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = () => {
    apiFetch("/api/schedules")
      .then((r) => r.json())
      .then((list) => setItems(list as ScheduleItem[]))
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const add = async () => {
    if (!cron.trim() || !prompt.trim()) { setError("cron 与任务描述必填"); return; }
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cron: cron.trim(), prompt: prompt.trim() }),
      });
      const j = (await r.json()) as { ok: boolean; message: string };
      if (!j.ok) setError(j.message);
      else { setNotice(j.message); setCron(""); setPrompt(""); load(); }
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const toggle = async (it: ScheduleItem) => {
    await apiFetch(`/api/schedules/${it.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !it.enabled }),
    });
    load();
  };
  const remove = async (it: ScheduleItem) => {
    try {
      await apiFetch(`/api/schedules/${it.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
    setConfirmId(null);
  };

  return (
    <div>
      <SectionTitle
        title="定时任务"
        desc="按 cron 周期自动运行 Agent 任务。无人值守语义 = 等价 CLI -y：普通操作自动批准，联网 / 自注册等安全红线一律拒绝。"
      />
      <PaneError error={error} />
      {notice && <div className="mb-2 rounded-lg border border-success/30 bg-success-soft px-3 py-1.5 text-xs text-success">{notice}</div>}

      {/* 添加表单 */}
      <div className="mb-3 rounded-xl border border-line bg-hover/30 p-2.5">
        <div className="mb-2 text-xs font-medium text-text">添加任务</div>
        <div className="space-y-1.5">
          <input
            className="h-8 w-full rounded-lg border border-line bg-elevated px-2.5 text-xs text-text outline-none placeholder:text-caption focus:border-info/60"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="cron 表达式，如 */30 * * * *（每 30 分钟）/ 0 9 * * 1-5（工作日 9 点）"
            spellCheck={false}
          />
          <input
            className="h-8 w-full rounded-lg border border-line bg-elevated px-2.5 text-xs text-text outline-none placeholder:text-caption focus:border-info/60"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="任务描述，如：检查项目健康状态并汇报"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          />
          <button
            className="h-8 w-full cursor-pointer rounded-lg bg-primary text-xs font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void add()}
            disabled={busy}
          >
            {busy ? "添加中…" : "添加定时任务"}
          </button>
        </div>
      </div>

      {/* 列表 */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-line bg-hover/30 px-3 py-4 text-center text-xs text-caption">
          暂无定时任务——添加后服务自动按 cron 执行（需服务运行中）
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div key={it.id} className="rounded-xl border border-line bg-hover/30 p-2.5">
              <div className="flex items-center gap-2">
                <Toggle checked={it.enabled} onChange={() => void toggle(it)} title={it.enabled ? "暂停" : "启用"} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">{it.prompt}</span>
                {confirmId === it.id ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px]">
                    <span className="text-warn">确认删除？</span>
                    <button
                      className="cursor-pointer rounded-md border border-danger/40 bg-danger-soft px-1.5 py-0.5 text-danger transition-colors hover:bg-danger/15"
                      onClick={() => void remove(it)}
                    >
                      确定
                    </button>
                    <button
                      className="cursor-pointer rounded-md border border-line px-1.5 py-0.5 text-sub transition-colors hover:bg-hover hover:text-text"
                      onClick={() => setConfirmId(null)}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-sub transition-colors hover:bg-hover hover:text-danger"
                    onClick={() => setConfirmId(it.id)}
                  >
                    删除
                  </button>
                )}
              </div>
              <div className="mt-1.5 pl-10 text-[11px] leading-4 text-sub">
                <span className="font-mono text-info">{it.cron}</span>
                <span className="ml-2">{it.enabled ? "启用" : "暂停"}</span>
                <div className="truncate">
                  下次：{it.nextRun ? new Date(it.nextRun).toLocaleString("zh-CN") : "—"}
                  {it.lastRun ? ` · 上次：${new Date(it.lastRun).toLocaleString("zh-CN")}（${it.lastStatus ?? ""}）` : ""}
                </div>
                <div className="truncate text-caption">{it.root}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
