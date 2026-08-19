/**
 * LSP 诊断（v3.0 批 11）——TypeScript 自带 tsserver（零外部依赖）
 * tsserver 是 TS 的 LSP 实现（JSON 协议，stdio）——提供语义级诊断
 * （类型错误/未使用变量/隐式 any 等，远超 search_code 的正则匹配）。
 * 实现：spawn tsserver → open 文件 → geterr 请求 → 收集诊断 → 关闭。
 * 轻量封装（一次性会话，按文件诊断）。
 *
 * v6.0（P3）扩展：跳转定义 / 查找引用 / 补全候选（同一 tsserver 会话机制，
 * open 文件后发 definition/references/completionInfo 请求——语义级定位，
 * 与 code_symbols 的语法级提取互补；请求按序等待响应——等程序加载完成，
 * 否则 definition/references 会在项目未就绪时返回空）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path, { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { isPathInside } from "./util.js";

export interface LspDiagnostic {
  file: string;
  line: number;
  text: string;
  severity: "error" | "warning";
}

const _require = createRequire(import.meta.url);
// v3.4 审计修复（M5）：typescript 仅 devDependency——模块顶层 require.resolve 会让
// 生产安装（--omit=dev）import 本模块即抛 MODULE_NOT_FOUND 导致整个 agent 无法启动。
// 改为惰性解析 + 失败标记「LSP 不可用」（空串），不阻塞其他工具。
let TS_SERVER: string | null = null; // null=未探测 | ""=不可用 | 路径=可用
function resolveTsserver(): string | null {
  if (TS_SERVER === null) {
    try {
      TS_SERVER = _require.resolve("typescript/bin/tsserver");
    } catch {
      TS_SERVER = ""; // 生产安装无 typescript → LSP 诊断不可用（工具返回提示）
    }
  }
  return TS_SERVER || null;
}

/** 一次性 tsserver 会话：诊断单文件（返回 error/warning 列表） */
export function lspDiagnoseFile(fileAbs: string, timeoutMs = 20000): Promise<LspDiagnostic[]> {
  return new Promise((resolvePromise) => {
    const tsServer = resolveTsserver();
    if (!tsServer) return resolvePromise([]); // 无 typescript（生产裁剪安装）→ 静默不可用
    if (!existsSync(fileAbs)) return resolvePromise([]);
    if (!/\.(ts|tsx|js|jsx)$/.test(fileAbs)) return resolvePromise([]); // 仅 TS/JS

    let proc;
    try {
      proc = spawn(process.execPath, [tsServer, "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return resolvePromise([]);
    }
    // 审计修复：tsserver 提前退出/崩溃时 proc 级 error 与 stdin EPIPE 无监听——
    // EventEmitter 'error' 无监听器即 throw，server 模式（npm run start）无
    // uncaughtException 兜底会整个服务进程崩溃。挂监听 + write 防御。
    proc.on("error", () => finish([]));
    proc.stdin.on("error", () => { /* stdin 已关闭（tsserver 退出） */ });
    let buf = "";
    let seq = 0;
    let settled = false;
    const finish = (diags: LspDiagnostic[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* 忽略 */ }
      resolvePromise(diags);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    const pending = new Map<number, (m: Record<string, unknown>) => void>();

    const send = (command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = ++seq;
      return new Promise((res) => {
        pending.set(id, res);
        // 审计修复：write 前检查流可用性（tsserver 崩溃后写已关闭的 stdin = EPIPE 异常）
        try {
          if (!proc.stdin.writable) { pending.delete(id); res({ error: true }); return; }
          proc.stdin.write(JSON.stringify({ seq: id, type: "request", command, arguments: args }) + "\n");
        } catch {
          pending.delete(id);
          res({ error: true });
        }
      });
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "response" && pending.has(msg.request_seq)) {
            pending.get(msg.request_seq)?.(msg);
            pending.delete(msg.request_seq);
          }
        } catch { /* 忽略脏行 */ }
      }
    });
    proc.stderr.on("data", () => { /* tsserver 日志 */ });

    void (async () => {
      try {
        await send("open", { file: fileAbs });
        const diagRes = await send("geterr", { files: [fileAbs], delay: 0 });
        const body = (diagRes.body ?? []) as Array<{ file: string; diagnostics: Array<{
          start?: { line: number; offset: number };
          text: string;
          category?: string; // "error" | "warning" | "suggestion"
          code?: number;
        }> }>;
        const out: LspDiagnostic[] = [];
        for (const f of body) {
          for (const d of f.diagnostics ?? []) {
            const cat = d.category === "warning" ? "warning" : "error";
            out.push({
              file: f.file,
              line: (d.start?.line ?? 1),
              text: `${d.text}${d.code ? ` (TS${d.code})` : ""}`,
              severity: cat,
            });
          }
        }
        finish(out);
      } catch {
        finish([]);
      }
    })();
  });
}

