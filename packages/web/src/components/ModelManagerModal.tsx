import { useEffect, useState } from "react";
import {
  Plus, Pencil, Trash2, Star, X, KeyRound, Loader2, Server, Cpu, RefreshCw, Check, Workflow,
} from "lucide-react";
import { useStore } from "../store";
import { fetchModels, fetchProviders, addProvider, updateProvider, deleteProvider, fetchProviderModels, fetchRoles, saveRoles, type ProviderInfo, type RoleConfig } from "../api";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  providerId?: string;
  model: string;
  baseURL?: string;
  hasKey: boolean;
  isDefault: boolean;
  fallbackModelIds?: string[];
  contextWindow?: number;
  thinkingLevels?: number;
  thinkingOverride?: Array<Record<string, unknown> | null>;
}

/** 供应商类型模板（与后端 PROVIDER_TEMPLATES 对齐；选择时自动填 baseURL） */
const PROVIDER_TEMPLATES: Array<{ kind: string; label: string; baseURL: string; contextWindow: number; thinkingLevels: number }> = [
  { kind: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", contextWindow: 1_000_000, thinkingLevels: 3 },
  { kind: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", contextWindow: 1_000_000, thinkingLevels: 4 },
  { kind: "anthropic", label: "Anthropic（Claude）", baseURL: "https://api.anthropic.com/v1", contextWindow: 1_000_000, thinkingLevels: 4 },
  { kind: "google", label: "Google（Gemini）", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", contextWindow: 1_000_000, thinkingLevels: 4 },
  { kind: "zhipu", label: "智谱（GLM）", baseURL: "https://open.bigmodel.cn/api/paas/v4", contextWindow: 1_000_000, thinkingLevels: 4 },
  { kind: "qwen", label: "通义千问（Qwen）", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", contextWindow: 256_000, thinkingLevels: 1 },
  { kind: "custom", label: "自定义（Kimi 等）", baseURL: "https://api.moonshot.cn/v1", contextWindow: 256_000, thinkingLevels: 3 },
  { kind: "ollama", label: "本地（Ollama）", baseURL: "http://localhost:11434/v1", contextWindow: 128_000, thinkingLevels: 1 },
];

interface ProviderForm {
  id: string;
  name: string;
  kind: string;
  baseURL: string;
  apiKey: string;
}

interface ModelForm {
  id: string;
  name: string;
  model: string;
  providerId: string;
  contextWindow: string;
  thinkingLevels: string;
  /** 思考参数覆盖（JSON 数组，每档一组的请求字段；空 = 自动映射） */
  thinkingOverride: string;
  fallbackModelIds: string[];
}

async function api<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `请求失败: ${res.status}`);
  return data as T;
}

function fmtWin(n?: number): string {
  if (!n) return "自动";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/** 模型管理弹窗（v2：供应商凭据 + 上游模型 + 思考级别） */
export default function ModelManagerModal({ onClose }: { onClose: () => void }) {
  // 当前任务选择的模型（顶栏/输入框选择器；角色未指定时跟随它，而非 config 静态默认）
  const { modelId: currentModelId } = useStore();
  const [tab, setTab] = useState<"providers" | "models">("providers");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [pForm, setPForm] = useState<ProviderForm | null>(null);
  const [mForm, setMForm] = useState<ModelForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 上游模型列表 + 勾选（每个供应商的获取结果）
  const [upstream, setUpstream] = useState<{ providerId: string; list: Array<{ id: string; name: string }>; picked: Set<string> } | null>(null);
  // v2.3 角色路由面板：每角色 { model（空=跟随默认）, thinking（空=跟随全局） }
  const [roles, setRoles] = useState<Record<string, { model: string; thinking: number | null }>>({
    planner: { model: "", thinking: null },
    executor: { model: "", thinking: null },
    reviewer: { model: "", thinking: null },
  });
  const [rolesBusy, setRolesBusy] = useState(false);

  const load = async () => {
    const [p, m] = await Promise.all([fetchProviders(), fetchModels()]);
    setProviders(p);
    setModels(m.models ?? []);
    // 角色配置（面板初始化）
    fetchRoles()
      .then((rs: RoleConfig[]) => {
        const next: typeof roles = { planner: { model: "", thinking: null }, executor: { model: "", thinking: null }, reviewer: { model: "", thinking: null } };
        for (const r of rs) {
          if (next[r.role]) next[r.role] = { model: r.modelId ?? "", thinking: r.thinkingLevel ?? null };
        }
        setRoles(next);
      })
      .catch(() => {});
  };

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, []);

  // ── 供应商操作 ──
  const pickKind = (kind: string) => {
    const tpl = PROVIDER_TEMPLATES.find((t) => t.kind === kind);
    if (!pForm) return;
    setPForm({
      ...pForm,
      kind,
      baseURL: tpl?.baseURL ?? "",
      // 供应商 id 建议 = kind（重名时用户可改）
      id: pForm.id || kind,
      name: pForm.name || (tpl?.label ?? kind),
    });
  };

  const submitProvider = async () => {
    if (!pForm) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        id: pForm.id.trim(),
        name: pForm.name.trim(),
        kind: pForm.kind,
        ...(pForm.baseURL.trim() ? { baseURL: pForm.baseURL.trim() } : {}),
        ...(pForm.apiKey.trim() ? { apiKey: pForm.apiKey.trim() } : {}),
      };
      if (!body.id || !body.name) throw new Error("id/名称 不能为空");
      if (providers.some((p) => p.id === body.id)) {
        await updateProvider(body.id, { name: body.name, kind: body.kind, baseURL: body.baseURL, apiKey: body.apiKey });
      } else {
        await addProvider(body);
      }
      setPForm(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async (id: string) => {
    if (!confirm(`删除供应商 "${id}"？其下所有模型将一并删除。`)) return;
    try {
      await deleteProvider(id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 获取上游模型列表（勾选启用） */
  const fetchUpstream = async (p: ProviderInfo) => {
    setBusy(true);
    setError("");
    try {
      const list = await fetchProviderModels(p.id);
      const existing = new Set(models.filter((m) => m.providerId === p.id).map((m) => m.model));
      setUpstream({ providerId: p.id, list, picked: new Set(list.filter((m) => existing.has(m.id)).map((m) => m.id)) });
      if (!list.length) setError("上游返回空列表（确认 API Key 有效且端点支持 /models）");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 启用勾选的上游模型（模板预设匹配窗口/级别） */
  const enablePicked = async () => {
    if (!upstream) return;
    setBusy(true);
    setError("");
    try {
      const tpl = PROVIDER_TEMPLATES.find((t) => t.kind === providers.find((p) => p.id === upstream.providerId)?.kind);
      for (const m of upstream.list.filter((x) => upstream.picked.has(x.id))) {
        const exists = models.some((x) => x.providerId === upstream.providerId && x.model === m.id);
        if (exists) continue;
        const preset = tpl?.kind === "custom" ? undefined : undefined; // 预设窗口按 kind 模板兜底
        await api("/api/models", "POST", {
          id: `${upstream.providerId}-${m.id.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
          name: m.name || m.id,
          providerId: upstream.providerId,
          model: m.id,
          contextWindow: preset ?? tpl?.contextWindow,
          thinkingLevels: tpl?.thinkingLevels ?? 1,
        });
      }
      setUpstream(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ── 模型操作（沿用原弹窗逻辑 + thinkingLevels）──
  const submitModel = async () => {
    if (!mForm) return;
    setBusy(true);
    setError("");
    try {
      const cw = mForm.contextWindow.trim();
      const tl = mForm.thinkingLevels.trim();
      // 思考参数覆盖：JSON 数组解析（小众模型自定义每档参数；空 = 自动映射）
      let thinkingOverride: Array<Record<string, unknown> | null> | undefined;
      const to = mForm.thinkingOverride.trim();
      if (to) {
        try {
          const parsed = JSON.parse(to);
          if (!Array.isArray(parsed)) throw new Error("必须是数组");
          thinkingOverride = parsed.map((x: unknown) => (x == null ? null : x as Record<string, unknown>));
        } catch (e) {
          throw new Error(`思考参数覆盖格式错误：${(e as Error).message}（示例：[{"thinking":{"type":"disabled"}},{"thinking":{"type":"enabled"}},null]）`);
        }
      }
      const body = {
        id: mForm.id,
        name: mForm.name,
        providerId: mForm.providerId,
        model: mForm.model,
        contextWindow: cw ? Number(cw) : 0,
        thinkingLevels: tl ? Number(tl) : 0,
        thinkingOverride,
        fallbackModelIds: mForm.fallbackModelIds,
      };
      if (cw && (!Number.isFinite(Number(cw)) || Number(cw) <= 0)) throw new Error("上下文窗口必须是正整数（token 数）");
      if (tl && (!Number.isFinite(Number(tl)) || Number(tl) <= 0)) throw new Error("思考级别数必须是正整数");
      if (models.some((m) => m.id === mForm.id)) {
        await api(`/api/models/${encodeURIComponent(mForm.id)}`, "PUT", body);
      } else {
        await api("/api/models", "POST", body);
      }
      setMForm(null);
      await load();
      useStore.getState().setModels((await fetchModels()).models ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeModel = async (id: string) => {
    if (!confirm(`删除模型 "${id}"？`)) return;
    try {
      await api(`/api/models/${encodeURIComponent(id)}`, "DELETE");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setDefault = async (id: string) => {
    try {
      await api(`/api/models/${encodeURIComponent(id)}/default`, "POST");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 保存角色路由配置（每角色 模型 + 独立思考级别；空 = 清除该角色） */
  const saveRoleConfig = async () => {
    setRolesBusy(true);
    setError("");
    try {
      const body: Record<string, { model?: string; thinkingLevel?: number } | undefined> = {};
      for (const [role, v] of Object.entries(roles)) {
        if (!v.model && v.thinking == null) continue; // 全空 = 清除
        body[role] = {
          ...(v.model ? { model: v.model } : {}),
          ...(v.thinking != null ? { thinkingLevel: v.thinking } : {}),
        };
      }
      await saveRoles(body);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRolesBusy(false);
    }
  };

  const ROLE_LABELS: Record<string, { label: string; desc: string }> = {
    planner: { label: "规划", desc: "只读分析 + 制定计划" },
    executor: { label: "执行", desc: "全工具实施改动" },
    reviewer: { label: "审查", desc: "只读核查质量" },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[85vh] w-[680px] max-w-[94vw] flex-col rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <KeyRound className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold">模型管理</span>
          <span className="text-[11px] text-sub">供应商凭据 + 上游模型（~/.infu/config.json）</span>
          <button className="ml-auto cursor-pointer text-sub transition-colors hover:text-text" onClick={onClose} title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab 切换 */}
        <div className="flex gap-1 border-b border-line px-4 pt-2">
          {([["providers", "供应商", Server], ["models", "模型", Cpu]] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              className={`flex cursor-pointer items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs transition-colors ${
                tab === key ? "border-b-2 border-accent bg-accent/10 text-accent" : "text-sub hover:text-text"
              }`}
              onClick={() => setTab(key)}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
              {key === "models" && models.length > 0 && <span className="rounded bg-muted px-1 text-[9px]">{models.length}</span>}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}

          {tab === "providers" ? (
            <>
              {/* 供应商列表 */}
              <div className="mb-4 space-y-1.5">
                {providers.length === 0 && <div className="text-xs text-sub/60">暂无供应商，点击下方"添加供应商"（选择类型自动填 API 地址）</div>}
                {providers.map((p) => (
                  <div key={p.id} className="rounded-md border border-line bg-muted/50 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Server className="h-3.5 w-3.5 shrink-0 text-sub" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-text">
                          {p.name}
                          <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] text-accent">{p.kind}</span>
                        </div>
                        <div className="font-mono text-[10px] text-sub">
                          {p.baseURL ?? "（默认端点）"} · {p.modelCount} 个模型
                        </div>
                      </div>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${p.hasKey ? "bg-accent/15 text-accent" : "bg-warn/15 text-warn"}`}>
                        {p.hasKey ? "已配 Key" : "无 Key"}
                      </span>
                      <button
                        className="flex cursor-pointer items-center gap-1 rounded border border-line px-2 py-1 text-[10px] text-sub transition-colors hover:border-accent hover:text-accent"
                        onClick={() => fetchUpstream(p)}
                        disabled={busy}
                        title="从上游 /models 端点获取模型列表"
                      >
                        <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
                        获取模型
                      </button>
                      <button
                        className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-text"
                        onClick={() => setPForm({ id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL ?? "", apiKey: "" })}
                        title="编辑"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger"
                        onClick={() => removeProvider(p.id)}
                        title="删除（连带其模型）"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {/* 上游模型勾选面板 */}
                    {upstream?.providerId === p.id && (
                      <div className="mt-2 rounded-md border border-accent/25 bg-muted/30 p-2">
                        <div className="mb-1.5 text-[10px] font-semibold text-accent">
                          上游模型（{upstream.list.length} 个，勾选启用；已启用的自动勾选）
                        </div>
                        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                          {upstream.list.map((m) => {
                            const on = upstream.picked.has(m.id);
                            return (
                              <button
                                key={m.id}
                                className={`cursor-pointer rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                                  on ? "border-accent/60 bg-accent/15 text-accent" : "border-line bg-muted text-sub hover:border-sub/40"
                                }`}
                                onClick={() => {
                                  const picked = new Set(upstream.picked);
                                  if (on) picked.delete(m.id);
                                  else picked.add(m.id);
                                  setUpstream({ ...upstream, picked });
                                }}
                              >
                                {m.id}
                              </button>
                            );
                          })}
                        </div>
                        <div className="mt-2 flex justify-end gap-2">
                          <button className="cursor-pointer rounded border border-line px-2 py-1 text-[10px] text-sub hover:text-text" onClick={() => setUpstream(null)}>
                            取消
                          </button>
                          <button
                            className="flex cursor-pointer items-center gap-1 rounded bg-accent px-2 py-1 text-[10px] font-medium text-ink hover:bg-accent/85 disabled:opacity-50"
                            onClick={enablePicked}
                            disabled={busy || upstream.picked.size === 0}
                          >
                            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                            启用所选（{upstream.picked.size}）
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* 添加/编辑供应商表单（模板机制：选类型自动填 API 地址） */}
              {pForm ? (
                <div className="rounded-md border border-accent/30 bg-muted/30 p-3">
                  <div className="mb-2 text-xs font-semibold text-accent">{providers.some((p) => p.id === pForm.id) ? "编辑供应商" : "添加供应商"}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-sub">
                      供应商类型（模板）
                      <select
                        className="mt-0.5 w-full cursor-pointer rounded border border-line bg-muted px-2 py-1 text-xs text-text"
                        value={pForm.kind}
                        onChange={(e) => pickKind(e.target.value)}
                      >
                        {PROVIDER_TEMPLATES.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}
                      </select>
                    </label>
                    <label className="text-[10px] text-sub">
                      供应商 id（唯一）
                      <input
                        className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text disabled:opacity-40"
                        value={pForm.id}
                        disabled={providers.some((p) => p.id === pForm.id)}
                        onChange={(e) => setPForm({ ...pForm, id: e.target.value })}
                        placeholder="deepseek"
                      />
                    </label>
                    <label className="text-[10px] text-sub">
                      显示名称
                      <input
                        className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 text-xs text-text"
                        value={pForm.name}
                        onChange={(e) => setPForm({ ...pForm, name: e.target.value })}
                        placeholder="DeepSeek"
                      />
                    </label>
                    <label className="text-[10px] text-sub">
                      API 地址（已按模板自动填，可改）
                      <input
                        className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text"
                        value={pForm.baseURL}
                        onChange={(e) => setPForm({ ...pForm, baseURL: e.target.value })}
                        placeholder="https://api.example.com/v1"
                      />
                    </label>
                    <label className="col-span-2 text-[10px] text-sub">
                      API Key（留空用环境变量 INFU_{"<类型>"}_API_KEY）
                      <input
                        type="password"
                        className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text"
                        value={pForm.apiKey}
                        onChange={(e) => setPForm({ ...pForm, apiKey: e.target.value })}
                        placeholder="sk-..."
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button className="cursor-pointer rounded border border-line px-3 py-1 text-xs text-sub hover:text-text" onClick={() => setPForm(null)}>取消</button>
                    <button
                      className="flex cursor-pointer items-center gap-1 rounded bg-accent px-3 py-1 text-xs font-medium text-ink hover:bg-accent/85 disabled:opacity-50"
                      onClick={submitProvider}
                      disabled={busy || !pForm.id.trim() || !pForm.name.trim()}
                    >
                      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-md border border-dashed border-line py-2 text-xs text-sub transition-colors hover:border-accent hover:text-accent"
                  onClick={() => setPForm({ id: "", name: "", kind: "deepseek", baseURL: PROVIDER_TEMPLATES[0].baseURL, apiKey: "" })}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加供应商
                </button>
              )}
            </>
          ) : (
            <>
              {/* v2.3 角色路由面板：每角色 模型 + 独立思考级别（组合配置） */}
              <div className="mb-4 rounded-md border border-line bg-muted/30 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text">
                  <Workflow className="h-3.5 w-3.5 text-accent" />
                  角色路由
                  <span className="text-[10px] font-normal text-sub">规划 / 执行 / 审查 可分别用不同模型与思考级别（未设置跟随当前选择的模型 / 全局思考级别）</span>
                </div>
                <div className="space-y-2">
                  {(["planner", "executor", "reviewer"] as const).map((role) => {
                    const v = roles[role];
                    return (
                      <div key={role} className="flex items-center gap-2">
                        <div className="w-16 shrink-0">
                          <div className="text-[11px] font-medium text-text">{ROLE_LABELS[role].label}</div>
                          <div className="text-[9px] text-sub/60">{ROLE_LABELS[role].desc}</div>
                        </div>
                        <select
                          className="min-w-0 flex-1 cursor-pointer rounded-md border border-line bg-muted px-1.5 py-1 text-[10px] text-text transition-colors hover:border-accent/50"
                          value={v.model}
                          onChange={(e) => setRoles({ ...roles, [role]: { ...v, model: e.target.value } })}
                          title={`${ROLE_LABELS[role].label}阶段使用的模型`}
                        >
                          {/* 跟随当前任务选择的模型（非 config 静态默认） */}
                          <option value="">
                            跟随当前选择{currentModelId ? `（${models.find((m) => m.id === currentModelId)?.name ?? currentModelId}）` : ""}
                          </option>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}（{m.model}）
                            </option>
                          ))}
                        </select>
                        {/* 角色独立思考级别（空 = 跟随全局） */}
                        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-line bg-muted px-1 py-0.5">
                          <span className="px-1 text-[9px] text-sub/60">思考</span>
                          {[1, 2, 3, 4].map((lv) => (
                            <button
                              key={lv}
                              className={`h-5 w-5 cursor-pointer rounded text-[10px] font-medium transition-colors ${
                                v.thinking === lv ? "bg-accent/25 text-accent" : "text-sub/60 hover:text-text"
                              }`}
                              onClick={() => setRoles({ ...roles, [role]: { ...v, thinking: v.thinking === lv ? null : lv } })}
                              title={`思考级别 ${lv}（再次点击恢复跟随全局）`}
                            >
                              {lv}
                            </button>
                          ))}
                          <span className="px-1 text-[9px] text-sub/60">全局</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex justify-end">
                  <button
                    className="flex cursor-pointer items-center gap-1 rounded bg-accent px-3 py-1 text-[10px] font-medium text-ink hover:bg-accent/85 disabled:opacity-50"
                    onClick={saveRoleConfig}
                    disabled={rolesBusy}
                  >
                    {rolesBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    保存角色路由
                  </button>
                </div>
              </div>

              {/* 模型列表（v2：引用供应商；编辑含窗口/思考级别/备用模型） */}
              <div className="mb-4 space-y-1.5">
                {models.length === 0 && <div className="text-xs text-sub/60">暂无模型——先在「供应商」页添加供应商并「获取模型」勾选启用</div>}
                {models.map((m) => {
                  const p = providers.find((x) => x.id === m.providerId);
                  return (
                    <div key={m.id} className="flex items-center gap-2 rounded-md border border-line bg-muted/50 px-3 py-2">
                      <button
                        className="cursor-pointer text-sub transition-colors hover:text-warn"
                        onClick={() => setDefault(m.id)}
                        title={m.isDefault ? "默认模型" : "设为默认"}
                      >
                        <Star className={`h-3.5 w-3.5 ${m.isDefault ? "fill-warn text-warn" : ""}`} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-text">
                          {m.name}
                          {m.isDefault && <span className="ml-1.5 rounded bg-accent/20 px-1.5 py-0.5 text-[9px] text-accent">默认</span>}
                        </div>
                        <div className="font-mono text-[10px] text-sub">
                          {m.model}
                          <span className="text-sub/60"> · {p?.name ?? m.providerId ?? m.provider} · 窗口 {fmtWin(m.contextWindow)} · 思考 {m.thinkingLevels ?? "?"} 级</span>
                        </div>
                      </div>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${m.hasKey ? "bg-accent/15 text-accent" : "bg-warn/15 text-warn"}`}>
                        {m.hasKey ? "已配 Key" : "无 Key"}
                      </span>
                      <button
                        className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-text"
                        onClick={() =>
                          setMForm({
                            id: m.id, name: m.name, model: m.model,
                            providerId: m.providerId ?? p?.id ?? "",
                            contextWindow: m.contextWindow ? String(m.contextWindow) : "",
                            thinkingLevels: m.thinkingLevels ? String(m.thinkingLevels) : "",
                            thinkingOverride: m.thinkingOverride ? JSON.stringify(m.thinkingOverride) : "",
                            fallbackModelIds: m.fallbackModelIds ?? [],
                          })
                        }
                        title="编辑"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger" onClick={() => removeModel(m.id)} title="删除">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* 添加/编辑模型表单 */}
              {mForm ? (
                <div className="rounded-md border border-accent/30 bg-muted/30 p-3">
                  <div className="mb-2 text-xs font-semibold text-accent">{models.some((m) => m.id === mForm.id) ? "编辑模型" : "添加模型"}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-sub">
                      模型 id（唯一）
                      <input
                        className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text disabled:opacity-40"
                        value={mForm.id}
                        disabled={models.some((m) => m.id === mForm.id)}
                        onChange={(e) => setMForm({ ...mForm, id: e.target.value })}
                        placeholder="my-model"
                      />
                    </label>
                    <label className="text-[10px] text-sub">
                      显示名称
                      <input
                        className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 text-xs text-text"
                        value={mForm.name}
                        onChange={(e) => setMForm({ ...mForm, name: e.target.value })}
                      />
                    </label>
                    <label className="text-[10px] text-sub">
                      上游模型 ID
                      <input
                        className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text"
                        value={mForm.model}
                        onChange={(e) => setMForm({ ...mForm, model: e.target.value })}
                        placeholder="deepseek-v4-flash"
                      />
                    </label>
                    <label className="text-[10px] text-sub">
                      所属供应商
                      <select
                        className="mt-0.5 w-full cursor-pointer rounded border border-line bg-muted px-2 py-1 text-xs text-text"
                        value={mForm.providerId}
                        onChange={(e) => setMForm({ ...mForm, providerId: e.target.value })}
                      >
                        {providers.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.id}）</option>)}
                      </select>
                    </label>
                    <label className="text-[10px] text-sub">
                      上下文窗口（token，留空自动推断）
                      <input
                        type="number"
                        min={1}
                        className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text"
                        value={mForm.contextWindow}
                        onChange={(e) => setMForm({ ...mForm, contextWindow: e.target.value })}
                        placeholder="1000000"
                      />
                    </label>
                    <label className="text-[10px] text-sub">
                      思考级别数（1=无思考；模板默认）
                      <input
                        type="number"
                        min={1}
                        max={6}
                        className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text"
                        value={mForm.thinkingLevels}
                        onChange={(e) => setMForm({ ...mForm, thinkingLevels: e.target.value })}
                        placeholder="2"
                      />
                    </label>
                    {/* 小众模型思考参数覆盖（每档级别自定义请求字段；优先级高于供应商自动映射） */}
                    <label className="col-span-2 text-[10px] text-sub">
                      思考参数覆盖（可选，小众模型专用——数组第 i 项 = 第 i 级注入的请求字段，null = 该级不注入；留空 = 按供应商协议自动映射）
                      <textarea
                        rows={2}
                        className="mt-0.5 w-full resize-y rounded border border-line bg-muted px-2 py-1 font-mono text-[10px] text-text"
                        value={mForm.thinkingOverride}
                        onChange={(e) => setMForm({ ...mForm, thinkingOverride: e.target.value })}
                        placeholder='[{"thinking":{"type":"disabled"}},{"thinking":{"type":"enabled"}},null]'
                      />
                    </label>
                    <label className="col-span-2 text-[10px] text-sub">
                      备用模型（降级链，可多选）
                      {models.filter((x) => x.id !== mForm.id).length === 0 ? (
                        <div className="mt-0.5 text-[10px] text-sub/60">暂无其他模型</div>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {models.filter((x) => x.id !== mForm.id).map((x) => {
                            const on = mForm.fallbackModelIds.includes(x.id);
                            return (
                              <button
                                key={x.id}
                                type="button"
                                className={`cursor-pointer rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                                  on ? "border-accent/60 bg-accent/15 text-accent" : "border-line bg-muted text-sub hover:border-sub/40"
                                }`}
                                onClick={() =>
                                  setMForm({
                                    ...mForm,
                                    fallbackModelIds: on ? mForm.fallbackModelIds.filter((f) => f !== x.id) : [...mForm.fallbackModelIds, x.id],
                                  })
                                }
                              >
                                {x.name}（{x.id}）
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </label>
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button className="cursor-pointer rounded border border-line px-3 py-1 text-xs text-sub hover:text-text" onClick={() => setMForm(null)}>取消</button>
                    <button
                      className="flex cursor-pointer items-center gap-1 rounded bg-accent px-3 py-1 text-xs font-medium text-ink hover:bg-accent/85 disabled:opacity-50"
                      onClick={submitModel}
                      disabled={busy || !mForm.id || !mForm.name || !mForm.model || !mForm.providerId}
                    >
                      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-md border border-dashed border-line py-2 text-xs text-sub transition-colors hover:border-accent hover:text-accent"
                  onClick={() => setMForm({ id: "", name: "", model: "", providerId: providers[0]?.id ?? "", contextWindow: "", thinkingLevels: "", thinkingOverride: "", fallbackModelIds: [] })}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加模型
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
