import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Send, Square, GitBranch, Loader2,
  RotateCcw, AlertTriangle, Files, Folder, FolderOpen, ChevronDown, Check,
  BrainCircuit, ShieldCheck, ShieldAlert, Scale, Cpu, Paperclip, FileText, X, Pencil, Image as ImageIcon, WifiOff, Zap,
  CheckCircle2, XCircle, OctagonX, Skull,
} from "lucide-react";
import { Streamdown } from "streamdown";
import type { PhaseId } from "@infu/shared";
import { useStore, type ChatMsg } from "../store";
import { sendChat, mergeWorktree, rewindSession, fetchProjects, fetchConfig, updateConfig, fetchPlugins, setApprovalBypass, type ApprovalMode, type ChatFileInput, type PluginInfo } from "../api";
import Timeline from "./Timeline";
import ReasoningBlock from "./ReasoningBlock";
import QueueDock from "./QueueDock";
import { useClickOutside, useClickOutsideAll } from "./useClickOutside";
import TodoPanel from "./TodoPanel";
import { useCleanMarkdownBoxes } from "./markdown-clean";
import AttachmentRail, { AttachmentLine, ATTACH_LIMITS, type AttachmentDraft } from "./AttachmentRail";
import PlanCard from "./PlanCard";
import TerminalPanel, { TerminalToggleButton } from "./TerminalPanel";
import { CopyButton } from "./ui";

/** 运行耗时（turn 尾操作行「· 运行 15s」；不足 60s 秒、以上 分:秒） */
function fmtClock(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const n = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return clock;
  }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === n.getFullYear() ? `${md} ${clock}` : `${d.getFullYear()}年${md} ${clock}`;
}

/** 运行耗时（turn 尾操作行「· 运行 15s」；不足 60s 秒、以上 分:秒） */
function fmtRunMs(start?: number, end?: number): string | null {
  if (!start || !end) return null;
  const total = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `运行 ${minutes}分${String(seconds).padStart(2, "0")}秒` : `运行 ${total}秒`;
}

/**
 * v3.1 refChip 投影（对齐 主流 projectUserText）：用户气泡内词边界
 * `/name`（技能）、`@name`（插件/子智能体）token 渲染为 chip；其余保持纯文本。
 */
