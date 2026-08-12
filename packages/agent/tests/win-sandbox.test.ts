/**
 * Windows 硬沙箱自测（restricted tokens + job objects，L1.5）
 * 平台/可用性门控：非 Windows 或原生模块未构建时整组跳过（打印 SKIP，不算失败）。
 * 运行：npx tsx packages/agent/tests/win-sandbox.test.ts
 */
import { TOOLS } from "../src/tools/index.js";
import { winRestrictedAvailable, runRestricted } from "../src/sandbox/win-restricted.js";
import { sanitizeEnv } from "../src/sandbox/index.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, AgentEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}
function skip(name: string) {
  skipped++;
  console.log(`  ⏭️  ${name}`);
}

console.log("\n=== Windows 硬沙箱自测（L1.5） ===\n");

const onWindows = process.platform === "win32";
const available = onWindows && (await winRestrictedAvailable());

if (!onWindows) {
  skip("非 Windows 平台，整组跳过");
} else if (!available) {
  skip("原生模块不可用（未构建或 INFU_SANDBOX_RESTRICTED=0），整组跳过");
} else {
  // 与 tools.test.ts 同款夹具
  const proj = mkdtempSync(join(tmpdir(), "infu-sb-"));
  writeFileSync(join(proj, "package.json"), JSON.stringify({
    name: "sb-fixture", version: "1.0.0",
    scripts: { test: "echo sb-test-ok" },
  }, null, 2));
  const events: AgentEvent[] = [];
  const ctx: ToolContext = {
    root: proj,
    cwd: proj,
    requestApproval: async () => true,
    emit: (e) => events.push(e),
  };
  const run = (name: string, args: Record<string, unknown>) => TOOLS[name].execute(args, ctx);
  const env = sanitizeEnv();

  // 1. 基本执行 + stdout 捕获
  console.log("\n▶ 基本执行");
  let r = await runRestricted("echo infu-restricted-hello", proj, 20000, env);
  check("echo 执行并捕获 stdout", !!r && r.ok && r.stdout.includes("infu-restricted-hello"), JSON.stringify(r)?.slice(0, 200));

  // 2. 退出码透传（ok=true 表示进程完成并取得退出码，与 Node exec 语义对齐在 tools 层）
  console.log("\n▶ 退出码");
  r = await runRestricted("exit 42", proj, 20000, env);
  check("exit 42 透传", !!r && r.code === 42, `code=${r?.code}`);
  r = await runRestricted("exit /b 7", proj, 20000, env);
  check("exit /b 7 透传", !!r && r.code === 7, `code=${r?.code}`);

  // 3. env 消毒端到端（sanitizeEnv 已剔除 token 类变量 → 子进程读不到）
  console.log("\n▶ 环境消毒");
  const envWithSecret = { ...env, INFU_TEST_TOKEN: "super-secret-xyz" };
  r = await runRestricted("echo %INFU_TEST_TOKEN%", proj, 20000, sanitizeEnv(envWithSecret));
  check("token 变量不出现在子进程", !!r && !r.stdout.includes("super-secret-xyz"), r?.stdout);

  // 4. 受限令牌权限断言（DISABLE_MAX_PRIVILEGE：特权列表只剩 SeChangeNotify）
  console.log("\n▶ 令牌权限（DISABLE_MAX_PRIVILEGE）");
  r = await runRestricted("C:\\Windows\\System32\\whoami.exe /priv", proj, 30000, env);
  const privs = (r?.stdout.match(/Se[A-Za-z]+Privilege/g) || []).filter((p) => p !== "SeChangeNotifyPrivilege");
  check(
    "受限令牌下特权仅 SeChangeNotifyPrivilege",
    !!r && privs.length === 0 && r.stdout.includes("SeChangeNotifyPrivilege"),
    `level=${r?.level}, 多余特权=${JSON.stringify(privs)}`
  );

  // 4b. LUA_TOKEN：Administrators 组 deny-only（外层为管理员时有区分度）
  console.log("\n▶ 令牌权限（LUA_TOKEN）");
  const adminCheck = 'powershell -NoProfile -Command "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"';
  r = await runRestricted(adminCheck, proj, 30000, env);
  const level = r?.level ?? "none";
  const adminOut = r?.stdout.trim() ?? "";
  check(
    "受限令牌下 IsInRole(Administrator)=False",
    level !== "job-only" && /false/i.test(adminOut),
    `level=${level}, out=${adminOut}`
  );
  if (level === "job-only") console.log("    （提示：受限令牌创建失败已降级为 job-only，权限断言无法验证）");

  // 5. Job Object 超时杀进程树（无限 ping + 前后计数无残留）
  console.log("\n▶ Job Object（超时杀进程树）");
  const countPing = async () => {
    const p = await import("node:child_process");
    const { execFile } = p;
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)("powershell", ["-NoProfile", "-Command", "(Get-Process ping -ErrorAction SilentlyContinue).Count"], { windowsHide: true });
    return parseInt(out.stdout.trim() || "0", 10);
  };
  const before = await countPing();
  r = await runRestricted("ping -t 127.0.0.1", proj, 2000, env);
  check("超时被终止（timedOut）", !!r && r.timedOut, JSON.stringify(r)?.slice(0, 200));
  await new Promise((res) => setTimeout(res, 500)); // 等进程树被 Job 清理
  const after = await countPing();
  check("无 ping.exe 残留", after <= before, `before=${before}, after=${after}`);

  // 6. 引号/特殊字符命令（临时 .cmd 文件路径应免疫转义）
  console.log("\n▶ 引号与特殊字符");
  r = await runRestricted('echo "quoted" & echo pipe^|caret', proj, 20000, env);
  check("双引号命令执行", !!r && r.ok && r.stdout.includes("quoted"), r?.stdout);
  check("& 连接符生效", !!r && r.ok && r.stdout.includes("pipe|caret"), r?.stdout);

  // 6b. 双编码输出：cmd 内置命令（GBK）与 Node 程序（UTF-8）中文均正确
  console.log("\n▶ 输出编码（GBK / UTF-8 双解码）");
  r = await runRestricted("echo 中文GBK输出", proj, 20000, env);
  check("cmd 内置命令中文（GBK）", !!r && r.stdout.includes("中文GBK输出"), JSON.stringify(r?.stdout));
  r = await runRestricted("node -e \"console.log('中文UTF8输出')\"", proj, 20000, env);
  check("Node 程序中文（UTF-8）", !!r && r.stdout.includes("中文UTF8输出"), JSON.stringify(r?.stdout));

  // 7. run_test 经沙箱执行（execLocal 分派）
  console.log("\n▶ run_test 走沙箱");
  const rt = await run("run_test", {});
  check("run_test 执行 npm test", rt.includes("sb-test-ok"), rt);
  check("run_test 输出含沙箱标签", /（(受限沙箱|Docker 沙箱|软沙箱|受限沙箱·仅Job)）/.test(rt), rt);

  // 7b. OS 级写保护：受限进程写系统目录被 OS 拒绝（用 %SystemRoot% 展开避免转义问题）
  console.log("\n▶ OS 级写保护");
  r = await runRestricted('mkdir "%SystemRoot%\\infu-m5-write-test" 2>nul && echo unexpected-write-ok || echo write-blocked', proj, 20000, env);
  check(
    "写系统目录被 OS 拒绝",
    !!r && r.code !== 0 && /write-blocked/.test(r.stdout),
    `code=${r?.code}, out=${JSON.stringify(r?.stdout)}`
  );
  r = await runRestricted('echo ok > "%TEMP%\\infu-m5-write-test.txt" && echo user-write-ok', proj, 20000, env);
  check(
    "工作区/用户可写目录不受影响",
    !!r && r.ok && /user-write-ok/.test(r.stdout),
    `code=${r?.code}, out=${JSON.stringify(r?.stdout)}`
  );

  // 8. run_command 输出带受限沙箱标签
  console.log("\n▶ run_command 标签");
  const cmd = await run("run_command", { command: "echo label-check" });
  check("输出含受限沙箱标签", /（受限沙箱）/.test(cmd), cmd);

  // 清理
  rmSync(proj, { recursive: true, force: true });
}

