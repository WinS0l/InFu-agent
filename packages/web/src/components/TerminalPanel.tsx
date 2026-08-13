/**
 * v2.4 批 2 Web 交互式终端 — 底部通栏面板（xterm.js + node-pty）
 *
 * 交互模型：
 *  - 输入经 POST /api/terminal/:id/input 写入 PTY（串行队列保证顺序；非命令按键透传不审计）
 *  - 回车结算整行命令 → 携带 command 字段 → 服务端高危检测（rm -rf 等）→ 未确认拦截返回
 *    requireApproval → 弹确认框 → 人工批准后带 confirmed 重发才执行
 *  - 输出经 GET /api/terminal/:id/stream（SSE）→ xterm.write；会话缓冲重放（收起/展开不丢内容）
 *  - 收起 = 断开 SSE（会话保留）；「新建会话」= kill 旧会话换新
 *  - 安全边界：终端 = 用户亲手输入，高危审批 + 全量审计（docs/TERMINAL.md）
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ShieldAlert, X, RefreshCw, Loader2, ChevronDown } from "lucide-react";
import { useStore } from "../store";
import { terminalStart, terminalInput, terminalResize, terminalKill } from "../api";

/** Dark OLED 主题（与设计系统一致：ink 底 + 运行绿） */
const XTERM_THEME = {
  background: "#0f172a",
  foreground: "#f8fafc",
  cursor: "#22c55e",
  cursorAccent: "#0f172a",
  selectionBackground: "#33415588",
  black: "#1e293b",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#f8fafc",
  brightBlack: "#64748b",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

interface PendingApproval {
  command: string;
  description: string;
}

export default function TerminalPanel() {
  const root = useStore((s) => s.root);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lineBufRef = useRef("");
  const escBufRef = useRef("");
  const blockedRef = useRef(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [shell, setShell] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [exited, setExited] = useState(false);
  const [note, setNote] = useState("");

  /** 串行写入队列（保证 PTY 输入顺序） */
  const enqueue = (fn: () => Promise<unknown>) => {
    queueRef.current = queueRef.current.then(fn).catch(() => {});
  };

  /** 提交一行命令（回车结算） */
  const submitCommand = (command: string) => {
    const id = sessionIdRef.current;
    if (!id || blockedRef.current) return;
    blockedRef.current = true; // 等待服务端裁决期间暂停后续输入处理
    enqueue(async () => {
      const r = await terminalInput(id, { data: command + "\r", command });
      if (r.requireApproval) {
        setApproval({ command, description: r.description ?? `执行高风险命令：${command}` });
      } else if (r.ok === false && r.message) {
        termRef.current?.write(`\r\n⛔ ${r.message}\r\n`);
      }
      blockedRef.current = false;
    });
  };

  /** 高危命令确认/拒绝 */
  const decideApproval = async (approved: boolean) => {
    const id = sessionIdRef.current;
    const a = approval;
    setApproval(null);
    if (!id || !a) return;
    blockedRef.current = true;
    enqueue(async () => {
      if (approved) {
        await terminalInput(id, { data: a.command + "\r", command: a.command, confirmed: true });
      } else {
        termRef.current?.write("\r\n⛔ 已拒绝（审批策略）：" + a.command + "\r\n");
      }
      blockedRef.current = false;
    });
  };

  /** 连接 SSE 输出流 */
  const connectStream = (id: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    (async () => {
      try {
        const res = await fetch(`/api/terminal/${encodeURIComponent(id)}/stream`, { signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`终端流连接失败: ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const ev = JSON.parse(dataLine.slice(5).trim());
              if (ev && typeof ev === "object" && "data" in ev) {
                termRef.current?.write(String(ev.data));
              }
            } catch { /* 坏帧忽略 */ }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setNote(`终端流断开：${(e as Error).message}`);
        }
      } finally {
        if (controller === abortRef.current) abortRef.current = null;
      }
    })();
  };

  /** 新建会话（kill 旧会话 + 重建） */
  const newSession = async () => {
    const old = sessionIdRef.current;
    if (old) {
      enqueue(async () => terminalKill(old).catch(() => {}));
    }
    setConnecting(true);
    setExited(false);
    setNote("");
    try {
      const s = await terminalStart(root || undefined);
      sessionIdRef.current = s.id;
      setSessionId(s.id);
      setShell(s.shell);
      termRef.current?.write(`\x1b[2J\x1b[H`);
      connectStream(s.id);
    } catch (e) {
      setNote(`终端创建失败：${(e as Error).message}`);
    } finally {
      setConnecting(false);
    }
  };

  // 初始化 xterm（StrictMode 双挂载安全：cleanup dispose）
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      // 输入模型：命令字符本地缓冲 + 本地预览回显（xterm 输入不自动回显，回显由 PTY 完成）；
      // 回车时清掉预览行、整行发送（服务端按行做高危检测与审计，shell 回显命令 + 输出）；
      // 退格删预览尾字符；控制字符（Ctrl+C 等）与完整转义序列（ESC[...，如 xterm 聚焦
      // 时的 focus 报告）立即透传保证即时响应，且不混入命令缓冲。
      for (const ch of data) {
        if (escBufRef.current) {
          // 转义序列累积：CSI（ESC [ …）从第三字符起遇终结符（0x40-0x7E）结束；
          // OSC（ESC ] …）遇 BEL 或 ESC \ 结束；其余（SS3/单字符序列）遇终结符即结束。
          // 完整序列一次性透传（如 xterm 聚焦时的 focus 报告 ESC[O/ESC[I），不混入命令缓冲。
          escBufRef.current += ch;
          const len = escBufRef.current.length;
          const intro = escBufRef.current[1];
          let done = false;
          if (intro === "[") {
            done = len >= 3 && ch >= "@" && ch <= "~";
          } else if (intro === "]") {
            done = ch === "\x07" || (ch === "\\" && escBufRef.current[len - 2] === "\x1b");
          } else {
            done = ch >= "@" && ch <= "~";
          }
          if (done) {
            const id = sessionIdRef.current;
            if (id) enqueue(() => terminalInput(id, { data: escBufRef.current }).catch(() => {}));
            escBufRef.current = "";
          }
          continue;
        }
        if (ch === "\x1b") {
          escBufRef.current = "\x1b";
          continue;
        }
        if (ch === "\r") {
          const cmd = lineBufRef.current;
          lineBufRef.current = "";
          term.write("\r\x1b[K"); // 回车 + 清当前行：清掉本地预览，等待 shell 回显
          submitCommand(cmd);
        } else if (ch === "\x7f" || ch === "\b") {
          if (lineBufRef.current) {
            lineBufRef.current = lineBufRef.current.slice(0, -1);
            term.write("\b \b"); // 删除预览尾字符
          }
        } else if (ch < " " && ch !== "\t") {
          const id = sessionIdRef.current;
          if (id) enqueue(() => terminalInput(id, { data: ch }).catch(() => {}));
        } else {
          lineBufRef.current += ch;
          term.write(ch); // 本地预览
        }
      }
    });

    // 尺寸同步（fit 后通知 PTY）
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (sessionIdRef.current) {
          terminalResize(sessionIdRef.current, term.cols, term.rows).catch(() => {});
        }
      } catch { /* 面板隐藏时 fit 失败忽略 */ }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      abortRef.current?.abort();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 首开自动建会话
  useEffect(() => {
    if (!sessionId && !connecting) newSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, connecting]);

  return (
    <div className="flex h-60 shrink-0 flex-col border-t border-line bg-ink">
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
        <span className="text-xs font-medium text-text">终端</span>
        {sessionId ? (
          <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10px] text-accent" title="PTY 会话">
            {shell}
          </span>
        ) : (
          <span className="rounded border border-line bg-muted px-1.5 py-px text-[10px] text-sub">未连接</span>
        )}
        <span className="text-[11px] text-sub/70">工作目录：{root}</span>
        {note && <span className="text-[11px] text-warn">{note}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="flex cursor-pointer items-center gap-1 rounded border border-line px-2 py-1 text-[11px] text-sub transition-colors hover:border-accent hover:text-accent"
            onClick={newSession}
            disabled={connecting}
            title="新建终端会话（旧会话将被终止）"
          >
            {connecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            新建会话
          </button>
          {exited && (
            <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-px text-[10px] text-warn">进程已退出</span>
          )}
        </div>
      </div>

      {/* xterm 容器 */}
      <div ref={containerRef} className="min-h-0 flex-1 px-1.5 py-1" />

      {/* 高危命令确认（Dark OLED 风格覆盖层） */}
      {approval && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[440px] rounded-xl border border-danger/40 bg-panel p-4 shadow-2xl">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-danger" />
              <span className="text-sm font-semibold text-text">高危命令确认</span>
            </div>
            <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
              {approval.command}
            </div>
            <div className="mt-2 text-[11px] leading-relaxed text-sub">
              删除/格式化类命令存在不可逆风险，需人工确认后才执行。确认后该命令将立即执行。
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="cursor-pointer rounded border border-line px-3 py-1.5 text-xs text-sub transition-colors hover:bg-muted hover:text-text"
                onClick={() => decideApproval(false)}
              >
                拒绝
              </button>
              <button
                className="cursor-pointer rounded bg-danger px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-danger/85"
                onClick={() => decideApproval(true)}
              >
                允许执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 终端入口按钮图标（供 App 右下角使用） */
export function TerminalToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      className={`fixed bottom-4 right-4 z-40 flex h-9 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-xs shadow-lg backdrop-blur transition-colors ${
        open
          ? "border-accent/60 bg-accent/15 text-accent"
          : "border-line bg-panel/90 text-text hover:border-accent hover:text-accent"
      }`}
      onClick={onClick}
      title={open ? "收起终端" : "打开终端（v2.4：交互式终端，高危命令需确认）"}
    >
      {open ? <ChevronDown className="h-4 w-4" /> : <TerminalIcon />}
      {open ? "收起" : "终端"}
    </button>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="18" rx="2" />
      <path d="M6 8l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 16h6" strokeLinecap="round" />
    </svg>
  );
}

/** 面板右上角「收起」按钮（供工具条使用） */
export function TerminalCollapseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="cursor-pointer rounded p-1 text-sub hover:bg-muted hover:text-text"
      onClick={onClick}
      title="收起终端（会话保留）"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}
