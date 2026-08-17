/**
 * v2.6 收尾联网工具自测（webfetch / web_search；本地 HTTP 服务器 + 审批路径）
 * 运行：npx tsx packages/agent/tests/web-tools.test.ts
 */
import { TOOLS } from "../src/tools/index.js";
import { htmlToText } from "../src/tools/web.js";
import { configPath, saveConfig } from "../src/providers/registry.js";
import { existsSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { ToolContext, AgentEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// v3.5 审计修复：固定 smart 档（备份/恢复）——「只读联网 low 自动放行」断言依赖档位，
// 用户真实配置为 confirm 时 webfetch 靠已批准记忆侥幸通过、web_search 无记忆则被拒（假阴性）
const CONFIG_FILE = configPath();
const CONFIG_HAD = existsSync(CONFIG_FILE);
const CONFIG_BACKUP = join(homedir(), ".infu", "config.json.web-tools-test-backup");
if (CONFIG_HAD) copyFileSync(CONFIG_FILE, CONFIG_BACKUP);
saveConfig({ models: [], approvalPolicy: { mode: "smart" } });

// ── 本地 HTTP 服务器（webfetch 目标）──
// v2.13：SSRF 防护默认拦截本地地址——测试场景显式豁免（仅本套件；生产默认不设）
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
check("web_search 自动放行（返回合理文本）", typeof wsAuto === "string" && (wsAuto.includes("搜索结果") || wsAuto.includes("失败") || wsAuto.includes("未找到")), wsAuto);

// 4. web_search 审批通过但后端失败 → 错误透出（不崩）
console.log("\n▶ web_search");
const ws = await run("web_search", { query: "infu" });
// 通过审批后：可能成功（有网）或失败（无网），都应返回合理文本而非抛异常
check("web_search 返回合理结果", typeof ws === "string" && (ws.includes("搜索结果") || ws.includes("失败") || ws.includes("未找到")), ws);

server.close();
// 恢复用户真实配置
if (CONFIG_HAD) {
  copyFileSync(CONFIG_BACKUP, CONFIG_FILE);
  rmSync(CONFIG_BACKUP, { force: true });
} else {
  rmSync(CONFIG_FILE, { force: true });
}
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
