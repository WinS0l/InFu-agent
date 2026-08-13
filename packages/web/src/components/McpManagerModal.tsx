import { useEffect, useState } from "react";
import {
  Plus, Trash2, X, Loader2, Plug, RefreshCw, ChevronDown, ChevronRight, Check,
} from "lucide-react";
import {
  fetchMcpServers, addMcpServer, updateMcpServer, deleteMcpServer, probeMcpTools,
  type McpServerInfo, type McpToolProbe,
} from "../api";

/** 风险徽标颜色（low 绿 / medium 黄 / high 红，与运行绿设计一致） */
const RISK_STYLE: Record<string, string> = {
  low: "border-accent/40 bg-accent/10 text-accent",
  medium: "border-warn/40 bg-warn/10 text-warn",
  high: "border-danger/40 bg-danger/10 text-danger",
};

interface ProbeState {
  busy: boolean;
  tools?: McpToolProbe[];
  error?: string;
}

/** 添加表单 */
interface AddForm {
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  risk: string; // key:value,key2:value2
}

const EMPTY_FORM: AddForm = { name: "", type: "stdio", command: "", args: "", url: "", risk: "" };

/** MCP 服务器管理弹窗（v2.3：MCP 客户端作为第一个插件类型） */
export default function McpManagerModal({ onClose }: { onClose: () => void }) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<Record<string, ProbeState>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 展开工具列表的服务器 id
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = async () => {
    const list = await fetchMcpServers();
    setServers(list);
  };

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, []);

  // ── 添加 ──
  const submitAdd = async () => {
    const name = form.name.trim();
    if (!name) {
      setError("名称不能为空");
      return;
    }
    const body: Record<string, unknown> = {
      id: name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""),
      name,
      type: form.type,
    };
    if (form.type === "stdio") {
      if (!form.command.trim()) {
        setError("stdio 类型需要启动命令（Windows 下 npx 需写 npx.cmd）");
        return;
      }
      body.command = form.command.trim();
      if (form.args.trim()) body.args = form.args.split(",").map((a) => a.trim()).filter(Boolean);
    } else {
      if (!form.url.trim()) {
        setError("http 类型需要端点 URL");
        return;
      }
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
    setBusy(true);
    setError("");
    try {
      await addMcpServer(body);
      setForm(EMPTY_FORM);
      setAdding(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ── 启用/禁用开关 ──
  const toggleEnabled = async (s: McpServerInfo) => {
    setError("");
    try {
      await updateMcpServer(s.id, { enabled: !s.enabled });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // ── 探测（连接 + 拉取工具列表）──
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

  // ── 删除（两段式确认）──
  const doDelete = async (s: McpServerInfo) => {
    setBusy(true);
    setError("");
    try {
      await deleteMcpServer(s.id);
      setConfirmId(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
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
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-text">
            <Plug className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold">MCP 服务器管理</span>
            <span className="text-xs text-sub">工具动态注入执行阶段（默认 medium 审批）</span>
          </div>
          <button
            className="cursor-pointer rounded p-1 text-sub transition-colors hover:bg-muted hover:text-text"
            onClick={onClose}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 错误横幅 */}
        {error && (
          <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div>
        )}

        {/* 主体 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* 添加按钮 / 表单 */}
          {!adding ? (
            <button
              className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-sub transition-colors hover:border-accent hover:text-accent"
              onClick={() => setAdding(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              添加 MCP 服务器
            </button>
          ) : (
            <div className="rounded-lg border border-line bg-muted/40 p-3">
              <div className="mb-2 text-xs font-medium text-text">添加 MCP 服务器</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-1 text-[11px] text-sub">
                  名称
                  <input className={inputCls} value={form.name} placeholder="如 filesystem"
                    onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </label>
                <label className="col-span-1 text-[11px] text-sub">
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
                      <input className={inputCls} value={form.args} placeholder='如 -y,@modelcontextprotocol/server-filesystem,C:\workspace'
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
                  onClick={submitAdd}
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

          {/* 服务器列表 */}
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
                const hasProbe = !!p;
                return (
                  <div key={s.id} className="rounded-lg border border-line bg-muted/30 p-3">
                    <div className="flex items-center gap-2">
                      <button
                        className="cursor-pointer rounded p-0.5 text-sub transition-colors hover:text-text"
                        onClick={() => {
                          const next = new Set(expanded);
                          if (next.has(s.id)) next.delete(s.id);
                          else next.add(s.id);
                          setExpanded(next);
                        }}
                        title={isOpen ? "收起" : "展开"}
                      >
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                      <span className="text-sm font-medium text-text">{s.name}</span>
                      <span className="rounded border border-line bg-muted px-1 py-px font-mono text-[10px] text-sub">
                        {s.type}
                      </span>
                      <span className="font-mono text-[11px] text-sub">{s.id}</span>
                      <span className={`rounded px-1.5 py-px text-[10px] ${s.enabled ? "border border-accent/40 bg-accent/10 text-accent" : "border border-line bg-muted text-sub"}`}>
                        {s.enabled ? "已启用" : "已禁用"}
                      </span>
                      <div className="ml-auto flex items-center gap-1">
                        {/* 启用开关 */}
                        <button
                          className={`relative h-4 w-8 cursor-pointer rounded-full transition-colors ${s.enabled ? "bg-accent/70" : "bg-muted"}`}
                          onClick={() => toggleEnabled(s)}
                          title={s.enabled ? "禁用（不再注入工具）" : "启用"}
                        >
                          <span
                            className={`absolute top-0.5 h-3 w-3 rounded-full bg-text transition-all ${s.enabled ? "left-[18px]" : "left-0.5"}`}
                          />
                        </button>
                        {/* 探测 */}
                        <button
                          className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line px-2 text-[11px] text-sub transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                          onClick={() => runProbe(s)}
                          disabled={!s.enabled || p?.busy}
                          title="连接并拉取工具列表"
                        >
                          {p?.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                          工具
                        </button>
                        {/* 删除（两段式） */}
                        {confirmId === s.id ? (
                          <button
                            className="h-6 cursor-pointer rounded-md border border-danger/50 bg-danger/10 px-2 text-[11px] text-danger"
                            onClick={() => doDelete(s)}
                            disabled={busy}
                          >
                            确认删除？
                          </button>
                        ) : (
                          <button
                            className="cursor-pointer rounded p-1 text-sub transition-colors hover:text-danger"
                            onClick={() => setConfirmId(s.id)}
                            title="删除服务器"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    {/* 连接信息 */}
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
                    {/* 展开：工具列表 */}
                    {isOpen && (
                      <div className="mt-2 pl-5">
                        {!hasProbe ? (
                          <button
                            className="text-[11px] text-accent hover:underline"
                            onClick={() => runProbe(s)}
                          >
                            点击探测工具列表
                          </button>
                        ) : p?.busy ? (
                          <div className="flex items-center gap-1.5 text-[11px] text-sub">
                            <Loader2 className="h-3 w-3 animate-spin" /> 连接中…
                          </div>
                        ) : p?.error ? (
                          <div className="text-[11px] text-danger">连接失败：{p.error}</div>
                        ) : (
                          <div className="space-y-1">
                            <div className="text-[11px] text-sub">工具 {p!.tools!.length} 个（默认 medium 审批，可配置 riskOverrides 覆盖）</div>
                            {p!.tools!.map((t) => (
                              <div key={t.name} className="flex items-start gap-2 text-[11px] text-text">
                                <span className={`shrink-0 rounded border px-1 py-px text-[10px] ${RISK_STYLE[t.risk] ?? RISK_STYLE.medium}`}>
                                  {t.risk}
                                </span>
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
        </div>

        {/* 底部提示 */}
        <div className="border-t border-line px-4 py-2 text-[11px] text-sub/70">
          ⚠ MCP 服务器进程不受沙箱约束（配置即信任）；工具调用层默认需人工审批。CLI 等价命令：infu mcp add / list / remove / status
        </div>
      </div>
    </div>
  );
}
