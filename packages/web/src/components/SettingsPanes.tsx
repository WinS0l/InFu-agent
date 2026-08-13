/**
 * v2.4 设置界面信息架构升级 — 内容面板集合
 *
 * 从独立弹窗（McpManagerModal / ExtensionsModal）抽取的内容区，内嵌进设置弹窗导航：
 *  - McpPane：MCP 服务器管理（列表/启停/探测/添加/两段式删除）
 *  - PluginsPane：插件管理（添加/启停/加载探测/删除）
 *  - SkillsPane：技能管理（SKILL.md 发现列表/添加显式引用/移除）
 *  - HooksPane：钩子总览（插件属性：preToolUse/postToolUse 聚合展示）
 *  - ComingSoonPane：规划中功能的占位页（禁用态 + 徽标）
 */

import { useEffect, useState } from "react";
import {
  Plus, Trash2, Loader2, Plug, Puzzle, RefreshCw, ChevronDown, ChevronRight, Check, Blocks,
} from "lucide-react";
import {
  fetchMcpServers, addMcpServer, updateMcpServer, deleteMcpServer, probeMcpTools,
  fetchPlugins, addPlugin, updatePlugin, deletePlugin, probePlugin, generatePlugin,
  fetchSkills, addSkill, deleteSkill,
  type McpServerInfo, type McpToolProbe, type PluginInfo, type PluginProbeResult, type SkillInfo,
} from "../api";

/** 风险徽标颜色（low 绿 / medium 黄 / high 红，与运行绿设计一致；全站统一） */
export const RISK_STYLE: Record<string, string> = {
  low: "border-accent/40 bg-accent/10 text-accent",
  medium: "border-warn/40 bg-warn/10 text-warn",
  high: "border-danger/40 bg-danger/10 text-danger",
};

const inputCls =
  "h-8 w-full rounded-md border border-line bg-muted px-2 font-mono text-xs text-text placeholder:text-sub/60 focus:border-accent focus:outline-none";
const dashedAddCls =
  "flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-sub transition-colors hover:border-accent hover:text-accent";

/** 错误横幅（面板内） */
export function PaneError({ error }: { error: string }) {
  if (!error) return null;
  return <div className="mb-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger">{error}</div>;
}

/** 手写开关（与设置弹窗同款） */
function Toggle({ on, onChange, title }: { on: boolean; onChange: () => void; title?: string }) {
  return (
    <button
      className={`relative h-4 w-8 cursor-pointer rounded-full transition-colors ${on ? "bg-accent/70" : "bg-muted"}`}
      onClick={onChange}
      title={title}
    >
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-text transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
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
                    <Toggle on={s.enabled} onChange={() => toggleEnabled(s)} title={s.enabled ? "禁用（不再注入工具）" : "启用"} />
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
                  <span className="text-sm font-medium text-text">{p.id}</span>
                  <span className={`rounded px-1.5 py-px text-[10px] ${enabled ? "border border-accent/40 bg-accent/10 text-accent" : "border border-line bg-muted text-sub"}`}>
                    {enabled ? "已启用" : "已禁用"}
                  </span>
                  {pr?.result && (
                    <span className="text-[10px] text-sub">
                      {pr.result.tools.length} 工具 · 钩子 pre×{pr.result.hooks.preToolUse} post×{pr.result.hooks.postToolUse}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <Toggle on={enabled} onChange={() => togglePlugin(p)} title={enabled ? "禁用" : "启用"} />
                    <button
                      className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line px-2 text-[11px] text-sub transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                      onClick={() => runProbe(p)} disabled={!enabled || pr?.busy}
                      title="加载插件并列出工具/钩子"
                    >
                      {pr?.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}加载
                    </button>
                    {confirmId === p.id ? (
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
  user: "border-accent/40 bg-accent/10 text-accent",
  project: "border-line bg-muted text-sub",
  config: "border-warn/40 bg-warn/10 text-warn",
};
const LEVEL_LABEL: Record<string, string> = { user: "用户级", project: "项目级", config: "显式引用" };

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
            钩子是插件属性（opencode 式函数钩子）：preToolUse 可在工具执行前拦截/改参，postToolUse 可改写工具结果；抛错放行不阻塞。
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
        「零插件配钩子」的独立 config 通道不在规划内（opencode 式统一：钩子 = 插件内 JS 函数）。
      </div>
    </div>
  );
}

// ─────────────────────────── 规划中占位 ───────────────────────────

export function ComingSoonPane({ name, desc, roadmap }: { name: string; desc: string; roadmap: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="rounded-full border border-line bg-muted px-2.5 py-1 text-[10px] text-sub">
        <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" />
        规划中
      </div>
      <div className="text-sm font-semibold text-text">{name}</div>
      <div className="max-w-sm text-[11px] leading-relaxed text-sub">{desc}</div>
      <div className="max-w-sm font-mono text-[10px] text-sub/60">{roadmap}</div>
    </div>
  );
}

/** 顶部导航图标汇总（供设置弹窗使用） */
export { Plug, Puzzle };