/** 便捷：项目内文件诊断（root 边界校验 + 相对路径） */
export async function lspDiagnose(
  root: string,
  relPath: string
): Promise<{ ok: boolean; message: string; diagnostics?: LspDiagnostic[] }> {
  const abs = resolve(root, relPath);
  if (!isPathInside(root, abs)) return { ok: false, message: "错误：路径越界（不允许访问项目根之外）" };
  if (!existsSync(abs)) return { ok: false, message: `错误：文件不存在 ${relPath}` };
  const diags = await lspDiagnoseFile(abs);
  if (!diags.length) return { ok: true, message: `${relPath} 无类型诊断（干净）` };
  const errs = diags.filter((d) => d.severity === "error");
  const warns = diags.filter((d) => d.severity === "warning");
  const lines = diags.map((d) => `${d.file}:${d.line}: ${d.severity === "error" ? "错误" : "警告"} ${d.text}`);
  return {
    ok: errs.length === 0,
    message: `${relPath}：${errs.length} 个错误 / ${warns.length} 个警告\n${lines.join("\n")}`,
    diagnostics: diags,
  };
}

// ══════════════════ v6.0（P3）LSP 跳转/引用/补全 ══════════════════

interface LspOutcome { body?: unknown; success?: boolean }

/** 一次性 tsserver 会话：按序执行请求（前一个响应后才发下一个——等程序加载完成，
 *  否则 definition/references 会在项目未就绪时返回空；原始 lspDiagnoseFile 同款语义），
 *  返回各响应（整体超时返回 null 数组） */
async function lspRun(
  requests: Array<{ command: string; args: Record<string, unknown> }>,
  timeoutMs = 25000
): Promise<Array<LspOutcome | null>> {
  const results: Array<LspOutcome | null> = new Array(requests.length).fill(null);
  const tsServer = resolveTsserver();
  if (!tsServer) return results;
  let proc: ReturnType<typeof spawn> | null = null;
  try {
    proc = spawn(process.execPath, [tsServer, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return results;
  }
  const p = proc; // try/catch 早退后此处必非空（闭包内 TS 无法收窄 let，另存 const）
  await new Promise<void>((resolveReady) => {
    const timer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } resolveReady(); }, timeoutMs);
    let settled = false;
    let buf = "";
    let seq = 0;
    const pending = new Map<number, (o: LspOutcome) => void>();
    p.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "response" && pending.has(msg.request_seq)) {
            const cb = pending.get(msg.request_seq)!;
            pending.delete(msg.request_seq);
            cb(msg as LspOutcome);
          }
        } catch { /* 忽略脏行 */ }
      }
    });
    p.stderr!.on("data", () => { /* tsserver 日志 */ });
    p.stdin!.on("error", () => { /* 已关闭 */ });
    // 审计修复：proc 级 error（spawn 失败/异常退出）无监听会 throw 崩掉宿主进程
    p.on("error", () => { if (!settled) { settled = true; clearTimeout(timer); try { p.kill(); } catch { /* 忽略 */ } resolveReady(); } });
    const sendOne = (command: string, args: Record<string, unknown>): Promise<LspOutcome> => {
      const id = ++seq;
      return new Promise((res) => {
        pending.set(id, res);
        try { p.stdin!.write(JSON.stringify({ seq: id, type: "request", command, arguments: args }) + "\n"); }
        catch { pending.delete(id); res({ success: false }); }
      });
    };
    p.on("spawn", () => {
      void (async () => {
        for (let i = 0; i < requests.length; i++) {
          const r = requests[i];
          // tsserver's `open` is a notification: it intentionally has no response. Waiting for
          // one wastes the per-request timeout on slower CI runners and starves definition.
          if (r.command === "open") {
            try { p.stdin!.write(JSON.stringify({ seq: ++seq, type: "request", command: r.command, arguments: r.args }) + "\n"); }
            catch { /* process failure is handled by the outer timeout/error listener */ }
            continue;
          }
          const id = ++seq;
          const request = new Promise<LspOutcome>((res) => {
            pending.set(id, res);
            try { p.stdin!.write(JSON.stringify({ seq: id, type: "request", command: r.command, arguments: r.args }) + "\n"); }
            catch { pending.delete(id); res({ success: false }); }
          });
          const timeout = new Promise<LspOutcome>((res) => setTimeout(() => {
            pending.delete(id);
            res({ success: false });
          }, Math.min(15000, timeoutMs)));
          results[i] = await Promise.race([request, timeout]);
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { p.kill(); } catch { /* 忽略 */ }
          resolveReady();
        }
      })();
    });
  });
  return results;
}

