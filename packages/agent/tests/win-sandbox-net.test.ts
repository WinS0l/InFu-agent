/**
 * 网络出站控制自测（M6，Windows）——WFP 拦截 + 沙箱专用账号 + 审批放行
 * 平台/可用性门控：非 Windows 或原生模块没有 net* 导出时整组跳过。
 * 已 setup（configured）时做真实断网/联网断言；未 setup 时断言"不静默降级"路径。
 * 运行：npx tsx packages/agent/tests/win-sandbox-net.test.ts
 */
import { TOOLS } from "../src/tools/index.js";
import { runRestricted } from "../src/sandbox/win-restricted.js";
import { sanitizeEnv } from "../src/sandbox/index.js";
import { netStatus, netGrant, netIsElevated, resetGrantCache } from "../src/sandbox/sandbox-net.js";
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

console.log("\n=== 网络出站控制自测（M6） ===\n");

const onWindows = process.platform === "win32";
const st = onWindows ? netStatus() : null;
const moduleOk = onWindows && !!st;
const configured = !!st?.configured;

if (!onWindows) {
  skip("非 Windows 平台，整组跳过");
} else if (!moduleOk) {
  skip("原生模块 net* 不可用（未构建或 SAC/WDAC 拦截），整组跳过");
} else {
  console.log(`  状态：configured=${st!.configured} elevated=${st!.elevated} offlineOk=${st!.offlineOk} onlineOk=${st!.onlineOk} rulesOk=${st!.rulesOk}`);
  if (st!.error) console.log(`  （status 提示：${st!.error}）`);

  const proj = mkdtempSync(join(tmpdir(), "infu-net-"));
  writeFileSync(join(proj, "package.json"), JSON.stringify({
    name: "net-fixture", version: "1.0.0",
    scripts: { test: "echo net-test-ok" },
  }, null, 2));
  const env = sanitizeEnv();
  const events: AgentEvent[] = [];
  const mkCtx = (approve: boolean): ToolContext => ({
    root: proj,
    cwd: proj,
    requestApproval: async () => approve,
    emit: (e) => events.push(e),
  });

  // 1. 未配置时：专用账号请求必须显式报错（不静默降级）
  console.log("\n▶ 未配置时的显式失败（降级不静默）");
  if (!configured) {
    const r = await runRestricted("echo should-not-run", proj, 20000, env, "offline");
    check(
      "未 setup 时 sandboxUser=offline 返回明确错误",
      !!r && !r.ok && r.net === "none" && /sandbox-net setup/.test(r.error ?? ""),
      JSON.stringify(r)?.slice(0, 200)
    );
  } else {
    skip("已配置，跳过未配置断言");
  }

  // 2. 已配置时的真实断网/联网断言
  if (configured) {
    // 2a. 工作区授权（Modify + 祖先 Traverse）
    console.log("\n▶ 工作区授权");
    let granted: string[] = [];
    try {
      granted = netGrant(proj);
    } catch (e) {
      check("netGrant 执行", false, (e as Error).message);
    }
    check("授权含工作区 Modify", granted.some((g) => g.includes("Modify")), JSON.stringify(granted));
    check("授权含祖先 Traverse", granted.some((g) => g.includes("Traverse")), JSON.stringify(granted));

    // 2b. 身份：offline 账号下 whoami 是专用账号
    console.log("\n▶ 沙箱账号身份");
    let r = await runRestricted("whoami", proj, 30000, env, "offline");
    check(
      "offline 执行身份 = infu-sandbox-offline",
      !!r && r.ok && r.net === "offline" && r.stdout.includes("infu-sandbox-offline"),
      `net=${r?.net}, out=${JSON.stringify(r?.stdout)}`
    );
    r = await runRestricted("whoami", proj, 30000, env, "online");
    check(
      "online 执行身份 = infu-sandbox-online",
      !!r && r.ok && r.net === "online" && r.stdout.includes("infu-sandbox-online"),
      `net=${r?.net}, out=${JSON.stringify(r?.stdout)}`
    );

    // 2c. 合成档案：HOME/USERPROFILE 重定向到工作区内
    console.log("\n▶ 合成档案目录");
    r = await runRestricted("echo %USERPROFILE%", proj, 20000, env, "offline");
    check(
      "USERPROFILE 重定向到 .infu-sandbox-profile",
      !!r && r.ok && r.stdout.trim().endsWith(".infu-sandbox-profile"),
      JSON.stringify(r?.stdout)
    );

    // 2d. 断网验证（WFP 拦出站）：curl 外网必败
    console.log("\n▶ 断网验证（WFP 拦截出站）");
    r = await runRestricted('curl.exe -sS --max-time 6 https://example.com -o NUL && echo net-ok || echo net-blocked', proj, 30000, env, "offline");
    check(
      "offline 账号 curl 外网失败（WFP 拦截）",
      !!r && (!r.ok || r.code !== 0 || /net-blocked/.test(r.stdout)),
      `code=${r?.code}, out=${JSON.stringify(r?.stdout).slice(0, 200)}`
    );

    // 2e. 联网验证（online 账号放行）——先测宿主网络，不可达则跳过
    console.log("\n▶ 联网验证（online 账号放行）");
    const hostReachable = await fetch("https://example.com", { signal: AbortSignal.timeout(6000) })
      .then((res) => res.status === 200)
      .catch(() => false);
    if (hostReachable) {
      r = await runRestricted('curl.exe -sS --max-time 15 https://example.com -o NUL && echo net-ok || echo net-blocked', proj, 30000, env, "online");
      check(
        "online 账号 curl 外网成功",
        !!r && r.ok && r.code === 0 && /net-ok/.test(r.stdout),
        `code=${r?.code}, out=${JSON.stringify(r?.stdout).slice(0, 200)}`
      );
    } else {
      skip("本机无外网，跳过 online 联网断言");
    }

    // 2f. Job 超时杀进程树在专用账号下仍生效
    console.log("\n▶ Job Object（专用账号下超时杀树）");
    r = await runRestricted("ping -t 127.0.0.1", proj, 2000, env, "offline");
    check("专用账号下超时被终止", !!r && r.timedOut, JSON.stringify(r)?.slice(0, 200));

    // 2g. run_command 默认断网标签 + network 审批流
    console.log("\n▶ run_command 联网决策");
    const ctxAuto = mkCtx(true);
    const cmd1 = await TOOLS.run_command.execute({ command: "whoami" }, ctxAuto);
    check("默认命令含断网标签", /（受限沙箱·断网）/.test(cmd1), cmd1);

    const ctxDeny = mkCtx(false);
    const cmd2 = await TOOLS.run_command.execute({ command: "echo net-denied", network: true }, ctxDeny);
    check(
      "network=true 被拒绝后按断网执行 + 提示",
      /（受限沙箱·断网）/.test(cmd2) && /未获联网放行/.test(cmd2),
      cmd2
    );

    const ctxApprove = mkCtx(true);
    const cmd3 = await TOOLS.run_command.execute({ command: "whoami", network: true }, ctxApprove);
    check("network=true 审批通过走联网账号", /（受限沙箱·联网）/.test(cmd3), cmd3);

    // 2h. 未安装时 network=true 直接拒绝（不静默降级）——只在未配置分支验证过，这里跳过
  } else {
    skip("未 setup（infu sandbox-net setup 后可加测断网/联网），跳过在线断言");
  }

  // 3. 降级路径：INFU_SANDBOX_NET=0 → 走当前用户受限沙箱（门控外，永远可测）
  console.log("\n▶ 降级路径（INFU_SANDBOX_NET=0）");
  const prev = process.env.INFU_SANDBOX_NET;
  process.env.INFU_SANDBOX_NET = "0";
  resetGrantCache();
  const r0 = await TOOLS.run_command.execute({ command: "echo degraded-net-ok" }, mkCtx(true));
  check("禁用后回退当前用户受限沙箱", r0.includes("degraded-net-ok") && /（受限沙箱）/.test(r0) && !r0.includes("断网"), r0);
  if (prev === undefined) delete process.env.INFU_SANDBOX_NET;
  else process.env.INFU_SANDBOX_NET = prev;
  resetGrantCache();

  // 清理
  rmSync(proj, { recursive: true, force: true });
}

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ===`);
process.exit(failed ? 1 : 0);
