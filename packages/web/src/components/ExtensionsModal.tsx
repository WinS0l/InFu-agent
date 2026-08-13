import { useEffect, useState } from "react";
import {
  Plus, Trash2, X, Loader2, Puzzle, RefreshCw, ChevronDown, ChevronRight, Check,
} from "lucide-react";
import {
  fetchPlugins, addPlugin, updatePlugin, deletePlugin, probePlugin,
  fetchSkills, addSkill, deleteSkill,
  type PluginInfo, type PluginProbeResult, type SkillInfo,
} from "../api";

/** 风险徽标颜色（与 MCP 弹窗一致） */
const RISK_STYLE: Record<string, string> = {
  low: "border-accent/40 bg-accent/10 text-accent",
  medium: "border-warn/40 bg-warn/10 text-warn",
  high: "border-danger/40 bg-danger/10 text-danger",
};

/** 技能来源层级徽标 */
const LEVEL_STYLE: Record<string, string> = {
  user: "border-accent/40 bg-accent/10 text-accent",
  project: "border-line bg-muted text-sub",
  config: "border-warn/40 bg-warn/10 text-warn",
};
const LEVEL_LABEL: Record<string, string> = { user: "用户级", project: "项目级", config: "显式引用" };

interface ProbeState {
  busy: boolean;
  result?: PluginProbeResult;
  error?: string;
}