/** 绝对路径 → 项目内相对路径（大小写不敏感前缀匹配；项目外返回 null） */
function relOf(root: string, abs: string): string | null {
  try {
    const r = resolve(root).toLowerCase();
    const a = resolve(abs).toLowerCase();
    if (!a.startsWith(r + path.sep)) return null;
    return resolve(abs).slice(resolve(root).length).replace(/^[\\/]/, "").split("\\").join("/");
  } catch {
    return null;
  }
}

/** 读文件指定行作为上下文片段（≤120 字符；失败返回空串） */
function readSnippet(abs: string, line: number): string {
  try {
    const s = (readFileSync(abs, "utf-8").split("\n")[line - 1] ?? "").trim();
    return s ? s.slice(0, 120) : "";
  } catch {
    return "";
  }
}

/** 位置入参校验（root 边界 + 存在性） */
function checkPosition(root: string, relPath: string, line: number): { ok: true; abs: string } | { ok: false; message: string } {
  if (!relPath.trim()) return { ok: false, message: "错误：file 必填" };
  const abs = resolve(root, relPath);
  if (!isPathInside(root, abs)) return { ok: false, message: "错误：路径越界（不允许访问项目根之外）" };
  if (!existsSync(abs)) return { ok: false, message: `错误：文件不存在 ${relPath}` };
  if (!/\.(ts|tsx|js|jsx)$/.test(abs)) return { ok: false, message: `错误：仅支持 TS/JS 文件（${relPath}）` };
  if (!line || line < 1) return { ok: false, message: "错误：line 必须 ≥1" };
  return { ok: true, abs };
}

/** 跳转定义：返回首个定义位置（项目内展示相对路径 + 上下文行；项目外仅提示） */
export async function lspGotoDefinition(
  root: string,
  relPath: string,
  line: number,
  offset = 1,
  timeoutMs = 25000
): Promise<{ ok: boolean; message: string }> {
  const c = checkPosition(root, relPath, line);
  if (!c.ok) return { ok: false, message: c.message };
  const [, def] = await lspRun([
    { command: "open", args: { file: c.abs } },
    { command: "definition", args: { file: c.abs, line, offset } },
  ], timeoutMs);
  // 定义响应体为数组（可能为空）；{ body: { defs } } 形态兜底
  const bodyRaw = def?.body as unknown;
  const body = Array.isArray(bodyRaw)
    ? (bodyRaw as Array<{ file?: string; start?: { line?: number; offset?: number } }>)
    : Array.isArray((bodyRaw as { defs?: unknown } | null)?.defs)
      ? ((bodyRaw as { defs: Array<{ file?: string; start?: { line?: number; offset?: number } }> }).defs)
      : [];
  if (!body.length) {
    return { ok: true, message: `未找到 ${relPath}:${line}:${offset} 的定义——可能是内置对象/三方包符号，或该位置不是标识符` };
  }
  const t = body[0] as { file?: string; start?: { line?: number; offset?: number } };
  const rel = t.file ? relOf(root, t.file) : null;
  if (!rel) return { ok: true, message: `定义在项目外：${t.file}（不展示越界内容）` };
  const l = t.start?.line ?? 1;
  const snippet = readSnippet(resolve(root, rel), l);
  return { ok: true, message: `定义位置：${rel}:${l}:${t.start?.offset ?? 1}${snippet ? `  ${snippet}` : ""}` };
}

