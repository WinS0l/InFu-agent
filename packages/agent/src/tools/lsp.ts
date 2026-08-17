/**
 * LSP 诊断（v3.0 批 11）——TypeScript 自带 tsserver（零外部依赖）
 * tsserver 是 TS 的 LSP 实现（JSON 协议，stdio）——提供语义级诊断
 * （类型错误/未使用变量/隐式 any 等，远超 search_code 的正则匹配）。
 * 实现：spawn tsserver → open 文件 → geterr 请求 → 收集诊断 → 关闭。
 * 轻量封装（一次性会话，按文件诊断）；完整 LSP（跳转/补全）留后续扩展。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
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
        proc.stdin.write(JSON.stringify({ seq: id, type: "request", command, arguments: args }) + "\n");
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