/** 扩展管理弹窗（v2.3 批 2：插件 = 工具/钩子/技能；skill = SKILL.md 社区标准） */
export default function ExtensionsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"plugins" | "skills">("plugins");
  // 插件
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [adding, setAdding] = useState(false);
  const [pId, setPId] = useState("");
  const [pPath, setPPath] = useState("");
  const [probe, setProbe] = useState<Record<string, ProbeState>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 技能
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [sAdding, setSAdding] = useState(false);
  const [sName, setSName] = useState("");
  const [sPath, setSPath] = useState("");
  const [skillErr, setSkillErr] = useState("");
  // 通用
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadPlugins = async () => setPlugins(await fetchPlugins());
  const loadSkills = async () => setSkills(await fetchSkills());

  useEffect(() => {
    Promise.all([loadPlugins(), loadSkills()]).catch((e) => setError((e as Error).message));
  }, []);

  // ── 插件操作 ──
  const submitAddPlugin = async () => {
    const id = pId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!id || !pPath.trim()) {
      setError("id 与模块路径不能为空");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await addPlugin({ id, path: pPath.trim() });
      setPId("");
      setPPath("");
      setAdding(false);
      await loadPlugins();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const togglePlugin = async (p: PluginInfo) => {
    setError("");
    try {
      await updatePlugin(p.id, { enabled: !p.enabled });
      await loadPlugins();
    } catch (e) {
      setError((e as Error).message);
    }
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

  const doDeletePlugin = async (p: PluginInfo) => {
    setBusy(true);
    setError("");
    try {
      await deletePlugin(p.id);
      setConfirmId(null);
      await loadPlugins();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ── 技能操作 ──
  const submitAddSkill = async () => {
    const name = sName.trim();
    if (!name) {
      setSkillErr("技能名不能为空");
      return;
    }
    setBusy(true);
    setSkillErr("");
    try {
      await addSkill({ name, path: sPath.trim() || undefined });
      setSName("");
      setSPath("");
      setSAdding(false);
      await loadSkills();
    } catch (e) {
      setSkillErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDeleteSkill = async (s: SkillInfo) => {
    setBusy(true);
    setSkillErr("");
    try {
      await deleteSkill(s.name);
      await loadSkills();
    } catch (e) {
      setSkillErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "h-8 w-full rounded-md border border-line bg-muted px-2 font-mono text-xs text-text placeholder:text-sub/60 focus:border-accent focus:outline-none";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[720px] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 + Tab */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-text">
            <Puzzle className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold">扩展管理</span>
            <span className="text-xs text-sub">插件（工具/钩子）· 技能（SKILL.md）</span>
          </div>
          <button
            className="cursor-pointer rounded p-1 text-sub transition-colors hover:bg-muted hover:text-text"
            onClick={onClose}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-1 border-b border-line px-4 pt-2">
          {(["plugins", "skills"] as const).map((t) => (
            <button
              key={t}
              className={`cursor-pointer rounded-t-md border-b-2 px-3 py-1.5 text-xs transition-colors ${
                tab === t ? "border-accent text-accent" : "border-transparent text-sub hover:text-text"
              }`}
              onClick={() => setTab(t)}
            >
              {t === "plugins" ? "插件" : "技能"}
            </button>
          ))}
        </div>

        {/* 错误横幅 */}
        {error && (
          <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {tab === "plugins" ? (
            <>
              {/* 添加插件 */}
              {!adding ? (
                <button
                  className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-sub transition-colors hover:border-accent hover:text-accent"
                  onClick={() => setAdding(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加插件（JS 模块：工具/钩子/技能）
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
                      onClick={submitAddPlugin}
                      disabled={busy}
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      添加
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

              {/* 插件列表 */}
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
                              if (next.has(p.id)) next.delete(p.id);
                              else next.add(p.id);
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
                          {/* 探测结果徽标 */}
                          {pr?.result && (
                            <span className="text-[10px] text-sub">
                              {pr.result.tools.length} 工具 · 钩子 pre×{pr.result.hooks.preToolUse} post×{pr.result.hooks.postToolUse}
                            </span>
                          )}
                          <div className="ml-auto flex items-center gap-1">
                            <button
                              className={`relative h-4 w-8 cursor-pointer rounded-full transition-colors ${enabled ? "bg-accent/70" : "bg-muted"}`}
                              onClick={() => togglePlugin(p)}
                              title={enabled ? "禁用" : "启用"}
                            >
                              <span
                                className={`absolute top-0.5 h-3 w-3 rounded-full bg-text transition-all ${enabled ? "left-[18px]" : "left-0.5"}`}
                              />
                            </button>
                            <button
                              className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line px-2 text-[11px] text-sub transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                              onClick={() => runProbe(p)}
                              disabled={!enabled || pr?.busy}
                              title="加载插件并列出工具/钩子"
                            >
                              {pr?.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                              加载
                            </button>
                            {confirmId === p.id ? (
                              <button
                                className="h-6 cursor-pointer rounded-md border border-danger/50 bg-danger/10 px-2 text-[11px] text-danger"
                                onClick={() => doDeletePlugin(p)}
                                disabled={busy}
                              >
                                确认删除？
                              </button>
                            ) : (
                              <button
                                className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger"
                                onClick={() => setConfirmId(p.id)}
                                title="删除插件"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="mt-1.5 pl-5 font-mono text-[11px] text-sub/80">{p.path}</div>
                        {/* 展开：探测详情 */}
                        {isOpen && (
                          <div className="mt-2 pl-5">
                            {!pr ? (
                              <button className="text-[11px] text-accent hover:underline" onClick={() => runProbe(p)}>
                                点击加载，查看工具与钩子
                              </button>
                            ) : pr.busy ? (
                              <div className="flex items-center gap-1.5 text-[11px] text-sub">
                                <Loader2 className="h-3 w-3 animate-spin" /> 加载中…
                              </div>
                            ) : pr.error ? (
                              <div className="text-[11px] text-danger">加载失败：{pr.error}</div>
                            ) : (
                              <div className="space-y-1">
                                <div className="text-[11px] text-sub">
                                  钩子：preToolUse ×{pr.result!.hooks.preToolUse} · postToolUse ×{pr.result!.hooks.postToolUse}
                                  （插件级，对所有工具生效）
                                </div>
                                {pr.result!.tools.map((t) => (
                                  <div key={t.name} className="flex items-start gap-2 text-[11px] text-text">
                                    <span className={`shrink-0 rounded border px-1 py-px text-[10px] ${RISK_STYLE[t.risk] ?? RISK_STYLE.medium}`}>
                                      {t.risk}
                                    </span>
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
            </>
          ) : (
            <>
              {/* 添加技能 */}
              {!sAdding ? (
                <button
                  className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-sub transition-colors hover:border-accent hover:text-accent"
                  onClick={() => setSAdding(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加技能（SKILL.md 社区标准）
                </button>
              ) : (
                <div className="rounded-lg border border-line bg-muted/40 p-3">
                  <div className="mb-2 text-xs font-medium text-text">添加技能</div>
                  {skillErr && <div className="mb-2 text-xs text-danger">{skillErr}</div>}
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
                      onClick={submitAddSkill}
                      disabled={busy}
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      添加
                    </button>
                    <button
                      className="h-7 cursor-pointer rounded-md border border-line px-3 text-xs text-sub transition-colors hover:text-text"
                      onClick={() => { setSAdding(false); setSkillErr(""); }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* 技能列表 */}
              {skills.length === 0 && !sAdding ? (
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
                            confirmId === s.name ? (
                              <button
                                className="h-6 cursor-pointer rounded-md border border-danger/50 bg-danger/10 px-2 text-[11px] text-danger"
                                onClick={() => doDeleteSkill(s)}
                                disabled={busy}
                              >
                                确认移除引用？
                              </button>
                            ) : (
                              <button
                                className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger"
                                onClick={() => setConfirmId(s.name)}
                                title="移除显式引用（不删除文件）"
                              >
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
            </>
          )}
        </div>

        {/* 底部提示 */}
        <div className="border-t border-line px-4 py-2 text-[11px] text-sub/70">
          ⚠ 插件代码在 Agent 进程内运行（配置即信任）；插件工具默认 medium 审批，钩子对所有工具生效（含 MCP）。
          技能描述会自动注入 Agent 上下文，任务匹配时模型调用 use_skill 读取全文。
        </div>
      </div>
    </div>
  );
}
