/**
 * 网络出站软控制策略自测（M6 收尾版）
 *
 * 背景：OS 级按进程断网在本机实测不可行（WFP/AppContainer/专用账号/SYSTEM 辅助
 * 均被加固环境封死，见 docs/ROADMAP.md），M6 落地为应用层命令策略：
 * 外传命令默认拦截（断网语义），network=true 经人工审批放行。
 *
 * 断言内容：
 *  1. detectEgress 检测（工具整词 + 语言组合模式）
 *  2. run_command：默认拦截外传命令 / network=true 审批放行 / 审批拒绝拦截
 *  3. 普通命令不受影响（受限沙箱正常执行）
 *  4. 审计标签 egress-blocked 落库
 */
import { TOOLS } from "../src/tools/index.js";
import { sanitizeEnv, commandLogPath } from "../src/sandbox/index.js";
import { detectEgress, egressBlockedMessage } from "../src/sandbox/net-policy.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";
import type { ToolContext, AgentEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 网络出站软控制策略自测（M6） ===\n");

// v3.6：数据目录重定向到临时目录（原审计断言读真实 ~/.infu/logs/commands.log
// 历史累计——重定向后日志只含本套件自身写入的条目，不再依赖/污染用户数据）
const tmpData = mkdtempSync(join(tmpdir(), "infu-test-"));
setDataDirForTest(tmpData);

// 1. detectEgress 检测
console.log("▶ detectEgress 检测");
check("curl 命中", detectEgress("curl -s https://example.com") === "curl");
check("wget 命中", detectEgress("wget http://x/file") === "wget");
check("nc 命中（管道后）", detectEgress("dir | nc 1.2.3.4 4444") === "nc");
check("ssh 命中", detectEgress("ssh user@host") === "ssh");
check("ssh-keygen 不误伤", detectEgress("ssh-keygen -t ed25519") === null, "ssh-keygen 含 ssh 前缀但整词不匹配");
check("git push 不受影响", detectEgress("git push origin main") === null);
check("npm install 不受影响", detectEgress("npm install") === null);
check("echo curl 保守命中", detectEgress("echo curl") === "curl", "整词出现即拦截（保守策略）");
check("powershell 组合命中", detectEgress('powershell -Command "Invoke-WebRequest http://x"') !== null);
check("python 组合命中", detectEgress('python -c "import urllib.request"') !== null);
check("openssl 本地操作不误伤", detectEgress("openssl genrsa -out k.pem 2048") === null);
check("openssl s_client 命中", detectEgress("openssl s_client -connect h:443") !== null);

// 2-4. run_command 集成
console.log("\n▶ run_command 断网策略");
const proj = mkdtempSync(join(tmpdir(), "infu-net-"));
writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "net-fixture", version: "1.0.0" }));
const env = sanitizeEnv();
const events: AgentEvent[] = [];
const mkCtx = (approve: boolean): ToolContext => ({
  root: proj,
  cwd: proj,
  requestApproval: async () => approve,
  emit: (e) => events.push(e),
});

// 2a. 默认拦截外传命令（未请求 network）
const r1 = await TOOLS.run_command.execute({ command: "curl -s https://example.com" }, mkCtx(true));
check(
  "curl 默认被断网策略拦截",
  r1.includes("断网策略拦截") && r1.includes("curl") && r1.includes("未执行"),
  r1
);
check(
  "拦截后提示改用 network=true",
  r1.includes("network=true"),
  r1
);

// 2b. 普通命令不受影响（受限沙箱正常执行）
const r2 = await TOOLS.run_command.execute({ command: "echo net-ok" }, mkCtx(true));
check("普通命令正常执行（受限沙箱）", r2.includes("net-ok") && r2.includes("受限沙箱"), r2);

// 2c. network=true 审批通过 → 联网放行执行
const r3 = await TOOLS.run_command.execute({ command: "echo net-allowed", network: true }, mkCtx(true));
check("network=true 审批通过 → 联网放行", r3.includes("net-allowed") && r3.includes("联网放行"), r3);

// 2d. network=true 审批拒绝 + 外传命令 → 拦截（不执行）
const r4 = await TOOLS.run_command.execute({ command: "curl -s https://example.com", network: true }, mkCtx(false));
check("network=true 审批拒绝 → 外传命令拦截", r4.includes("断网策略拦截") && r4.includes("未执行"), r4);

// 2e. network=true 审批拒绝 + 普通命令 → 断网执行 + 明确告知
const r5 = await TOOLS.run_command.execute({ command: "echo net-denied", network: true }, mkCtx(false));
check("network=true 审批拒绝 → 普通命令按断网执行并告知", r5.includes("net-denied") && r5.includes("未获联网放行"), r5);

// 3. 审计：egress-blocked 与沙箱档位写入 commands.log
console.log("\n▶ 审计");
// v3.6：logPath 跟随重定向数据目录（commandLogPath）——日志只含本套件自身
// 运行写入的条目（r1/r4 各写一条 egress-blocked），不再读真实历史累计日志
const logPath = commandLogPath();
if (existsSync(logPath)) {
  const log = readFileSync(logPath, "utf-8");
  check("外传拦截写入审计（egress-blocked）", (log.match(/sandbox=egress-blocked/g) ?? []).length >= 2, log.slice(-300));
  check("正常命令审计含沙箱档位", /sandbox=(restricted|soft|docker)/.test(log), log.slice(-300));
} else {
  check("commands.log 存在", false, logPath);
}

// 4. egressBlockedMessage 文案
check("拦截文案含工具名与放行指引", egressBlockedMessage("curl").includes("curl") && egressBlockedMessage("curl").includes("network=true"));

rmSync(proj, { recursive: true, force: true });
// 清理临时数据目录（v3.6：只删测试自己的临时目录，绝不动用户 ~/.infu）
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