const KIND_TEXT: Record<string, string> = {
  class: "类", interface: "接口", type: "类型", enum: "枚举", enummember: "枚举成员",
  function: "函数", method: "方法", member: "成员", property: "属性", var: "变量",
  localvar: "局部变量", const: "常量", module: "模块", alias: "别名", keyword: "关键字",
  parameter: "参数", let: "变量", string: "字符串", number: "数字", boolean: "布尔",
  primitive: "原始类型", script: "脚本", typeparameter: "类型参数", constructor: "构造函数",
};

/** 补全候选：返回排序后的名称 + 类型标注（过滤内部/废弃） */
export async function lspCompletions(
  root: string,
  relPath: string,
  line: number,
  offset = 1,
  timeoutMs = 25000
): Promise<{ ok: boolean; message: string }> {
  const c = checkPosition(root, relPath, line);
  if (!c.ok) return { ok: false, message: c.message };
  const [, comp] = await lspRun([
    { command: "open", args: { file: c.abs } },
    { command: "completionInfo", args: { file: c.abs, line, offset, includeExternalModuleNames: false, includeInsertTextCompletions: false } },
  ], timeoutMs);
  const entries = (comp?.body as { entries?: Array<{ name?: string; kind?: string; kindModifiers?: string }> } | undefined)?.entries ?? [];
  const clean = entries.filter(
    (e) => typeof e.name === "string" && e.name && !e.name.startsWith("///") && !e.name.startsWith("__") && !(e.kindModifiers ?? "").includes("deprecated")
  );
  if (!clean.length) return { ok: true, message: `${relPath}:${line}:${offset} 无补全候选（文件需可解析且该位置在代码上下文中）` };
  const shown = clean.slice(0, 40);
  const lines = shown.map((e) => `${e.name} (${KIND_TEXT[e.kind ?? ""] ?? e.kind ?? "符号"})`).join("\n");
  const more = clean.length > shown.length ? `（其余 ${clean.length - shown.length} 个省略）` : "";
  return { ok: true, message: `补全候选 ${clean.length} 个${more}：\n${lines}` };
}

/** 查找引用：项目内引用列表（含声明本身；项目外计数提示） */
export async function lspFindReferences(
  root: string,
  relPath: string,
  line: number,
  offset = 1,
  timeoutMs = 25000
): Promise<{ ok: boolean; message: string }> {
  const c = checkPosition(root, relPath, line);
  if (!c.ok) return { ok: false, message: c.message };
  const [, refs] = await lspRun([
    { command: "open", args: { file: c.abs } },
    { command: "references", args: { file: c.abs, line, offset } },
  ], timeoutMs);
  // tsserver references 响应体为 { refs: [...] }（非裸数组）——两种形态都兼容
  const bodyRaw = refs?.body as unknown;
  const body = Array.isArray(bodyRaw)
    ? (bodyRaw as Array<{ file?: string; start?: { line?: number; offset?: number } }>)
    : Array.isArray((bodyRaw as { refs?: unknown } | null)?.refs)
      ? ((bodyRaw as { refs: Array<{ file?: string; start?: { line?: number; offset?: number } }> }).refs)
      : [];
  const seen = new Set<string>();
  const inside: string[] = [];
  let outside = 0;
  for (const r of body) {
    const rel = r.file ? relOf(root, r.file) : null;
    if (!rel) { outside++; continue; }
    const key = `${rel}:${r.start?.line ?? 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inside.push(`${rel}:${r.start?.line ?? 1}:${r.start?.offset ?? 1}`);
  }
  const shown = inside.slice(0, 30);
  const more = inside.length > shown.length ? `（其余 ${inside.length - shown.length} 处省略）` : "";
  if (!inside.length && !outside) return { ok: true, message: `${relPath}:${line}:${offset} 未找到引用——该位置可能不是标识符` };
  return {
    ok: true,
    message: `找到 ${body.length} 处引用（含声明本身；项目内 ${inside.length} 处${outside ? `，项目外 ${outside} 处` : ""}）：\n${shown.join("\n")}${more}`,
  };
}
