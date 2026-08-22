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
// v3.9：默认审批档位已改为 full（最大权限）——本套件验证的是「非 full 档位下断网策略
// 拦截语义」，必须显式固定档位（写临时目录 config.json；loadConfig 热读取每调用生效）
writeFileSync(
  join(tmpData, "config.json"),
  JSON.stringify({ version: 2, approvalPolicy: { mode: "smart" } })
);

// 1. detectEgress 检测
console.log("▶ detectEgress 检测");
check("curl 命中", detectEgress("curl -s https://example.com") === "curl");
check("引号 curl 命中", detectEgress('"curl" -s https://example.com') === "curl");
check("caret 转义 curl 命中", detectEgress("c^url -s https://example.com") === "curl");
check("wget 命中", detectEgress("wget http://x/file") === "wget");
check("nc 命中（管道后）", detectEgress("dir | nc 1.2.3.4 4444") === "nc");
check("ssh 命中", detectEgress("ssh user@host") === "ssh");
check("ssh-keygen 不误伤", detectEgress("ssh-keygen -t ed25519") === null, "ssh-keygen 含 ssh 前缀但整词不匹配");
// v3.9 审计修复（M4）：git push/fetch/clone 与 npm/pip install 补入断网策略——
// 此前「不受影响」= 外传/拉包命令漏检；git status/diff 等本地只读仍不受影响
check("git push 命中（外传）", detectEgress("git push origin main") !== null);
check("git status 本地只读不误伤", detectEgress("git status --short") === null);
check("npm install 命中（拉包联网）", detectEgress("npm install") !== null);
check("npm ls 本地查询不误伤", detectEgress("npm ls --depth=0") === null);
// v4.0 审计修复（M3）：参数位置绕过——动词不紧贴工具名时原模式漏检
check("git -C 参数位命中", detectEgress("git -C /repo push origin main") !== null, "git -C 后 push 必须拦截");
check("git --git-dir 参数位命中", detectEgress("git --git-dir=/repo fetch origin") !== null, "git --git-dir 后 fetch 必须拦截");
check("git 选项后 status 不误伤", detectEgress("git -C /repo status --short") === null, "git -C 后本地只读仍放行");
check("npm --prefix 参数位命中", detectEgress("npm --prefix /x install") !== null, "npm --prefix 后 install 必须拦截");
check("npm --prefix ls 不误伤", detectEgress("npm --prefix /x ls") === null, "npm --prefix 后本地查询放行");
check("pip -r 参数位命中", detectEgress("pip -r requirements.txt install") !== null, "pip 选项后 install 必须拦截");
check("pip show 不误伤", detectEgress("pip show requests") === null, "pip show 本地查询放行");
check("npm run 不误伤", detectEgress("npm run build") === null, "npm run 执行本地脚本放行");
check("echo curl 保守命中", detectEgress("echo curl") === "curl", "整词出现即拦截（保守策略）");
check("powershell 组合命中", detectEgress('powershell -Command "Invoke-WebRequest http://x"') !== null);
check("python 组合命中", detectEgress('python -c "import urllib.request"') !== null);
check("openssl 本地操作不误伤", detectEgress("openssl genrsa -out k.pem 2048") === null);
check("openssl s_client 命中", detectEgress("openssl s_client -connect h:443") !== null);

// 2-4. run_command 集成
console.log("\n▶ run_command 断网策略");
const proj = mkdtempSync(join(tmpdir(), "infu-net-"));
writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "net-fixture", version: "1.0.0" }));
sanitizeEnv();
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

// 2b. 普通命令不受影响（auto 可选受限或软沙箱，取决于原生模块可用性）
const r2 = await TOOLS.run_command.execute({ command: "echo net-ok" }, mkCtx(true));
check("普通命令正常执行（有效沙箱）", r2.includes("net-ok") && /（受限沙箱|软沙箱）/.test(r2), r2);

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

// 5. v5.1：full 档（最大审批权限）下外传命令不再被断网策略拦截
// （v3.9 只放行 network=true 路径；未显式请求联网的 egress 命令此前仍被拦——
//  run_test 早已同款放行，run_command 补齐；审计 egress-allowed-full 照常）
console.log("\n▶ full 档断网策略放行");
{
  writeFileSync(
    join(tmpData, "config.json"),
    JSON.stringify({ version: 2, approvalPolicy: { mode: "full" } })
  );
  // 用无害的 egress 命令（echo curl 命中工具整词但无真实网络 I/O）
  const rf = await TOOLS.run_command.execute({ command: "echo curl test" }, mkCtx(true));
  check("full 档 egress 命令直接执行（不再拦截）", rf.includes("curl test") && !rf.includes("断网策略拦截"), rf.slice(0, 200));
  const rt = await TOOLS.run_test.execute({ command: "echo curl test" }, mkCtx(true));
  check("full 档 run_test egress 同样放行", rt.includes("curl test") && !rt.includes("断网策略拦截"), rt.slice(0, 200));
  // 审计标记 egress-allowed-full 落库
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf-8");
    check("full 档放行写入审计（egress-allowed-full）", (log.match(/sandbox=egress-allowed-full/g) ?? []).length >= 2, log.slice(-300));
  } else {
    check("commands.log 存在（full 档）", false, logPath);
  }
  // 恢复 smart 档（loadConfig 热读取——后续无断言依赖，仍恢复保持套件语义一致）
  writeFileSync(
    join(tmpData, "config.json"),
    JSON.stringify({ version: 2, approvalPolicy: { mode: "smart" } })
  );
}

// 6. v5.0（C1）：会话级临时联网（非 full 档——按会话 id 放行，过期自动失效）
console.log("\n▶ 会话级临时联网");
{
  const { setEgressAllow, clearEgressAllow, resetEgressAllow } = await import("../src/egress-allow.js");
  resetEgressAllow();
  setEgressAllow("net-sess-1", 5);
  const ctxNet: ToolContext = { ...mkCtx(true), sessionId: "net-sess-1" };
  const rn = await TOOLS.run_command.execute({ command: "echo curl test" }, ctxNet);
  check("临时联网会话 egress 放行", rn.includes("curl test") && !rn.includes("断网策略拦截"), rn.slice(0, 120));
  const rn2 = await TOOLS.run_command.execute({ command: "echo curl test" }, mkCtx(true));
  check("无临时联网的会话仍拦截", rn2.includes("断网策略拦截"), rn2.slice(0, 120));
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf-8");
    check("临时联网放行写入审计（egress-allowed-temp）", log.includes("sandbox=egress-allowed-temp"), log.slice(-300));
  }
  clearEgressAllow("net-sess-1");
}

rmSync(proj, { recursive: true, force: true });
// 清理临时数据目录（v3.6：只删测试自己的临时目录，绝不动用户 ~/.infu）
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
