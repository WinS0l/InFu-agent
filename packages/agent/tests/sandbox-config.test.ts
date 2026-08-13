/**
 * 沙箱档位自测（v2.4：resolveSandboxMode 优先级 / resolveEffectiveMode 全组合）
 * 运行：npx tsx packages/agent/tests/sandbox-config.test.ts
 *
 * 覆盖：
 *  - resolveSandboxMode：env 显式优先 > config.sandbox.mode > auto；非法值回退 auto
 *  - resolveEffectiveMode：
 *    auto：docker 可用 → docker；否则 win32+受限 → restricted；否则 soft
 *    restricted：win32+受限 → restricted；否则降级 soft
 *    soft/off/docker 显式原样（docker 不可用由执行层报错，不在此降级）
 */
import {
  resolveSandboxMode, resolveEffectiveMode, SANDBOX_MODES,
} from "../src/sandbox/index.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 沙箱档位自测（v2.4）===\n");

// ── 1. resolveSandboxMode 优先级 ──
console.log("▶ resolveSandboxMode（env > config > auto）");
{
  check("无 env 无 config → auto", resolveSandboxMode({}, null) === "auto");
  check("env auto", resolveSandboxMode({ INFU_SANDBOX: "auto" }, null) === "auto");
  check("env soft", resolveSandboxMode({ INFU_SANDBOX: "soft" }, null) === "soft");
  check("env restricted", resolveSandboxMode({ INFU_SANDBOX: "restricted" }, null) === "restricted");
  check("env docker", resolveSandboxMode({ INFU_SANDBOX: "docker" }, null) === "docker");
  check("env off", resolveSandboxMode({ INFU_SANDBOX: "off" }, null) === "off");
  check("env 大小写不敏感", resolveSandboxMode({ INFU_SANDBOX: "Docker" }, null) === "docker");
  check("env 非法值 → auto", resolveSandboxMode({ INFU_SANDBOX: "evil" }, null) === "auto");

  check("无 env + config restricted → restricted", resolveSandboxMode({}, { sandbox: { mode: "restricted" } }) === "restricted");
  check("无 env + config off → off", resolveSandboxMode({}, { sandbox: { mode: "off" } }) === "off");
  check("无 env + config 空对象 → auto", resolveSandboxMode({}, { sandbox: {} }) === "auto");
  check("无 env + 无 sandbox 节 → auto", resolveSandboxMode({}, {}) === "auto");
  check("无 env + 非法 config → auto", resolveSandboxMode({}, { sandbox: { mode: "nope" as never } }) === "auto");

  check("env 优先于 config", resolveSandboxMode({ INFU_SANDBOX: "soft" }, { sandbox: { mode: "docker" } }) === "soft");
  check("env 非法 + config 合法 → config", resolveSandboxMode({ INFU_SANDBOX: "bad" }, { sandbox: { mode: "docker" } }) === "docker");
}

// ── 2. resolveEffectiveMode：auto 组合 ──
console.log("▶ resolveEffectiveMode：auto（按可用性）");
{
  check("auto + docker 可用 → docker", resolveEffectiveMode("auto", { dockerOk: true, winRestrictedOk: true, platform: "win32" }) === "docker");
  check("auto + 无 docker + win32 + 受限可用 → restricted", resolveEffectiveMode("auto", { dockerOk: false, winRestrictedOk: true, platform: "win32" }) === "restricted");
  check("auto + 无 docker + win32 + 受限不可用 → soft", resolveEffectiveMode("auto", { dockerOk: false, winRestrictedOk: false, platform: "win32" }) === "soft");
  check("auto + 无 docker + linux → soft", resolveEffectiveMode("auto", { dockerOk: false, winRestrictedOk: false, platform: "linux" }) === "soft");
  check("auto + 无 docker + linux + 受限自测通过 → 仍 soft（非 win32 不用受限）", resolveEffectiveMode("auto", { dockerOk: false, winRestrictedOk: true, platform: "linux" }) === "soft");
  check("auto + docker 可用 + linux → docker", resolveEffectiveMode("auto", { dockerOk: true, winRestrictedOk: false, platform: "linux" }) === "docker");
}

// ── 3. resolveEffectiveMode：显式档位 ──
console.log("▶ resolveEffectiveMode：显式档位");
{
  check("restricted + win32 + 受限可用 → restricted", resolveEffectiveMode("restricted", { dockerOk: false, winRestrictedOk: true, platform: "win32" }) === "restricted");
  check("restricted + win32 + 受限不可用 → 降级 soft", resolveEffectiveMode("restricted", { dockerOk: false, winRestrictedOk: false, platform: "win32" }) === "soft");
  check("restricted + linux → 降级 soft", resolveEffectiveMode("restricted", { dockerOk: false, winRestrictedOk: false, platform: "linux" }) === "soft");
  check("restricted + INFU_SANDBOX_RESTRICTED=0 等价（winRestrictedOk=false）→ soft", resolveEffectiveMode("restricted", { dockerOk: false, winRestrictedOk: false, platform: "win32" }) === "soft");

  check("soft 显式 → soft（纯软，不隐式受限）", resolveEffectiveMode("soft", { dockerOk: true, winRestrictedOk: true, platform: "win32" }) === "soft");
  check("off 显式 → off", resolveEffectiveMode("off", { dockerOk: true, winRestrictedOk: true, platform: "win32" }) === "off");
  check("docker 显式 → docker（不可用由执行层报错，不在此降级）", resolveEffectiveMode("docker", { dockerOk: false, winRestrictedOk: false, platform: "win32" }) === "docker");
}

// ── 4. 模式枚举完整性 ──
console.log("▶ SandboxMode 枚举");
{
  check("五档齐全", SANDBOX_MODES.length === 5 && ["auto", "off", "soft", "restricted", "docker"].every((m) => SANDBOX_MODES.includes(m as never)));
}

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
