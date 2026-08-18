/**
 * v2.6 收尾联网工具自测（webfetch / web_search；本地 HTTP 服务器 + 审批路径）
 * 运行：npx tsx packages/agent/tests/web-tools.test.ts
 */
import { TOOLS } from "../src/tools/index.js";
import { htmlToText } from "../src/tools/web.js";
import { saveConfig } from "../src/providers/registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";
import { createServer, type Server } from "node:http";
import type { ToolContext, AgentEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// v3.5 审计修复：固定 smart 档——「只读联网 low 自动放行」断言依赖档位，
// 用户真实配置为 confirm 时 webfetch 靠已批准记忆侥幸通过、web_search 无记忆则被拒（假阴性）
// v3.6：数据目录重定向到临时目录（原备份/恢复真实 ~/.infu/config.json 崩溃即污染用户数据）
const tmpData = mkdtempSync(join(tmpdir(), "infu-test-"));
setDataDirForTest(tmpData);
saveConfig({ models: [], approvalPolicy: { mode: "smart" } });

// ── 本地 HTTP 服务器（webfetch 目标）──
// v2.13：SSRF 防护默认拦截本地地址——测试场景显式豁免（仅本套件；生产默认不设）
// v3.6：记录原值并在末尾恢复（原实现设置后不恢复——本进程内后续 SSRF 拦截全部失效）
const ORIG_ALLOW_PRIVATE = process.env.INFU_ALLOW_PRIVATE_URL;
process.env.INFU_ALLOW_PRIVATE_URL = "1";
let server: Server;
let base = "";
await new Promise<void>((resolve) => {
  server = createServer((req, res) => {
    if (req.url !== "/") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!DOCTYPE html><html><head><title>Infu 测试页</title><style>body{color:red}</style></head><body><h1>Hello InFu</h1><p>联网抓取测试 &amp; 内容</p><script>alert(1)</script></body></html>`);
  });
  server.listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    resolve();
  });
});

const events: AgentEvent[] = [];
const ctx: ToolContext = {
  root: process.cwd(),
  cwd: process.cwd(),
  requestApproval: async () => true,
  emit: (e) => events.push(e),
};
const run = (name: string, args: Record<string, unknown>) => TOOLS[name].execute(args, ctx);

console.log("\n=== v2.6 收尾联网工具自测 ===\n");

// 1. htmlToText
console.log("▶ htmlToText");
const text = htmlToText("<div>a <b>b</b> &amp; c<script>var x=1</script><style>.x{}</style></div>");
check("去标签保留文本", text === "a b & c", text);
const text2 = htmlToText("<script>bad()</script><p>good</p>");
check("去脚本", text2.includes("good") && !text2.includes("bad"), text2);

// 2. webfetch
console.log("\n▶ webfetch");
const wf = await run("webfetch", { url: base });
check("抓取本地页面成功", wf.includes("Hello InFu") && wf.includes("联网抓取测试"), wf);
check("脚本已剥离", !wf.includes("alert"), wf);
const wfBad = await run("webfetch", { url: "ftp://example.com/x" });
check("非 http/https 拒绝", wfBad.includes("仅支持 http/https"), wfBad);
const wf404 = await run("webfetch", { url: base + "nope" });
check("404 报错透出", /HTTP 404|抓取失败/.test(wf404), wf404);

// 3. v2.10 批 4：只读联网降 low → 自动放行（不弹审批；requestApproval 拒绝也不拦截）
console.log("\n▶ 联网门禁（low 自动放行）");
let netApprovals = 0;
const autoCtx: ToolContext = { ...ctx, requestApproval: async () => { netApprovals++; return false; } };
const wfAuto = await TOOLS.webfetch.execute({ url: base }, autoCtx);
check("webfetch 自动放行执行成功", wfAuto.includes("Hello InFu"), wfAuto);
check("webfetch 未触发审批", netApprovals === 0, `approvals=${netApprovals}`);
const wsAuto = await TOOLS.web_search.execute({ query: "infu" }, autoCtx);
// v3.6 恒真断言修复：原 web_search 走真实 Bing/DDG 网络（成败皆过、测不到解析正确性）
// → mock Bing RSS 返回固定结果，断言真实解析（标题/链接/摘要字段）
const ORIG_FETCH = globalThis.fetch;
(globalThis as any).fetch = async (url: unknown, init?: unknown) => {
  if (String(url).includes("bing.com/search")) {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Bing</title>` +
      `<item><title>InFu 测试搜索结果</title><link>https://example.com/infu</link><description>InFu 是一个 AI 编程助手</description></item>` +
      `</channel></rss>`;
    return new Response(xml, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8" } });
  }
  return ORIG_FETCH(url as RequestInfo | URL, init as RequestInit | undefined);
};
try {
  const wsMock = await TOOLS.web_search.execute({ query: "infu" }, autoCtx);
  check("web_search 解析 mock 结果（标题）", wsMock.includes("InFu 测试搜索结果"), wsMock);
  check("web_search 解析 mock 结果（链接）", wsMock.includes("https://example.com/infu"), wsMock);
} finally {
  globalThis.fetch = ORIG_FETCH;
}

// 4. web_search 审批通过但后端失败 → 错误透出（不崩）
console.log("\n▶ web_search");
const ws = await run("web_search", { query: "infu" });
// 通过审批后：可能成功（有网）或失败（无网），都应返回合理文本而非抛异常
check("web_search 返回合理结果", typeof ws === "string" && ws.length > 0, ws);

server.close();
// v3.6：恢复 INFU_ALLOW_PRIVATE_URL 原值（原实现遗留——同进程后续 SSRF 拦截全失效）
if (ORIG_ALLOW_PRIVATE === undefined) delete process.env.INFU_ALLOW_PRIVATE_URL;
else process.env.INFU_ALLOW_PRIVATE_URL = ORIG_ALLOW_PRIVATE;
// 清理临时数据目录（v3.6：只删测试自己的临时目录，绝不动用户 ~/.infu）
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
