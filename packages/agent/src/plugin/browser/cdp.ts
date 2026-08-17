/**
 * CDP 客户端抽象（v3.0 批 8 定稿：宿主注入架构）
 *
 * 桌面模式（Electron）：主进程对每个 webview 的 guest webContents
 * webContents.debugger.attach("1.3") 并注入 __infuCdpSend/__infuCdpOn——
 * Agent 后端与主进程同进程，直接调桥直发 CDP 命令，**不经 playwright**。
 * （playwright connectOverCDP 初始 target 列表过滤 webview 类型 = 批 4-6
 * 灾难根源：tab 不可见/空白堆积/输入焦点污染；批 8 彻底弃用）
 *
 * Web/CLI 模式：playwright CDPSession 封装（headless chromium 保留）。
 * 两模式统一 send/on 接口，ax.ts（AX 树）/tools.ts（点击/输入/求值）共用。
 */
import type { Page } from "playwright-core";

export interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: string, cb: (params: Record<string, unknown>) => void): () => void;
}

const g = globalThis as Record<string, unknown>;

/** 桌面模式判定：agent 后端跑在 Electron 主进程内 */
export function isDesktopMode(): boolean {
  return process.versions.electron !== undefined;
}

/** 桌面模式：主进程桥 CDP 客户端（tabId = webContents.id） */
export function desktopCdpForTab(tabId: string | number): CdpClient {
  const send = g.__infuCdpSend as unknown as (tabId: string | number, method: string, params?: unknown) => Promise<unknown>;
  const on = g.__infuCdpOn as unknown as (tabId: string | number, method: string, cb: (p: unknown) => void) => () => void;
  return {
    send: (method, params) => send(tabId, method, params) as Promise<Record<string, unknown>>,
    on: (event, cb) => on(tabId, event, cb as (p: unknown) => void),
  };
}

/** Web 模式：playwright CDPSession 客户端 */
export async function playwrightCdp(page: Page): Promise<CdpClient> {
  const cdp = await page.context().newCDPSession(page);
  // playwright CDPSession 的 send/on 是强类型键——运行时是通用 CDP 协议，类型断言放宽
  const s = cdp as unknown as {
    send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    on(event: string, cb: (p: unknown) => void): void;
    off(event: string, cb: (p: unknown) => void): void;
  };
  return {
    send: (method, params) => s.send(method, params),
    on: (event, cb) => {
      const h = (p: unknown) => cb(p as Record<string, unknown>);
      s.on(event, h);
      return () => s.off(event, h);
    },
  };
}

/**
 * Runtime.evaluate 统一求值（v3.0 批 8 修复 browser_eval 全挂根因）：
 * DevTools 控制台语义（replMode）——语句（const x=…; 多行）、表达式（document.title）、
 * 函数（() => …）三态通吃；awaitPromise 支持 async；绕开页面 CSP（调试协议直发，非 eval()）。
 * 返回 { value } 序列化值；异常抛 Error（含堆栈前 500 字）。
 */
export async function cdpEvaluate(
  cdp: CdpClient,
  code: string,
  arg?: unknown
): Promise<unknown> {
  let expression = code;
  // 函数体（() => … / function()…）→ 以参数调用（arg 支持数组展开多参）
  if (arg !== undefined) {
    const argsStr = Array.isArray(arg)
      ? arg.map((a) => JSON.stringify(a)).join(", ")
      : JSON.stringify(arg);
    expression = `(() => { const fn = (${code}); return fn(${argsStr}); })()`;
  }
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    replMode: true,
    includeCommandLineAPI: true,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails as Record<string, unknown>;
    const text = (d.exception as { description?: string } | undefined)?.description
      ?? (d.text as string)
      ?? "未知错误";
    console.log(`[browser-eval] ${code.slice(0, 60)} 失败: ${String(text).slice(0, 200)}`);
    throw new Error(String(text).slice(0, 500));
  }
  const result = res.result as {
    value?: unknown;
    type?: string;
    description?: string;
    unserializableValue?: string;
  };
  if (result.unserializableValue) return result.unserializableValue;
  if (result.value === undefined && result.type && result.type !== "undefined") {
    // 不可序列化对象（DOM 节点等）→ 返回描述
    return `[${result.type}] ${result.description ?? ""}`.trim();
  }
  return result.value;
}