// 9. 降级路径：INFU_SANDBOX_RESTRICTED=0 → 软沙箱（在门控外，永远可测）
if (onWindows) {
  console.log("\n▶ 降级路径（INFU_SANDBOX_RESTRICTED=0）");
  const prev = process.env.INFU_SANDBOX_RESTRICTED;
  process.env.INFU_SANDBOX_RESTRICTED = "0";
  const proj2 = mkdtempSync(join(tmpdir(), "infu-sb2-"));
  writeFileSync(join(proj2, "package.json"), JSON.stringify({ name: "sb2", version: "1.0.0" }, null, 2));
  const ctx2: ToolContext = {
    root: proj2, cwd: proj2,
    requestApproval: async () => true,
    emit: () => {},
  };
  const r2 = await TOOLS.run_command.execute({ command: "echo degraded-ok" }, ctx2);
  check("受限沙箱被禁用后走软沙箱", r2.includes("degraded-ok") && r2.includes("（软沙箱）"), r2);
  if (prev === undefined) delete process.env.INFU_SANDBOX_RESTRICTED;
  else process.env.INFU_SANDBOX_RESTRICTED = prev;
  rmSync(proj2, { recursive: true, force: true });
} else {
  skip("非 Windows，跳过降级路径测试");
}

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ===`);
process.exit(failed ? 1 : 0);