function projectRefText(text: string): React.ReactNode {
  const re = /(^|\s)([/@][\w\u4e00-\u9fa5-]+)(?=\s|$)/g;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1]?.length ?? 0);
    const label = m[2] ?? "";
    if (tokenStart > cursor) parts.push(<span key={cursor}>{text.slice(cursor, tokenStart)}</span>);
    parts.push(
      <span
        key={tokenStart}
        className={`mx-0.5 inline-block rounded-md px-1.5 py-px text-[13px] leading-5 ${
          label.startsWith("@")
            ? "bg-[rgba(103,158,254,0.18)] text-info"
            : "bg-hover text-sub"
        }`}
      >
        {label}
      </span>
    );
    cursor = tokenStart + label.length;
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(<span key={cursor}>{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

/** ArrayBuffer → base64（分块防大文件栈溢出） */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** v3.1 @插件检测：光标前最后一段 @query（词边界；URL/邮箱豁免不触发） */
function detectAt(text: string, pos: number): { start: number; len: number; query: string } | null {
  const before = text.slice(0, pos);
  const m = /(?:^|[\s（(【])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const query = m[1];
  if (query.includes("/") || query.includes(".")) return null; // URL/路径/域名豁免
  return { start: pos - query.length - 1, len: query.length + 1, query };
}

/**
 * 环境信息检测：模型复述的 MCP/插件/技能加载摘要（"MCP 服务器「x」已连接，注入 N 个工具
 * 插件「y」已加载…"）——渲染为对话流中的辅助小字，不作为独立消息内容。
 */
function isEnvInfo(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 整段为环境加载描述：包含连接/加载句式，且无 markdown 结构（标题/围栏/表格/粗体），
  // 总长有上限（防误伤长消息），允许单行长文本
  const hasConnect = /「.+」已连接|已连接，注入/.test(t);
  const hasLoad = /「.+」已加载|已加载：|已加载，/.test(t);
  const noMarkdown = !/[#`|*_>]/.test(t);
  const notTooLong = t.length < 800;
  return (hasConnect || hasLoad) && noMarkdown && notTooLong;
}

/** token 数格式化（128k / 12.5k） */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/** v3.2 事件折叠行（模型降级/上下文压缩——从无框小字升级为可展开事件行）：
 *  24px 单行 = 图标 + 标题 + 2×2 点 + 摘要（截断）+ chevron；点击展开详情区。
 *  InFu 差异化：与思考/工具折叠行同构（16px 节奏平铺），事件即对话流的一部分。 */
function EventRow({ icon, iconCls, title, summary, detail }: {
  icon: React.ReactNode;
  iconCls: string;
  title: string;
  summary: string;
  detail?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-0.5 rounded-lg">
      <button
        className="group/row flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-lg px-1 text-left transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span className={`flex h-4 w-4 shrink-0 items-center justify-center transition-all duration-150 group-hover/row:-translate-y-px ${iconCls}`}>
          {icon}
        </span>
        <span className={`shrink-0 text-[13px] leading-6 transition-all duration-150 group-hover/row:-translate-y-px group-hover/row:text-text ${iconCls}`}>
          {title}
        </span>
        <span className="dot-sep mx-2 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-6 text-sub transition-all duration-150 group-hover/row:-translate-y-px group-hover/row:text-text">
          {summary}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-sub transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && detail && (
        <div className="ml-[22px] mb-1 mt-0.5 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-code px-3 py-2 text-[13px] leading-6 text-sub">
          {detail}
        </div>
      )}
    </div>
  );
}

/** 结构化文本块渲染（v3：对齐 主流——无框纯内容流；交付报告 = 标题用成功绿，审查 = 信息蓝） */
function StructuredBlock({ content, tone }: { content: string; tone: "success" | "info" }) {
  const headCls = tone === "success" ? "text-success" : "text-info";
  return (
    <div className="mt-3">
      {content.split("\n").map((line, i) => {
        if (line.startsWith("## ")) {
          return (
            <div key={i} className="mb-1.5 mt-4 text-base font-semibold leading-6 first:mt-0">
              <span className={headCls}>{line.slice(3)}</span>
            </div>
          );
        }
        if (line.startsWith("### ")) {
          return (
            <div key={i} className="mb-1.5 mt-3 text-[15px] font-semibold leading-6 text-text">
              {line.slice(4)}
            </div>
          );
        }
        if (line.startsWith("- ")) {
          return (
            <div key={i} className="pl-5 text-[15px] leading-6 text-text/90">
              <span className="mr-2 text-sub">•</span>
              {line.slice(2)}
            </div>
          );
        }
        if (line.startsWith("**")) {
          return (
            <div key={i} className="mb-1 text-[15px] leading-6 text-text/90">
              {line.replace(/\*\*/g, "")}
            </div>
          );
        }
        return line.trim() ? (
          <div key={i} className="text-[15px] leading-6 text-text/85">{line}</div>
        ) : (
          <div key={i} className="h-1.5" />
        );
      })}
    </div>
  );
}

/** 运行耗时时钟（主流 状态行样式，1s 一跳） */
function ElapsedClock({ active }: { active: boolean }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return <span className="tabular-nums">{Math.floor((now - start) / 1000)}s</span>;
}

/** v3.2 错误类型分类（对齐 主流 LlmError 分类的轻量版——从前端消息文本识别，展示徽标） */
function classifyError(msg: string): { label: string; cls: string } | null {
  if (/网络|ECONN|fetch failed|ETIMEDOUT|socket/i.test(msg)) return { label: "网络错误", cls: "bg-danger-soft/60 text-danger" };
  if (/超时|timed out|timeout/i.test(msg)) return { label: "超时", cls: "bg-warn-soft/60 text-warn" };
  const m = msg.match(/（(\d{3})）/);
  const code = m ? Number(m[1]) : /HTTP (\d{3})/.exec(msg)?.[1] ? Number(/HTTP (\d{3})/.exec(msg)![1]) : null;
  if (code === 429) return { label: "限流 429", cls: "bg-warn-soft/60 text-warn" };
  if (code === 401 || code === 403) return { label: `认证失败 ${code}`, cls: "bg-danger-soft/60 text-danger" };
  if (/流中断|unexpected end|EOF|incomplete/i.test(msg)) return { label: "流中断", cls: "bg-warn-soft/60 text-warn" };
  if (code) return { label: `HTTP ${code}`, cls: "bg-danger-soft/60 text-danger" };
  return null;
}

/** 上下文用量估算（主流 context-meter：字符/4 粗估，相对当前模型窗口）
 *  v3.2：中文 1 字符 ≈ 1 token、其他 ≈ 4 字符 1 token（与后端 estimateTokens 同式——
 *  InFu 会话以中文为主，字符/4 会严重低估） */
function useContextEstimate() {
  const { messages, modelId, models } = useStore();
  let cn = 0;
  let other = 0;
  for (const m of messages) {
    const s = m.text + (m.reasoning ?? "");
    for (const ch of s) {
      if (/[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch)) cn++;
      else other++;
    }
  }
  const estTokens = cn + Math.ceil(other / 4);
  const cur = models.find((m) => m.id === modelId);
  const window = cur?.contextWindow ?? 128_000;
  const pct = Math.min(100, (estTokens / window) * 100);
  return { estTokens, window, pct };
}

/** Context 用量环（28px 圆环 + 点击 breakdown；主流 composer 同款） */
function ContextMeter() {
  const { estTokens, window, pct } = useContextEstimate();
  const [open, setOpen] = useState(false);
  const R = 12;
  const C = 2 * Math.PI * R;
  return (
    <span className="relative">
      <button
        className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-hover"
        onClick={() => setOpen(!open)}
        title="上下文用量"
      >
        <svg viewBox="0 0 28 28" className="h-7 w-7 -rotate-90">
          <circle cx="14" cy="14" r={R} fill="none" stroke="var(--border-l3)" strokeWidth="2.5" />
          <circle
            cx="14" cy="14" r={R} fill="none" stroke="var(--info)" strokeWidth="2.5"
            strokeLinecap="round" strokeDasharray={`${(pct / 100) * C} ${C}`}
          />
        </svg>
        <span className="absolute text-[8px] font-medium leading-none text-sub">{Math.round(pct)}%</span>
      </button>
      {open && (
        <div className="absolute bottom-8 right-0 z-50 w-44 rounded-xl border border-line bg-elevated p-2.5 shadow-lv3">
          <div className="text-[11px] font-medium text-caption">上下文用量</div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover">
            <div className="h-full rounded-full bg-info" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1.5 text-xs leading-5 text-sub">
            约 {fmtTokens(estTokens)} / {fmtTokens(window)} tokens（中英混合估算）
          </div>
        </div>
      )}
    </span>
  );
}

/** 中间栏（v3：——Hero 光晕空态 / 右侧气泡 / 无气泡助手 / 折叠工具行 / 悬浮胶囊输入） */
export default function ChatPanel() {
  const {
    messages, running, runningIds, abortRun, worktree, worktreeNote, root, setRoot, clearWorktree, plan,
    useWorktree, setUseWorktree, activeSessionId, models, modelId, setModelId,
    thinkingLevel, setThinkingLevel, pendingRollback, setPendingRollback, clearPendingRollback,
    terminalOpen, setTerminalOpen, viewMode, queuesBySession,
  } = useStore();
  const [input, setInput] = useState("");
  const [wtBusy, setWtBusy] = useState(false);
  // v2.14 批 9：回滚完成提示（3 秒自动消失，主题样式）
  const [rollbackToast, setRollbackToast] = useState<string | null>(null);
  // v2.14 批 10：编辑态（点 ✏️ 进入——输入框填原文，确认 = 截断历史 + 重发；取消 = 退出）
  const [editingSeq, setEditingSeq] = useState<number | null>(null);

  // v2.14 批 10：切换会话时退出编辑态（残留的编辑按钮组/原文不该带到别的会话）
  const activeSid = useStore((s) => s.activeSessionId);
  // v3.2：断网/瞬时故障重试信息（当前视图会话；状态行倒计时显示）
  const retryInfo = useStore((s) => (activeSid ? s.retryBySession[activeSid] : undefined));
  // v3.2：会话级全权放行状态（审批弹窗开启；状态行徽标展示，点击可关闭）
  const bypassActive = useStore((s) => (activeSid ? s.bypassBySession[activeSid] === true : false));
  const setBypassFor = useStore((s) => s.setBypassFor);
  useEffect(() => {
    setEditingSeq(null);
  }, [activeSid]);
  // v2.14 批 14：定位浮标活跃索引（当前视口显示的第几段对话 → 对应浮标延长 + 变色）
  const [activeMsgIdx, setActiveMsgIdx] = useState(0);
  // v2.14 批 11：工作树按钮移到「最近修改文件的 AI 消息」旁（点击直接并入）——面板/wtMsg 机制移除
  const [showBackTop, setShowBackTop] = useState(false);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  // v3：左侧定位浮标（用户消息锚点；聊天列过窄时隐藏）
  const [narrow, setNarrow] = useState(false);
  // v3：工作区菜单（hero 项目 chip）——项目列表
  const [projects, setProjects] = useState<Array<{ id: string; name: string; root: string }>>([]);
  // v3：思考模式下拉 + 全局审批档位下拉 + 模型下拉（主流 composer 对齐）
  const [thinkOpen, setThinkOpen] = useState(false);
  // v3.5：审批档位提升为全局 store 状态——composer 与设置「命令」Tab 共享同一数据源（双向联动）
  const approvalMode = useStore((s) => s.approvalMode);
  const setApprovalMode = useStore((s) => s.setApprovalMode);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  // v3.1 附件：草稿列表 + 添加菜单 + 隐藏文件/文件夹选择器
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  // v3.1 @插件：光标前 @ 触发面板（实时过滤；无匹配自动消失；↑↓/Enter 选择）
  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState("");
  const [atSel, setAtSel] = useState(0);
  const atRef = useRef<{ start: number; len: number } | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  useEffect(() => {
    // v3.4 审计修复：加载失败不再静默——@ 面板缺失插件是用户可见的功能缺失
    fetchPlugins().then((list) => setPlugins(list.filter((p) => p.enabled !== false))).catch(() => {
      useStore.getState().addError("插件列表加载失败，@插件 不可用");
    });
  }, []);
  const bottomRef = useRef<HTMLDivElement>(null);
  // v3.0 批 12：下拉栏点击空白处自动收起（审批/模型/思考/附件）
  const composerRef = useClickOutsideAll([
    () => setApprovalOpen(false),
    () => setModelOpen(false),
    () => setThinkOpen(false),
    () => setAttachOpen(false),
  ]);
  // v3.0 批 12：hero 项目选择菜单点击空白处自动收起
  const wsMenuRef = useClickOutside(() => setWsMenuOpen(false));
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /** v3：审批档位（全局，写入 config 即时生效） */
  const changeApprovalMode = async (mode: ApprovalMode) => {
    setApprovalMode(mode);
    setApprovalOpen(false);
    try {
      const cfg = await fetchConfig();
      await updateConfig({ ...cfg, approvalPolicy: { ...cfg.approvalPolicy, mode } });
    } catch {
      /* 保存失败静默（档位下次启动回退） */
    }
  };
  useEffect(() => {
    fetchConfig()
      .then((cfg) => setApprovalMode(cfg.approvalPolicy.mode ?? "smart"))
      // v3.4 审计修复：档位加载失败静默 → 用户以为设置了 confirm 实际是默认 smart（高危操作
      // 静默放行）；提示 + 明确当前实际档位
      .catch(() => {
        setApprovalMode("smart");
        useStore.getState().addError("审批档位加载失败，已回退默认（smart）");
      });
  }, []);

  // v2 模型选择器：按供应商分组 + 思考级别映射提示
  const PROVIDER_GROUPS = (() => {
    const groups = new Map<string, { name: string; models: typeof models }>();
    for (const m of models) {
      const key = m.providerId ?? m.provider ?? "其他";
      if (!groups.has(key)) groups.set(key, { name: key, models: [] });
      groups.get(key)!.models.push(m);
    }
    return [...groups.values()];
  })();
  /** 思考级别映射提示（按当前模型实际级别数：1→最弱，2-4→按比例） */
  const thinkingHint = (lv: number): string => {
    const cur = models.find((m) => m.id === modelId);
    const levels = cur?.thinkingLevels ?? 1;
    const mapped = lv === 1 ? 1 : Math.min(levels, Math.ceil(((lv - 1) / 3) * (levels - 1)) + 1);
    if (levels <= 1) return "该模型无思考级别";
    const labels = ["快速", "标准", "深度", "极限"];
    return `${cur?.name ?? ""}：第 ${lv} 级 → 模型级 ${mapped}（${labels[lv - 1]}）`;
  };

  /** 输入框自适应高度（上限 336px 内滚） */
  useEffect(() => {
    const ta = inputRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 336)}px`;
    }
  }, [input]);

  /** 自动滚底跟随（v3.1 修复：AI 流式输出时不再强制拉底）：
   *  仅当用户处于底部附近（离底 <48px）时跟随新内容；
   *  用户向上滚动浏览历史 → 停止跟随（可自由上滑），滚回底部 → 恢复跟随 */
  const atBottomRef = useRef(true);
  useEffect(() => {
    if (atBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // v3：聊天列过窄时隐藏定位浮标
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // v3.0 批 4.5：阈值 560——聊天列不够宽裕（<560px）就隐藏浮标，宽度充裕才显示
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** v3 定位浮标：滚动到第 i 条用户消息 */
  const scrollToUserMsg = (id: string) => {
    scrollRef.current?.querySelector(`[data-infumsg="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // v2.9：streamdown 卡片包装去框（表格/代码块）——公共 hook（聊天区 + 子 Agent 共用）
  useCleanMarkdownBoxes(scrollRef, [messages]);

  /** v2.14 批 14：计算当前视口显示的「第几段对话」（视口上部 40% 内的最后一条用户消息） */
  const updateActiveMsg = () => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const anchors = [...el.querySelectorAll<HTMLElement>("[data-infumsg]")];
    let active = 0;
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i].getBoundingClientRect().top - rect.top <= el.clientHeight * 0.4) active = i;
      else break;
    }
    setActiveMsgIdx(active);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) {
      // 离底 <48px 视为「在底部」→ 恢复跟随；向上滑出 → 停止跟随
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setShowBackTop(el.scrollHeight - el.scrollTop - el.clientHeight > 240);
    }
    updateActiveMsg();
  };

  // 消息变化（新回复/重放）后重新定位浮标
  useEffect(() => {
    updateActiveMsg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  /** 进入回滚待定态：锚点 = 被点轮次对应的最后一条用户消息（编辑重发 = 替换它），
   *  该用户消息及之后全部进入待回滚；输入框填充该消息原文。
   *  v3.1：仅当前会话运行中禁止回滚（其他会话任务不影响）
   *  v3.0 UI 审查：useCallback 稳定引用（MessageItem memo 依赖）——状态从 getState 读取，
   *  不依赖每帧变化的 messages 闭包 */
  const askRewind = useCallback(
    (seq: number) => {
      const st = useStore.getState();
      if (!st.activeSessionId || (st.activeSessionId && st.runningIds.includes(st.activeSessionId)) || pendingRollback) return;
      const msgs = st.messages;
      const idx = msgs.findIndex((m) => m.role === "assistant" && (m.seqStart ?? Infinity) >= seq);
      // 回滚锚点：该轮之前最后一条用户消息（user-message 事件 seq）；无则退回该轮 step-start
      let anchorIdx = idx >= 0 ? idx : msgs.length;
      let anchorSeq = seq;
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i].role === "user" && msgs[i].seqStart != null) {
          anchorIdx = i;
          anchorSeq = msgs[i].seqStart!;
          break;
        }
      }
      const count = msgs.length - anchorIdx;
      // v2.14 批 9：回滚 = 撤回重来，不预填原文编辑（回滚与编辑分离——编辑用消息操作行的铅笔按钮）
      setPendingRollback({ seq: anchorSeq, count, fillText: "" });
      requestAnimationFrame(() => {
        const ta = inputRef.current;
        if (ta) ta.focus();
      });
    },
    [pendingRollback]
  );

  /** 本地截断消息流（回滚/编辑确认后立即移除锚点及之后消息，等重放前先同步视觉） */
  const truncateLocal = (seq: number) => {
    const st = useStore.getState();
    const msgs = st.messages.filter((m) => (m.seqStart ?? Infinity) < seq);
    useStore.setState({
      messages: msgs,
      sessionCache: { ...st.sessionCache, [st.activeSessionId ?? ""]: msgs },
    });
  };

  /** 回滚完成 toast（3 秒自动消失） */
  const showRollbackToast = (msg: string) => {
    setRollbackToast(msg);
    setTimeout(() => setRollbackToast(null), 3000);
  };

  /** 确认回滚（v2.14 批 10：直接执行，不需要写消息 + 发送；截断后 AI 感知回滚） */
  const confirmRollback = async () => {
    if (!pendingRollback || !activeSessionId) return;
    try {
      await rewindSession(activeSessionId, pendingRollback.seq, true);
      truncateLocal(pendingRollback.seq);
      clearPendingRollback();
      showRollbackToast("已回滚——之前的对话已截断，AI 将从这里继续");
    } catch (e) {
      useStore.getState().addError(`回滚失败: ${(e as Error).message}`);
    }
  };

  /** 取消回滚：只取消待定态（输入框内容保留——回滚不预填，输入是用户自己的） */
  const cancelRollback = () => {
    clearPendingRollback();
  };

  /** 编辑态：点 ✏️ 进入（填原文 + 聚焦；消息流不动，确认时才截断）
   *  v3.0 UI 审查：useCallback 稳定引用（MessageItem memo 依赖） */
  const startEdit = useCallback((seq: number, text: string) => {
    setEditingSeq(seq);
    setInput(text);
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    });
  }, []);

  /** 取消编辑：退出编辑态（输入框清空） */
  const cancelEdit = () => {
    setEditingSeq(null);
    setInput("");
  };

  /** 确认编辑（InFu 款）：截断到锚点（无回滚标记——AI 无需感知）+ 本地截断 + 重发编辑后文本 */
  const confirmEdit = async (text: string) => {
    if (editingSeq == null || !activeSessionId) return;
    try {
      await rewindSession(activeSessionId, editingSeq, false);
      truncateLocal(editingSeq);
      setEditingSeq(null);
      // v3.0 UI 审查：成功后清空输入框（此前残留文本会被误认为未发送而重复提交）
      setInput("");
    } catch (e) {
      useStore.getState().addError(`编辑失败: ${(e as Error).message}`);
      return;
    }
    await sendChat(text, { sessionId: activeSessionId });
  };

  /** 提交任务；待定态下先提交回滚（截断服务端事件）再发送新消息。
   *  v3.1：当前会话运行中 → 排队发送（输入入队，done 后自动消费） */
  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    if (running) {
      // 排队发送：AI 处理中预输入下一条（主流 QueueDock 同款；任务结束后自动发出）
      useStore.getState().enqueue(text);
      setInput("");
      return;
    }
    // v2.14 批 10：编辑态提交 = 截断到锚点（无标记）+ 重发编辑后文本
    if (editingSeq != null && activeSessionId) {
      await confirmEdit(text);
      return;
    }
    // v2.14 批 10：回滚待定 + 输入了内容 → 自动先回滚再发送（回滚本身不依赖输入——有确认按钮）
    if (pendingRollback && activeSessionId) {
      try {
        await rewindSession(activeSessionId, pendingRollback.seq, true);
        truncateLocal(pendingRollback.seq);
        clearPendingRollback();
        showRollbackToast("已回滚——之前的对话已截断，AI 将从这里继续");
      } catch (e) {
        useStore.getState().addError(`回滚提交失败: ${(e as Error).message}`);
        return; // 回滚失败不发送
      }
    }
    setInput("");
    useStore.getState().setTemplateId(null); // 普通输入：清模板标记
    // 发送 = 回到底部（即使之前上滑浏览过；恢复跟随）
    atBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    // v3.1 附件：读取内容 → 发送（文件 base64 暂存；图片 dataURL 视觉）
    let sendOpts: Parameters<typeof sendChat>[1] | undefined;
    if (attachments.length) {
      const files: ChatFileInput[] = [];
      const images: string[] = [];
      const paths: string[] = [];
      for (const a of attachments) {
        if (a.dataUrl) {
          images.push(a.dataUrl); // 图片 → 视觉
        } else if (a.path) {
          paths.push(a.path); // 桌面版：真实路径引用（不复制内容）
        } else if (a.file) {
          try {
            const buf = await a.file.arrayBuffer();
            files.push({ name: a.name, rel: a.rel || a.name, data: toBase64(buf) });
          } catch {
            useStore.getState().addError(`附件读取失败：${a.rel}`);
            return;
          }
        }
      }
      sendOpts = { files, images, paths };
    }
    setAttachments([]);
    void sendChat(text, sendOpts);
  };

  /** v3.1 附件：文件选择（多选；图片自动识别为视觉预览） */
  /** v3.0 批 12：桌面版附件「选择路径」——系统对话框拿真实绝对路径（不复制内容）；
   *  Web 版（无 infuDesktop）保持上传内容 */
  const pickPaths = async (directories?: boolean) => {
    const d = window.infuDesktop;
    if (!d) return;
    const paths = await d.selectPaths({ directories });
    if (!paths.length) return;
    const drafts: AttachmentDraft[] = [];
    for (const p of paths) {
      const name = p.split(/[\/]/).filter(Boolean).pop() ?? p;
      drafts.push({ id: `a${Date.now()}-${drafts.length}`, name, rel: p, path: p });
    }
    if (drafts.length) setAttachments((prev) => [...prev, ...drafts]);
  };

  const pickFiles = (list: FileList | null) => {
    if (!list) return;
    const drafts: AttachmentDraft[] = [];
    for (const f of Array.from(list)) {
      const isImg = f.type.startsWith("image/");
      const maxB = isImg ? ATTACH_LIMITS.MAX_IMAGE_BYTES : ATTACH_LIMITS.MAX_FILE_BYTES;
      if (f.size > maxB) {
        useStore.getState().addError(`附件超限（${(maxB / 1024 / 1024).toFixed(0)}MB）：${f.name}`);
        continue;
      }
      const d: AttachmentDraft = { id: `a${Date.now()}-${drafts.length}`, name: f.name, rel: f.name, size: f.size, file: f };
      if (isImg) {
        const reader = new FileReader();
        reader.onload = () => setAttachments((prev) => [...prev, { ...d, dataUrl: String(reader.result) }]);
        reader.readAsDataURL(f);
        continue;
      }
      drafts.push(d);
    }
    if (drafts.length) setAttachments((prev) => [...prev, ...drafts]);
  };

  /** v3.1 附件：文件夹选择（webkitdirectory；子文件逐个入列，rel 带目录结构） */
  const pickDir = (list: FileList | null) => {
    if (!list) return;
    const drafts: AttachmentDraft[] = [];
    for (const f of Array.from(list)) {
      if (f.size > ATTACH_LIMITS.MAX_FILE_BYTES) continue;
      const rel = f.webkitRelativePath || f.name;
      drafts.push({ id: `a${Date.now()}-${drafts.length}`, name: rel.split("/").pop() ?? f.name, rel, size: f.size, file: f });
      if (drafts.length >= ATTACH_LIMITS.MAX_FILES) {
        useStore.getState().addError(`文件夹附件超过 ${ATTACH_LIMITS.MAX_FILES} 个文件，已截断`);
        break;
      }
    }
    if (drafts.length) setAttachments((prev) => [...prev, ...drafts]);
  };

  // v3：hero 工作区菜单数据（项目注册表）
  useEffect(() => {
    // v3.4 审计修复：项目列表失败静默 → 工作区菜单空白无提示
    fetchProjects().then(setProjects).catch(() => {
      useStore.getState().addError("项目列表加载失败，工作区菜单不可用");
    });
  }, []);

  // v2.14 批 11：工作树并入（点击消息旁的按钮直接执行；成功/失败 toast 提示）
  // v3.0 UI 审查：useCallback 稳定引用（MessageItem memo 依赖）
  const doMerge = useCallback(async () => {
    if (!worktree) return;
    setWtBusy(true);
    try {
      const r = await mergeWorktree(root, worktree.name);
      clearWorktree();
      showRollbackToast(r.message || "已并入主分支");
    } catch (e) {
      showRollbackToast(`并入失败: ${(e as Error).message}`);
    } finally {
      setWtBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree, root]);

  const rootName = root.split(/[\\/]/).filter(Boolean).pop() ?? "";
  /** 路径规范化（工作区菜单对比用） */
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();

  // v3 会话统计（主流 StatsLine 数据源）
  const turns = messages.filter((m) => m.role === "user").length;
  const toolCount = messages.reduce((a, m) => a + m.tools.length, 0);
  // v3.2：估算对齐后端（中文 1 字符≈1 token、其他≈4 字符 1 token）——StatsLine/ContextMeter 同式
  const estTokens = useMemo(() => {
    let cn = 0;
    let other = 0;
    for (const m of messages) {
      const s = m.text + (m.reasoning ?? "");
      for (const ch of s) {
        if (/[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch)) cn++;
        else other++;
      }
    }
    return cn + Math.ceil(other / 4);
  }, [messages]);
  // v3：缓存命中率——真实 usage（DeepSeek）优先；端点无缓存数据时前缀估算兜底
  // v2.12：四桶——uncached=miss（未命中输入）/ cacheRead=hit（缓存读）/ output=completionTokens（输出）
  const usageHit = useStore((s) => s.usage.cacheHit);
  const usageMiss = useStore((s) => s.usage.cacheMiss);
  const usageOut = useStore((s) => s.usage.completionTokens);
  const usageTotal = usageHit + usageMiss;
  // v3.0 UI 审查（对话流优化）：lastEditIdx/lastUserIdx 预计算一次，
  // 此前每条消息渲染都 reduce 全列表（O(n²)），流式每帧全量重算
  const lastEditIdx = useMemo(
    () => messages.reduce((acc, mm, mi) => (mm.role === "assistant" && mm.tools.some((tt) => tt.tool === "write_file" || tt.tool === "edit_file") ? mi : acc), -1),
    [messages]
  );
  const lastUserIdx = useMemo(() => messages.map((m) => m.role).lastIndexOf("user"), [messages]);
  // 待回滚范围锚点（变灰 + 标记）：预计算一次，避免每帧 findIndex
  const rmIdx = useMemo(
    () => (pendingRollback ? messages.findIndex((x) => (x.seqStart ?? Infinity) >= pendingRollback.seq) : -1),
    [messages, pendingRollback]
  );
  const lastTurnChars =
    lastUserIdx >= 0
      ? messages.slice(lastUserIdx).reduce((a, m) => a + m.text.length + (m.reasoning?.length ?? 0), 0)
      : 0;
  const totalChars = messages.reduce((a, m) => a + m.text.length + (m.reasoning?.length ?? 0), 0);
  const hitRate =
    usageTotal > 0
      ? usageHit / usageTotal
      : totalChars > 0
        ? Math.max(0, 1 - lastTurnChars / totalChars)
        : null;

  // v3 思考模式档位（低/中/高/MAX）与审批档位（auto/smart/confirm/full）
  const THINK_LABEL = ["低", "中", "高", "MAX"];
  const MODE_LABEL: Record<ApprovalMode, { label: string; desc: string; icon: React.ElementType; color: string }> = {
    // v2.14 批 18：全自动 = 盾牌+感叹号（ShieldAlert）警告色（警示全自动放行）；
    // 智能/全部确认为中性色（有色只有警告场景）
    auto: { label: "全自动", desc: "非人工必需场景自动放行（联网等安全线仍需确认）", icon: ShieldAlert, color: "text-warn" },
    smart: { label: "智能", desc: "低风险自动放行，中/高风险人工确认", icon: Scale, color: "text-sub" },
    confirm: { label: "全部确认", desc: "所有风险等级都弹窗人工确认", icon: ShieldCheck, color: "text-sub" },
    // v3.5：全权放行（对齐 Codex 完全信任）——红色警示三角：红线（联网/自注册等）也自动放行
    full: { label: "全权放行", desc: "一切审批（含安全红线）自动放行，零弹窗", icon: AlertTriangle, color: "text-danger" },
  };

  /** 输入胶囊（hero 与普通模式共用；hero 版最小两行对齐 主流） */
  const composer = (hero: boolean) => {
    const curModel = models.find((m) => m.id === modelId);
    // v3.1 @插件：实时过滤（无匹配 → 面板消失）
    const atItems = atOpen
      ? plugins.filter((p) => `${p.id} ${p.name ?? ""}`.toLowerCase().includes(atQuery.toLowerCase()))
      : [];
    const selectPlugin = (p: PluginInfo) => {
      const at = atRef.current;
      if (!at) return;
      setInput(input.slice(0, at.start) + `@${p.id} ` + input.slice(at.start + at.len));
      setAtOpen(false);
      atRef.current = null;
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    return (
    <div ref={composerRef} className="relative mx-auto w-full max-w-[780px] rounded-[22px] border border-line/60 bg-input px-4 pt-3 shadow-lv2">
      {/* 终端开关（v3：输入框右上方、右边界对齐；对话界面常驻，代码界面被覆盖隐藏） */}
      {viewMode === "chat" && <TerminalToggleButton open={terminalOpen} onClick={() => setTerminalOpen(!terminalOpen)} />}
      {/* v2.14 批 10：回滚/编辑待定操作组（输入框左上；大胶囊双按钮——确认 / 取消） */}
      {(pendingRollback || editingSeq != null) && (
        <div className="absolute -top-8 left-2 z-20 flex items-center gap-1.5">
          <button
            className="flex h-6 cursor-pointer items-center gap-1.5 rounded-[14px] border border-info/60 bg-info-soft px-3 text-xs font-medium text-info transition-colors hover:bg-info/20"
            onClick={() => (pendingRollback ? void confirmRollback() : void confirmEdit(input.trim()))}
            title={pendingRollback ? "确认回滚（截断此处及之后的对话）" : "确认编辑（替换此消息并重新发送，AI 重新思考）"}
          >
            <Check className="h-3.5 w-3.5" />
            {pendingRollback ? "确认回滚" : "确认编辑"}
          </button>
          <button
            className="flex h-6 cursor-pointer items-center gap-1.5 rounded-[14px] border border-line bg-elevated/90 px-3 text-xs text-text transition-colors hover:bg-hover"
            onClick={() => (pendingRollback ? cancelRollback() : cancelEdit())}
          >
            <X className="h-3.5 w-3.5" />
            取消{pendingRollback ? "回滚" : "编辑"}
          </button>
        </div>
      )}
      {/* v3.1 @插件面板（输入卡上方弹出；↑↓/Enter 键盘选择，点击即用） */}
      {atOpen && atItems.length > 0 && (
        <div className="absolute bottom-full left-3 z-50 mb-1.5 max-h-56 w-[300px] overflow-y-auto rounded-xl border border-line bg-elevated p-1 shadow-lv3">
          {atItems.map((p, i) => (
            <button
              key={p.id}
              onMouseDown={(e) => { e.preventDefault(); selectPlugin(p); }}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                i === atSel ? "bg-hover text-text" : "text-text/80 hover:bg-hover/60"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{p.name ?? p.id}</span>
              {p.builtin && <span className="shrink-0 rounded-md bg-hover px-1.5 py-0.5 text-[10px] text-caption">内置</span>}
              {p.version && <span className="shrink-0 text-[10px] text-caption">v{p.version}</span>}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        className={`block w-full resize-none bg-transparent text-[15px] leading-6 text-text placeholder:text-caption outline-none focus:outline-none ${
          hero ? "min-h-[52px]" : "min-h-[44px]"
        }`}
        style={{ maxHeight: 336 }}
        placeholder={
          running
            ? `AI 处理中… 回车将排队发送（当前队列 ${activeSessionId ? (queuesBySession[activeSessionId] ?? []).length : 0} 条）`
            : root
              ? "描述任务：InFu 会自主规划并执行…（输入 @ 可引用插件）"
              : "请先在左侧栏选择或创建项目，然后描述任务…"
        }
        value={input}
        onChange={(e) => {
          const v = e.target.value;
          setInput(v);
          // v3.1 @检测（光标前最后一段 @query；无匹配自动关闭）
          const pos = e.target.selectionStart ?? v.length;
          const at = detectAt(v, pos);
          if (at && plugins.length) {
            atRef.current = at;
            setAtQuery(at.query);
            setAtSel(0);
            setAtOpen(true);
          } else {
            setAtOpen(false);
            atRef.current = null;
          }
        }}
        onKeyDown={(e) => {
          // v3.1 @面板开启时：↑↓/Enter/Esc 优先（Enter 只选中不发送）
          if (atOpen && atItems.length > 0) {
            if (e.key === "ArrowDown") { e.preventDefault(); setAtSel((s) => Math.min(s + 1, atItems.length - 1)); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setAtSel((s) => Math.max(s - 1, 0)); return; }
            if (e.key === "Enter") { e.preventDefault(); selectPlugin(atItems[Math.min(atSel, atItems.length - 1)]); return; }
            if (e.key === "Escape") { setAtOpen(false); atRef.current = null; return; }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={hero ? 2 : 1}
        spellCheck={false}
      />
      {/* 工具行（v3：与输入框间距两个半字符；左 = 附件 + 审批档位；右 = 用量环 + 模型 + 思考 + 发送。
          压缩时不溢出：按钮 shrink-0、用量环/思考在窄视口隐藏、模型名截断） */}
      <div className="flex min-w-0 items-center gap-2 pb-2 pt-7">
        {/* v3.1 附件（文件/文件夹/图片：内容上传暂存 + 图片视觉；预览条在输入卡上方） */}
        <span className="relative shrink-0">
          <button
            className="flex h-7 cursor-pointer items-center justify-center rounded-lg border border-line px-2 text-[13px] font-medium text-text transition-colors hover:bg-hover"
            onClick={() => setAttachOpen(!attachOpen)}
            title="添加附件（文件 / 文件夹 / 图片）"
          >
            <Paperclip className="h-3.5 w-3.5 text-sub" />
            {attachments.length > 0 && (
              <span className="ml-1 rounded-full bg-info/20 px-1.5 text-[11px] font-semibold leading-4 text-info">{attachments.length}</span>
            )}
          </button>
          {attachOpen && (
            <div className="absolute bottom-9 left-0 z-50 min-w-[150px] rounded-xl border border-line bg-elevated p-1 shadow-lv3">
              <button
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text transition-colors hover:bg-hover"
                onClick={() => {
                  setAttachOpen(false);
                  // v3.0 批 12：桌面版 = 系统对话框选路径（引用不复制）；Web 版 = 上传
                  if (window.infuDesktop) void pickPaths(false);
                  else fileRef.current?.click();
                }}
              >
                <FileText className="h-3.5 w-3.5 text-sub" />
                添加文件…
              </button>
              <button
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text transition-colors hover:bg-hover"
                onClick={() => {
                  setAttachOpen(false);
                  if (window.infuDesktop) void pickPaths(true);
                  else dirRef.current?.click();
                }}
              >
                <Folder className="h-3.5 w-3.5 text-sub" />
                添加文件夹…
              </button>
            </div>
          )}
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />
          <input
            ref={dirRef}
            type="file"
            className="hidden"
            {...({ webkitdirectory: "", directory: "" })}
            onChange={(e) => { pickDir(e.target.files); e.target.value = ""; }}
          />
        </span>
        <span className="relative shrink-0">
          <button
            className="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-line px-2 text-[13px] font-medium text-text transition-colors hover:bg-hover"
            onClick={() => setApprovalOpen(!approvalOpen)}
            title="全局审批档位（写入设置，即时生效）"
          >
            {(() => { const M = MODE_LABEL[approvalMode]; return <M.icon className={`h-3.5 w-3.5 ${M.color}`} />; })()}
            {MODE_LABEL[approvalMode].label}
            <ChevronDown className="h-3 w-3 text-sub" />
          </button>
          {approvalOpen && (
            <div className="absolute bottom-9 left-0 z-50 min-w-[190px] rounded-xl border border-line bg-elevated p-1 shadow-lv3">
              {(Object.keys(MODE_LABEL) as ApprovalMode[]).map((m) => (
                <button
                  key={m}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text transition-colors hover:bg-hover"
                  onClick={() => changeApprovalMode(m)}
                >
                  {(() => { const M = MODE_LABEL[m]; return <M.icon className={`h-4 w-4 shrink-0 ${M.color}`} />; })()}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{MODE_LABEL[m].label}</span>
                    <span className="block text-[11px] leading-4 text-caption">{MODE_LABEL[m].desc}</span>
                  </span>
                  {approvalMode === m && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
                </button>
              ))}
            </div>
          )}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {/* 上下文用量环（v3：模型选择左侧；窄视口隐藏防溢出） */}
          <span className="hidden min-[560px]:block">
            <ContextMeter />
          </span>
          {/* 模型选择（v3：自定义下拉，与思考等级同款样式） */}
          <span className="relative min-w-0 shrink-0">
            <button
              className="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-line px-2 text-[13px] font-medium text-text transition-colors hover:bg-hover"
              onClick={() => setModelOpen(!modelOpen)}
              title="当前任务使用的模型"
            >
              <span className="max-w-[110px] truncate">{curModel?.name ?? "选择模型"}</span>
              <ChevronDown className="h-3 w-3 text-sub" />
            </button>
            {modelOpen && (
              <div className="absolute bottom-9 right-0 z-50 max-h-72 min-w-[220px] overflow-y-auto rounded-xl border border-line bg-elevated p-1 shadow-lv3">
                {PROVIDER_GROUPS.map((g) => (
                  <div key={g.name}>
                    <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium text-caption">{g.name}</div>
                    {g.models.map((m) => (
                      <button
                        key={m.id}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text transition-colors hover:bg-hover"
                        onClick={() => { setModelId(m.id); setModelOpen(false); }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{m.name}</span>
                          <span className="block truncate text-[11px] leading-4 text-caption">
                            {m.model}
                            {m.contextWindow ? ` · ${fmtTokens(m.contextWindow)} 窗口` : ""}
                            {m.thinkingLevels ? ` · ${m.thinkingLevels} 级思考` : ""}
                          </span>
                        </span>
                        {modelId === m.id && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </span>
          {/* 思考模式（低/中/高/MAX；极窄视口隐藏防溢出） */}
          <span className="relative shrink-0 max-[480px]:hidden">
            <button
              className="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-line px-2 text-[13px] font-medium text-text transition-colors hover:bg-hover"
              onClick={() => setThinkOpen(!thinkOpen)}
              title="思考模式（按模型实际级别数映射）"
            >
              <BrainCircuit className="h-3.5 w-3.5 text-sub" />
              思考：{THINK_LABEL[thinkingLevel - 1]}
              <ChevronDown className="h-3 w-3 text-sub" />
            </button>
            {thinkOpen && (
              <div className="absolute bottom-9 right-0 z-50 min-w-[170px] rounded-xl border border-line bg-elevated p-1 shadow-lv3">
                {[1, 2, 3, 4].map((lv) => (
                  <button
                    key={lv}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text transition-colors hover:bg-hover"
                    onClick={() => { setThinkingLevel(lv); setThinkOpen(false); }}
                    title={thinkingHint(lv)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{THINK_LABEL[lv - 1]}</span>
                      <span className="block text-[11px] leading-4 text-caption">{thinkingHint(lv)}</span>
                    </span>
                    {thinkingLevel === lv && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
                  </button>
                ))}
              </div>
            )}
          </span>
          {/* 发送键常驻（运行中点击 = 排队发送，不停止任务）；停止独立小按钮 */}
          {running && (
            <button
              className="flex h-[28px] w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-line bg-elevated text-sub transition-colors hover:border-danger/50 hover:text-danger"
              onClick={() => abortRun()}
              title="停止任务"
            >
              <Square className="h-3 w-3" fill="currentColor" />
            </button>
          )}
          <button
            className="flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-fg transition-all duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            onClick={submit}
            disabled={!running && !input.trim()}
            title={running ? "排队发送（Enter 入队，任务结束后自动发出）" : "发送 (Enter)"}
          >
            <Send className="h-4 w-4" />
          </button>
        </span>
      </div>
    </div>
    );
  };

  // v2.14 批 5：卡片壳在外层（App.tsx：header + ChatPanel 一体圆角卡片）；本组件只负责内部布局
  return (
    <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* v3 左侧定位浮标（用户消息锚点；小横杠，hover 变长方便点击；滚动条隐藏但可上下滑动；
          仅消息流多轮且聊天列不窄时显示） */}
      {!narrow && messages.filter((m) => m.role === "user").length > 1 && (
        <div className="no-scrollbar absolute left-1 top-1/2 z-10 flex max-h-[70%] -translate-y-1/2 flex-col items-center gap-2.5 overflow-y-auto px-0.5 py-1">
          {messages
            .map((m, i) => ({ m, i }))
            .filter(({ m }) => m.role === "user")
            .map(({ m, i }, n) => (
              <button
                key={m.id}
                className={`relative h-[3px] shrink-0 cursor-pointer rounded-full transition-all duration-200 ease-out before:absolute before:-inset-x-2 before:-inset-y-2.5 before:content-[''] ${
                  n === activeMsgIdx
                    ? "w-8 bg-info shadow-[0_0_6px_rgba(86,134,254,0.6)]" // v2.14 批 14：当前消息浮标延长 + 变色 + 微光
                    : "w-3.5 bg-line hover:w-8 hover:bg-info"
                }`}
                onClick={() => scrollToUserMsg(m.id)}
                title={`定位到第 ${n + 1} 段对话`}
              />
            ))}
        </div>
      )}
      {/* 消息区（主流：748px 内容列居中） */}
      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        {/* 回滚待定态：被回滚消息顶部标记条（v2.14 批 9：主题样式；回滚不编辑，直接输入新消息发送） */}
        {pendingRollback && (
          <div className="flex items-center gap-2 border-b border-line bg-elevated/80 px-4 py-1.5 text-[13px] text-sub">
            <RotateCcw className="h-3.5 w-3.5 shrink-0 text-sub" />
            <span className="min-w-0 flex-1 truncate">
              待回滚 {pendingRollback.count} 条消息——输入新消息发送即从此继续，或点输入框上方的 ✕ 取消
            </span>
          </div>
        )}

        {messages.length === 0 ? (
          /* ── 空态 Hero（v2.14 批 17：去正方体图标；标题艺术字——大号粗体 + 单色渐变，深色主题白→灰）
             v3.3 补 8：无消息时无 header（拖拽区）——顶部加透明 drag 条，窗口最上方任何状态都可拖动（ZCode 式） ── */
          <div className="relative flex h-full flex-col">
            <div className="shrink-0" style={{ WebkitAppRegion: "drag", height: "3.25rem" } as React.CSSProperties} />
            <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-6">
            <div className="hero-glow" />
            <div className="relative flex flex-col items-center gap-4 text-center">
              <div>
                <h1
                  className="text-[56px] font-extrabold leading-[72px] tracking-[0.18em]"
                  style={{
                    // v2.14 批 17 追加：字距拉远（0.18em）+ 渐变层次（顶部纯色高光段 → 灰 → 渐隐透明）
                    // + 微光托底（info 蓝低透明 drop-shadow，深色主题下柔光、浅色下几乎无感）
                    background: "linear-gradient(180deg, var(--text-primary) 0%, var(--text-primary) 22%, var(--text-tertiary) 62%, transparent 100%)",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                    filter: "drop-shadow(0 3px 16px rgba(103, 158, 254, 0.20))",
                  }}
                >
                  无限未来
                </h1>
                <p className="mt-2 text-sm leading-5 text-sub">Forward, infinite future.</p>
              </div>
              {/* 项目 chip（v3：可点击 → 工作区选择菜单；批 12：点击空白处自动收起） */}
              <span ref={wsMenuRef} className="relative">
                <button
                  className="flex cursor-pointer items-center gap-1.5 rounded-2xl px-3 py-1 text-[13px] font-medium text-text transition-colors hover:bg-hover"
                  onClick={() => setWsMenuOpen(!wsMenuOpen)}
                  title={root ? `当前项目：${root}（点击切换）` : "尚未绑定项目（点击选择）"}
                >
                  {root ? <FolderOpen className="h-4 w-4 text-sub" /> : <Folder className="h-4 w-4 text-sub" />}
                  {root ? rootName : "选择项目"}
                  <ChevronDown className="h-3 w-3 text-sub" />
                </button>
                {wsMenuOpen && (
                  <div
                    className="absolute left-1/2 top-8 z-50 min-w-[220px] -translate-x-1/2 rounded-xl border border-line bg-elevated p-1 shadow-lv3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium text-caption">选择项目</div>
                    {projects.length === 0 && (
                      <div className="px-2.5 py-1.5 text-xs text-sub/60">暂无项目——请在左侧栏「项目」区块创建</div>
                    )}
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors hover:bg-hover ${
                          norm(p.root) === norm(root) ? "text-text" : "text-text/85"
                        }`}
                        onClick={() => { setRoot(p.root); setWsMenuOpen(false); }}
                        title={p.root}
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sub" />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {norm(p.root) === norm(root) && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
                      </button>
                    ))}
                  </div>
                )}
              </span>
            </div>
            {/* v3 hero：输入框与 hero 内容一起居中（主流 布局；发送首条后恢复底部固定） */}
            <div className="mt-8 w-full max-w-[780px]">{composer(true)}</div>
            </div>
          </div>
        ) : (
          /* ── 消息流（用户右侧气泡 r22 / 助手无气泡全宽） ── */
          <div className="mx-auto flex max-w-[748px] flex-col gap-4 px-8 py-4">
            {messages.map((m, idx) => {
              const pending = rmIdx >= 0 && idx >= rmIdx;
              const turnEnd = idx + 1 >= messages.length || messages[idx + 1].role === "user";
              return (
                <MessageItem
                  key={m.id}
                  m={m}
                  pending={pending}
                  turnEnd={turnEnd}
                  lastEditIdx={lastEditIdx}
                  isLastUser={idx === lastUserIdx}
                  isWorktreeTarget={idx === lastEditIdx}
                  running={running}
                  rollbackActive={pendingRollback != null}
                  worktreeName={worktree?.name ?? null}
                  mergeBusy={wtBusy}
                  onAskRewind={askRewind}
                  onStartEdit={startEdit}
                  onMerge={doMerge}
                />
              );
            })}
          </div>
        )}

        {/* 运行状态行（主流 TurnStatus：左对齐 shimmer + 等宽时钟） */}
        {running && (
          <div className="mx-auto flex max-w-[748px] items-center gap-2 px-8 pb-3 pt-1 text-[14px] font-medium">
            <span className="shimmer-text">InFu 运行中</span>
            <span className="text-[13px] text-caption [font-variant-numeric:tabular-nums]">
              已用 <ElapsedClock active={running} /> · 点击输入区方块停止
            </span>
            {/* v3.2：断网可见性——退避重试倒计时（对齐 主流 ModelRetryItem 的实时状态感） */}
            {retryInfo && (
              <span className="flex items-center gap-1 text-[13px] text-warn [font-variant-numeric:tabular-nums]">
                <WifiOff className="h-3.5 w-3.5" />
                网络错误，正在重试 {retryInfo.attempt}/{retryInfo.maxAttempts}（{Math.max(1, Math.round(retryInfo.delayMs / 1000))} 秒后）
              </span>
            )}
            {/* v3.2：会话级全权放行状态（点击关闭） */}
            {bypassActive && (
              <button
                className="flex cursor-pointer items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[12px] text-accent transition-colors hover:bg-accent/20"
                onClick={() => {
                  void setApprovalBypass(activeSid ?? "", false);
                  setBypassFor(activeSid ?? "", false);
                }}
                title="本会话已开启全部放行（含联网/自注册/高危命令）；点击关闭，恢复逐项审批"
              >
                <Zap className="h-3 w-3" />
                本会话已全权放行 · 点击关闭
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />

        {/* 回到底部（对齐 主流：sticky 零高槽防撑高/不随内容滚动 + 34px 圆形浮钮 +
            14px 描边下箭头；离底 >240px 时显现，消息列底部居中） */}
        <div className="pointer-events-none sticky bottom-4 z-10 flex h-0 justify-center">
          {showBackTop && (
            <button
              className="pointer-events-auto mt-[-34px] flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-full border border-line bg-elevated text-text shadow-lv2 transition-colors hover:bg-hover"
              onClick={scrollToBottom}
              title="回到底部"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── 输入区（仅消息非空时渲染——hero 模式下输入框与 hero 内容一起居中） ── */}
      {messages.length > 0 && (
      <div className="relative shrink-0 px-8 pb-4 pt-1">
        {/* 贴输入卡上方的渐隐遮罩（滚动内容渐入背景） */}
        <div
          className="pointer-events-none absolute -top-9 left-0 right-0 h-9"
          style={{ background: "linear-gradient(to bottom, transparent, var(--bg-base))" }}
        />

        {/* v3.1 排队发送 dock（运行中输入的消息；编辑/移除/立即发送/拖拽排序） */}
        <QueueDock />

        {/* v2.10 任务清单（todo_write 事件驱动；主流 TodoDock 同款折叠条） */}
        <TodoPanel />

        {/* v3.1 附件预览条（发送前；图片缩略图/文件卡片 + 移除） */}
        <AttachmentRail items={attachments} onRemove={(id) => setAttachments((prev) => prev.filter((x) => x.id !== id))} />

        {/* v2.9：工作树通知已收进输入框右上按钮（见 composer）——不再占用 dock 条空间 */}

        {/* 计划卡片（Planner 输出 → 可编辑 → 批准/拒绝后执行；按 id 重挂载保证编辑态同步） */}
        <PlanCard key={plan?.id ?? "none"} />

        {/* 输入胶囊（v3：composer 复用——审批档位/思考模式下拉 + 用量环 + 模型 + 发送） */}
        {composer(false)}

        {/* 会话统计（主流 StatsLine：居中 12/20 tertiary · 分隔；字数固定 px 防根缩放失真；
            v2.12 四桶：缓存命中（读 cacheHit · 未命中 cacheMiss）· 输出 completionTokens） */}
        <div className="mx-auto mt-1 max-w-[780px] text-center text-[12px] leading-5 text-caption [font-variant-numeric:tabular-nums]">
          {turns} 轮 · {toolCount} 次工具 · 约 {fmtTokens(estTokens)} tokens
          {hitRate != null &&
            ` · 缓存命中 ${Math.round(hitRate * 100)}%（读 ${fmtTokens(usageHit)}${usageMiss > 0 ? ` · 未命中 ${fmtTokens(usageMiss)}` : ""}）`}
          {usageOut > 0 && ` · 输出 ${fmtTokens(usageOut)} tokens`}
        </div>
      </div>
      )}

      {/* v3 终端（仅对话模式；代码模式隐藏） */}
      {terminalOpen && viewMode === "chat" && <TerminalPanel />}

      {/* v2.14 批 9：回滚完成提示（3 秒自动消失；主题样式悬浮条） */}
      {rollbackToast && (
        <div className="absolute bottom-24 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-xl border border-line bg-elevated px-4 py-2 text-[13px] leading-5 text-text shadow-lv3">
          {rollbackToast}
        </div>
      )}
    </main>
  );
}

/**
 * v3.0 UI 审查（对话流优化）：单条消息渲染组件——React.memo 按 props 引用比较。
 * 流式 appendText 每帧重建 messages 数组但只替换最后一条消息对象，旧消息引用不变 →
 * memo 命中跳过整条渲染（不再每帧全量解析历史 markdown / 重建工具行 / 重跑 reduce）。
 * 回调由父组件 useCallback 化（onAskRewind/onStartEdit/onMerge），引用稳定。
 */
const MessageItem = memo(function MessageItem({
  m, pending, turnEnd, lastEditIdx, isLastUser, isWorktreeTarget, running, rollbackActive,
  worktreeName, mergeBusy, onAskRewind, onStartEdit, onMerge,
}: {
  m: ChatMsg;
  pending: boolean;
  turnEnd: boolean;
  lastEditIdx: number;
  isLastUser: boolean;
  isWorktreeTarget: boolean;
  running: boolean;
  rollbackActive: boolean;
  worktreeName: string | null;
  mergeBusy: boolean;
  onAskRewind: (seq: number) => void;
  onStartEdit: (seq: number, text: string) => void;
  onMerge: () => void;
}) {
  // v3.5 常规设置 showThinking（开关变化触发重渲染）
  const showThinking = useStore((s) => s.uiShowThinking);
  return m.role === "user" ? (
    /* 用户消息：右对齐气泡 + 下方悬停操作行（复制/回滚到此）；data-infumsg = 定位浮标锚点 */
    <div data-infumsg={m.id} data-time-hover-root className={`group flex flex-col items-end transition-opacity duration-200 ${pending ? "opacity-40" : ""}`}>
      {pending && (
        <div className="mb-1 flex items-center gap-1 text-xs text-sub">
          <RotateCcw className="h-3 w-3" />
          待回滚
        </div>
      )}
      {/* v3.1 附件行（发送时附加/历史重放） */}
      {m.attachments && m.attachments.length > 0 && <AttachmentLine items={m.attachments} />}
      <div className="max-w-[min(525px,82%)] whitespace-pre-wrap rounded-[22px] bg-bubble px-4 py-2.5 text-[15px] leading-[23px] text-text">
        {/* 主流 projectUserText：气泡内 /name @name 词边界 token 渲染为 refChip */}
        {projectRefText(m.text)}
      </div>
      {!running && !rollbackActive && (
        /* 主流 IconActions（clock start）：图标常显，时间 hover 淡入（80ms）；
           时间在图标前，日期感知时钟（今天 HH:mm / 今年 M月D日 HH:mm / 跨年带年） */
        <div className="mt-1.5 flex h-7 items-center gap-2.5">
          <span className="time-hover whitespace-nowrap text-[14px] leading-6 text-caption [font-variant-numeric:tabular-nums]">
            {fmtClock(m.ts)}
          </span>
          <CopyButton
            text={m.text}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full p-1.5 text-sub transition-colors hover:bg-hover hover:text-text"
          />
          {/* v2.14 批 11：编辑按钮只对最近一条用户消息显示（确认 = 截断历史重发） */}
          {isLastUser && m.seqStart != null && (
            <button
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full p-1.5 text-sub transition-colors hover:bg-hover hover:text-text"
              onClick={() => onStartEdit(m.seqStart!, m.text)}
              title="编辑这条消息（修改后发送：该消息及 AI 的回答会被替换，AI 重新思考）"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {m.seqStart != null && (
            <button
              className="flex h-7 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[13px] text-sub transition-colors hover:bg-hover hover:text-warn"
              onClick={() => onAskRewind(m.seqStart!)}
              title="回滚到这条指令：撤销它及其后的所有内容，可取消"
            >
              <RotateCcw className="h-3 w-3" />
              回滚到此
            </button>
          )}
        </div>
      )}
    </div>
  ) : (
    /* 助手消息（v3：对齐 主流——turn 内连成一条连续流，无头像/无阶段徽标；
       操作行（复制/时间）只在 turn 末尾的总结消息后出现一次） */
    <div data-time-hover-root className={`group transition-opacity duration-200 ${pending ? "opacity-40" : ""}`}>
      {/* 思考过程（折叠行；v3.5 常规设置 showThinking 可关闭） */}
      {m.reasoning && showThinking && <ReasoningBlock text={m.reasoning} running={m.streaming} />}
      {/* v2.2 模型降级事件（v3.2：折叠行；展开显示原因明细） */}
      {m.fallbacks && m.fallbacks.length > 0 && (
        <div className="my-0.5 space-y-0.5">
          {m.fallbacks.map((f, i) => (
            <EventRow
              key={i}
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              iconCls="text-warn/90"
              title="模型降级"
              summary={`${f.from} → ${f.to}`}
              detail={`原因：${f.reason}\n\n主模型 ${f.from} 重试耗尽后自动切换至备用模型 ${f.to}。本任务后续调用将保持使用 ${f.to}，不会自动切回。`}
            />
          ))}
        </div>
      )}
      {/* v2.2 上下文压缩事件（v3.2：折叠行；展开显示摘要明细） */}
      {m.compressed && m.compressed.length > 0 && (
        <div className="my-0.5 space-y-0.5">
          {m.compressed.map((c, i) => (
            <EventRow
              key={i}
              icon={<Files className="h-3.5 w-3.5" />}
              iconCls="text-info/80"
              title="上下文已压缩"
              summary={`${fmtTokens(c.before)} → ${fmtTokens(c.after)}`}
              detail={
                <>
                  <div>历史已摘要为一条消息，为后续对话腾出上下文空间（会话记录无损，可随时回滚查看）。</div>
                  {c.summary ? (
                    <>
                      <div className="mt-1.5 font-medium text-text">摘要</div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[13px] leading-6 text-sub">{c.summary}</div>
                    </>
                  ) : (
                    <div className="mt-1.5 text-caption">（摘要生成失败，已直接丢弃最老部分）</div>
                  )}
                </>
              }
            />
          ))}
        </div>
      )}
      {/* v3.3 后台任务完成通知（对齐 ZCode <task-notification>：EventRow 通知行——
          完成/失败/中止实时可见；展开看摘要；subagent 可点击跳右栏子 Agent tab） */}
      {m.taskNotes && m.taskNotes.length > 0 && (
        <div className="my-0.5 space-y-0.5">
          {m.taskNotes.map((n, i) => {
            const isSub = n.taskType === "subagent";
            const stMeta = n.status === "completed"
              ? { icon: <CheckCircle2 className="h-3.5 w-3.5" />, cls: "text-success", label: "完成" }
              : n.status === "failed"
                ? { icon: <XCircle className="h-3.5 w-3.5" />, cls: "text-danger", label: "失败" }
                : n.status === "stopped"
                  ? { icon: <OctagonX className="h-3.5 w-3.5" />, cls: "text-warn", label: "已停止" }
                  : { icon: <Skull className="h-3.5 w-3.5" />, cls: "text-danger", label: "已终止" };
            return (
              <EventRow
                key={i}
                icon={stMeta.icon}
                iconCls={stMeta.cls}
                title={`后台${isSub ? "子智能体" : "任务"}${stMeta.label}：${n.name}`}
                summary={`${isSub ? n.taskId : `job ${n.taskId}`} · ${n.summary.split("\n")[0]}`}
                detail={
                  <>
                    <div className="font-medium text-text">
                      {isSub ? `子智能体 ${n.taskId}（${n.name}）` : `后台任务 ${n.taskId}`}
                      <span className="ml-1.5 text-caption">{stMeta.label}</span>
                    </div>
                    <div className="mt-0.5 whitespace-pre-wrap text-[13px] leading-6 text-sub">{n.summary}</div>
                    {isSub && (
                      <div className="mt-1.5 text-caption">可在右侧栏「子 Agent」tab 查看完整过程；用 report 回收结果</div>
                    )}
                  </>
                }
              />
            );
          })}
        </div>
      )}
      {/* 错误消息（addError 产生）：专用错误行（对齐 主流 TurnErrorItem：红点 + 标题 + 消息） */}
      {m.text && m.text.startsWith("⚠️ ") ? (
        <div className="flex items-start gap-2 py-0.5">
          <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full bg-danger" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-medium leading-5 text-danger">
              任务失败
              {/* v3.2：错误类型徽标（对齐 主流 code 徽标） */}
              {(() => { const t = classifyError(m.text); return t ? (
                <span className={`rounded px-1.5 py-px text-[11px] font-medium leading-4 ${t.cls}`}>{t.label}</span>
              ) : null; })()}
            </div>
            <div className="text-[13px] leading-5 text-sub">{m.text.slice(2).trim()}</div>
          </div>
        </div>
      ) : (
      <>
      {/* 回答文本（流式 Markdown；环境信息降级为辅助小字，不占消息内容）
          v2.14 批 3：文本在工具行**之前**渲染（模型先说话再调工具；
          中间文本已独立成消息，与工具调用穿插）
          v3.0 UI 审查：已完成消息用 static 模式（不做不完整 markdown 解析/动画），
          避免历史消息每次重渲染重复解析 */}
      {m.text && isEnvInfo(m.text) && (
        <div className="text-[12px] leading-5 text-caption">{m.text}</div>
      )}
      {m.text && !isEnvInfo(m.text) && (
        <div className={`${m.streaming ? "stream-cursor" : ""}`}>
          <Streamdown
            children={m.text}
            mode={m.streaming ? "streaming" : "static"}
            parseIncompleteMarkdown={m.streaming}
            className="infu-md"
            controls={{ table: false, code: false, mermaid: false }}
          />
        </div>
      )}
      {/* 审查意见（v3.1 交付报告已移除；审查保留） */}
      {m.review && <StructuredBlock content={m.review} tone="info" />}
      {m.streaming && !m.text && m.tools.length === 0 && !m.reasoning && (
        <div className="py-1 text-[13px] text-sub">正在思考…</div>
      )}
      {/* Timeline 执行记录（折叠工具行；文本之后） */}
      {m.tools.length > 0 && <Timeline tools={m.tools} />}
      </>
      )}
      {/* turn 尾操作行（主流 TurnTail IconActions clock end）：图标常显，
          时间 hover 淡入（80ms）、时间在图标后、日期感知时钟 + 运行耗时 */}
      {turnEnd && !m.streaming && !isEnvInfo(m.text) && (m.text || m.review) && (
        <div className="mt-1.5 flex h-7 items-center gap-2.5">
          <CopyButton
            text={m.review ?? m.text}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full p-1.5 text-sub transition-colors hover:bg-hover hover:text-text"
          />
          {/* v2.14 批 11：工作树按钮——只出现在「最近一次修改文件的 AI 消息」旁，复制按钮同款，点击直接并入 */}
          {worktreeName != null && isWorktreeTarget && (
            <button
              className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full p-1.5 text-sub transition-colors hover:bg-hover hover:text-info disabled:opacity-50"
              onClick={onMerge}
              disabled={mergeBusy}
              title={`并入主分支（工作树 ${worktreeName}：把任务改动合并回主代码）`}
            >
              {mergeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
              {!mergeBusy && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}
            </button>
          )}
          <span className="time-hover whitespace-nowrap text-[14px] leading-6 text-caption [font-variant-numeric:tabular-nums]">
            {fmtClock(m.ts)}
            {fmtRunMs(m.ts, m.endedAt) && (
              <span className="text-caption">
                <span className="mx-2 text-sub/40">·</span>
                {fmtRunMs(m.ts, m.endedAt)}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
});
