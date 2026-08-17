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
import { ShieldAlert, Loader2, RefreshCw, ChevronDown } from "lucide-react";
import { useStore } from "../store";
import { terminalStart, terminalInput, terminalResize, terminalKill, apiFetch } from "../api";
import { CapsuleButton } from "./ui";

/** v3 xterm 配色（跟随设计系统：深色主题 主流 底；浅色主题用白底终端） */
function xtermTheme(dark: boolean) {
  return dark
    ? {
        background: "#151517",
        foreground: "#f9fafb",
        cursor: "#679efe",
        cursorAccent: "#151517",
        selectionBackground: "#35363888",
        black: "#232325",
        red: "#f25a5a",
        green: "#22c55e",
        yellow: "#f7ad31",
        blue: "#679efe",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#f9fafb",
        brightBlack: "#81858c",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      }
    : {
        background: "#ffffff",
        foreground: "#0f1115",
        cursor: "#4176e6",
        cursorAccent: "#ffffff",
        selectionBackground: "#d3e2ff88",
        black: "#0f1115",
        red: "#ec1313",
        green: "#1d9d4b",
        yellow: "#dd8629",
        blue: "#4176e6",
        magenta: "#c026d3",
        cyan: "#0e7490",
        white: "#0f1115",
        brightBlack: "#81858c",
        brightRed: "#e5484d",
        brightGreen: "#2f9e44",
        brightYellow: "#f59e0b",
        brightBlue: "#5686fe",
        brightMagenta: "#a855f7",
        brightCyan: "#22b8cf",
        brightWhite: "#434446",
      };
}

interface PendingApproval {
  command: string;
  description: string;
}

export default function TerminalPanel() {
  const root = useStore((s) => s.root);
  const theme = useStore((s) => s.theme);
  // v3.0 批 12：theme=system → 解析系统实际深浅（xterm 配色跟随）
  const resolvedDark = theme === "system"
    ? (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    : theme === "dark";
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
  // v3.0 批 12：集成终端 shell 选择（常规设置参考）——cmd / powershell / bash
  const [chosenShell, setChosenShell] = useState<string>("");
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
      try {
        const r = await terminalInput(id, { data: command + "\r", command });
        if (r.requireApproval) {
          setApproval({ command, description: r.description ?? `执行高风险命令：${command}` });
        } else if (r.ok === false && r.message) {
          termRef.current?.write(`\r\n⛔ ${r.message}\r\n`);
        }
      } catch (e) {
        termRef.current?.write(`\r\n⛔ 终端请求失败：${(e as Error).message}\r\n`);
      } finally {
        blockedRef.current = false; // M10：异常也解锁（此前网络错误永久冻结输入）
      }
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
      try {
        if (approved) {
          await terminalInput(id, { data: a.command + "\r", command: a.command, confirmed: true });
        } else {
          termRef.current?.write("\r\n⛔ 已拒绝（审批策略）：" + a.command + "\r\n");
        }
      } catch (e) {
        termRef.current?.write(`\r\n⛔ 终端请求失败：${(e as Error).message}\r\n`);
      } finally {
        blockedRef.current = false;
      }
    });
  };

  /** 连接 SSE 输出流 */
  const connectStream = (id: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    (async () => {
      try {
        const res = await apiFetch(`/api/terminal/${encodeURIComponent(id)}/stream`, { signal: controller.signal });
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
      const s = await terminalStart(root || undefined, chosenShell || undefined);
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
      theme: xtermTheme(resolvedDark),
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

  // 主题切换时热更新 xterm 配色（不重建终端，保留缓冲）
  useEffect(() => {
    const t = termRef.current;
    if (t) t.options.theme = xtermTheme(resolvedDark);
  }, [theme]);

  // 首开自动建会话
  useEffect(() => {
    if (!sessionId && !connecting) newSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, connecting]);

  return (
    <div className="flex h-60 shrink-0 flex-col border-t border-line bg-base">
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
        <span className="text-sm font-medium text-text">终端</span>
        {sessionId ? (
          <span className="rounded-lg border border-info/40 bg-info-soft px-1.5 py-px text-[11px] text-info" title="PTY 会话">
            {shell}
          </span>
        ) : (
          <>
            <select
              className="h-6 cursor-pointer rounded-lg border border-line bg-hover px-1.5 text-[11px] text-sub outline-none hover:text-text"
              value={chosenShell}
              onChange={(e) => setChosenShell(e.target.value)}
              title="选择终端 shell（新建会话时生效）"
            >
              <option value="">跟随设置（自动）</option>
              <option value="auto">自动（Git Bash 优先）</option>
              <option value="cmd">CMD</option>
              <option value="powershell">PowerShell</option>
              <option value="bash">Git Bash</option>
            </select>
            <span className="rounded-lg border border-line bg-hover px-1.5 py-px text-[11px] text-sub">未连接</span>
          </>
        )}
        <span className="min-w-0 truncate text-xs text-sub">工作目录：{root}</span>
        {note && <span className="text-xs text-warn">{note}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="flex h-7 cursor-pointer items-center gap-1 rounded-[14px] border border-line px-2.5 text-xs text-sub transition-colors hover:bg-hover hover:text-text"
            onClick={newSession}
            disabled={connecting}
            title="新建终端会话（旧会话将被终止）"
          >
            {connecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            新建会话
          </button>
          {exited && (
            <span className="rounded-lg border border-warn/40 bg-warn-soft px-1.5 py-px text-[11px] text-warn">进程已退出</span>
          )}
        </div>
      </div>

      {/* xterm 容器 */}
      <div ref={containerRef} className="min-h-0 flex-1 px-1.5 py-1" />

      {/* 高危命令确认（统一弹窗风格覆盖层） */}
      {approval && (
        <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: "var(--mask)" }}>
          <div className="w-[440px] rounded-3xl border border-line bg-elevated p-5 shadow-lv3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-danger" />
              <span className="text-[15px] font-medium text-text">高危命令确认</span>
            </div>
            <div className="mt-2.5 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 font-mono text-[13px] text-danger">
              {approval.command}
            </div>
            <div className="mt-2 text-xs leading-5 text-sub">
              删除/格式化类命令存在不可逆风险，需人工确认后才执行。确认后该命令将立即执行。
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <CapsuleButton variant="outline" size="md" onClick={() => decideApproval(false)}>拒绝</CapsuleButton>
              <CapsuleButton variant="dangerPrimary" size="md" onClick={() => decideApproval(true)}>允许执行</CapsuleButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 终端开关按钮（v3：输入框右上方、右边界对齐；往下贴近输入框但不重合；仅对话界面显示） */
export function TerminalToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      className={`absolute -top-8 right-2 z-20 flex h-6 cursor-pointer items-center gap-1.5 rounded-[14px] border px-2.5 text-xs transition-colors ${
        open
          ? "border-info/50 bg-info-soft text-info"
          : "border-line bg-elevated/90 text-text hover:bg-hover"
      }`}
      onClick={onClick}
      title={open ? "收起终端" : "打开终端（v2.4：交互式终端，高危命令需确认）"}
    >
      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <TerminalIcon />}
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
