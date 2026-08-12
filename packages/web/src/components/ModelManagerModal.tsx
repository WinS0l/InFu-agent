import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Star, X, KeyRound, Loader2 } from "lucide-react";
import { useStore } from "../store";
import { fetchModels } from "../api";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseURL?: string;
  hasKey: boolean;
  isDefault: boolean;
}

const PROVIDERS = [
  "deepseek", "openai", "anthropic", "google", "zhipu", "qwen", "ollama", "custom",
];

interface FormState {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
}

const EMPTY_FORM: FormState = { id: "", name: "", provider: "deepseek", model: "", baseURL: "", apiKey: "" };

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

/** 模型管理弹窗（增删改查 + API Key + 设默认） */
export default function ModelManagerModal({ onClose }: { onClose: () => void }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    const data = await fetchModels();
    setModels(data.models ?? []);
  };

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, []);

  const submit = async () => {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      if (models.some((m) => m.id === form.id)) {
        await api(`/api/models/${encodeURIComponent(form.id)}`, "PUT", form);
      } else {
        await api("/api/models", "POST", form);
      }
      setForm(null);
      await load();
      useStore.getState().setModels((await fetchModels()).models ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[85vh] w-[560px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <KeyRound className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold">模型管理</span>
          <span className="text-[11px] text-sub">配置保存在本机 ~/.infu/config.json</span>
          <button className="ml-auto cursor-pointer text-sub transition-colors hover:text-text" onClick={onClose} title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}

          {/* 模型列表 */}
          <div className="mb-4 space-y-1.5">
            {models.length === 0 && <div className="text-xs text-sub/60">暂无模型，点击下方"添加模型"</div>}
            {models.map((m) => (
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
                    {m.provider}/{m.model}
                    {m.baseURL ? ` · ${m.baseURL}` : ""}
                  </div>
                </div>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${m.hasKey ? "bg-accent/15 text-accent" : "bg-warn/15 text-warn"}`}>
                  {m.hasKey ? "已配 Key" : "无 Key"}
                </span>
                <button
                  className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-text"
                  onClick={() => setForm({ id: m.id, name: m.name, provider: m.provider, model: m.model, baseURL: m.baseURL ?? "", apiKey: "" })}
                  title="编辑"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger"
                  onClick={() => remove(m.id)}
                  title="删除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* 添加/编辑表单 */}
          {form ? (
            <div className="rounded-md border border-accent/30 bg-muted/30 p-3">
              <div className="mb-2 text-xs font-semibold text-accent">
                {models.some((m) => m.id === form.id) ? "编辑模型" : "添加模型"}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] text-sub">
                  标识 id（唯一）
                  <input
                    className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 text-xs text-text disabled:opacity-40"
                    value={form.id}
                    disabled={models.some((m) => m.id === form.id)}
                    onChange={(e) => setForm({ ...form, id: e.target.value })}
                    placeholder="my-model"
                  />
                </label>
                <label className="text-[10px] text-sub">
                  显示名称
                  <input
                    className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 text-xs text-text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="我的模型"
                  />
                </label>
                <label className="text-[10px] text-sub">
                  供应商
                  <select
                    className="mt-0.5 w-full cursor-pointer rounded border border-line bg-muted px-2 py-1 text-xs text-text"
                    value={form.provider}
                    onChange={(e) => setForm({ ...form, provider: e.target.value })}
                  >
                    {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label className="text-[10px] text-sub">
                  模型 ID
                  <input
                    className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="deepseek-v4-flash"
                  />
                </label>
                <label className="col-span-2 text-[10px] text-sub">
                  API 地址（可选，custom 必填，通常以 /v1 结尾）
                  <input
                    className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text"
                    value={form.baseURL}
                    onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </label>
                <label className="col-span-2 text-[10px] text-sub">
                  API Key（留空保持不变；不填则用环境变量 INFU_{"<供应商>"}_API_KEY）
                  <input
                    type="password"
                    className="mt-0.5 w-full rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-text"
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    placeholder="sk-..."
                  />
                </label>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  className="cursor-pointer rounded border border-line px-3 py-1 text-xs text-sub transition-colors hover:text-text"
                  onClick={() => setForm(null)}
                >
                  取消
                </button>
                <button
                  className="flex cursor-pointer items-center gap-1 rounded bg-accent px-3 py-1 text-xs font-medium text-ink transition-colors hover:bg-accent/85 disabled:opacity-50"
                  onClick={submit}
                  disabled={busy || !form.id || !form.name || !form.model}
                >
                  {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                  保存
                </button>
              </div>
            </div>
          ) : (
            <button
              className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-md border border-dashed border-line py-2 text-xs text-sub transition-colors hover:border-accent hover:text-accent"
              onClick={() => setForm({ ...EMPTY_FORM })}
            >
              <Plus className="h-3.5 w-3.5" />
              添加模型
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
