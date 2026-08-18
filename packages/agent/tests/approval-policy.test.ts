/**
 * 审批策略自测（v2.4：档位矩阵 / 工具覆盖 / 命令白名单 / guard 集成）
 * 运行：npx tsx packages/agent/tests/approval-policy.test.ts
 *
 * 覆盖：
 *  - resolveApprovalPolicy：缺省节/字段回退默认值（smart）
 *  - shouldAutoApprove：auto/smart/confirm 三档 × low/medium/high × requireExplicit 矩阵
 *  - matchOverride：精确 > 前缀* > 未命中；声明顺序首个命中
 *  - isToolDisabled / resolveToolRisk
 *  - globToRegExp / isCommandAllowed：* 通配、大小写、正则元字符转义
 *  - guard 集成（真实工具 + 数据目录重定向隔离）：auto 不弹窗 / confirm 弹窗 / 禁用拒绝 / 风险覆盖透传
 */
import { TOOLS } from "../src/tools/index.js";
import {
  resolveApprovalPolicy, shouldAutoApprove, matchOverride, isToolDisabled, resolveToolRisk,
  globToRegExp, isCommandAllowed, DEFAULT_POLICY, DEFAULT_COMMAND_ALLOWLIST,
} from "../src/approval/policy.js";
import { saveConfig } from "../src/providers/registry.js";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";
import type { AgentEvent, ToolContext } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 审批策略自测（v2.4）===\n");

// v3.6：数据目录重定向到临时目录（原备份/恢复真实 ~/.infu/config.json 崩溃即污染用户数据）
const tmpData = mkdtempSync(join(tmpdir(), "infu-test-"));
setDataDirForTest(tmpData);

// ── 1. resolveApprovalPolicy 缺省回退 ──
console.log("▶ resolveApprovalPolicy");
{
  const none = resolveApprovalPolicy(null);
  check("无配置 → smart 默认 + 内置默认白名单", none.mode === "smart" && none.toolOverrides.length === 0 && none.commandAllowlist.length > 0);
  const empty = resolveApprovalPolicy({ models: [] });
  check("空配置 → 默认", empty.mode === DEFAULT_POLICY.mode);
  const partial = resolveApprovalPolicy({ models: [], approvalPolicy: { mode: "auto", toolOverrides: [{ tool: "git*", risk: "low" }] } });
  check("部分配置：mode 生效", partial.mode === "auto");
  check("部分配置：白名单 = 内置默认 + 用户配置", partial.commandAllowlist.length >= DEFAULT_COMMAND_ALLOWLIST.length && partial.commandAllowlist.includes("git status*"));
  check("部分配置：toolOverrides 保留", partial.toolOverrides.length === 1);
  const confirm = resolveApprovalPolicy({ models: [], approvalPolicy: { mode: "confirm" } });
  check("confirm 档解析", confirm.mode === "confirm");
}

// ── 2. shouldAutoApprove 档位矩阵 ──
console.log("▶ shouldAutoApprove 档位矩阵");
{
  const auto = { mode: "auto" as const, toolOverrides: [], commandAllowlist: [] };
  const smart = { mode: "smart" as const, toolOverrides: [], commandAllowlist: [] };
  const confirm = { mode: "confirm" as const, toolOverrides: [], commandAllowlist: [] };
  const full = { mode: "full" as const, toolOverrides: [], commandAllowlist: [] };

  check("auto 档 low → 放行", shouldAutoApprove(auto, "low") === true);
  check("auto 档 medium → 放行", shouldAutoApprove(auto, "medium") === true);
  check("auto 档 high → 放行", shouldAutoApprove(auto, "high") === true);
  check("auto 档 + requireExplicit → 人工（不豁免）", shouldAutoApprove(auto, "high", true) === null);
  check("auto 档 + requireExplicit medium → 人工", shouldAutoApprove(auto, "medium", true) === null);

  check("smart 档 low → 放行", shouldAutoApprove(smart, "low") === true);
  check("smart 档 medium → 人工", shouldAutoApprove(smart, "medium") === null);
  check("smart 档 high → 人工", shouldAutoApprove(smart, "high") === null);
  check("smart 档 + requireExplicit → 人工", shouldAutoApprove(smart, "low", true) === null);

  check("confirm 档 low → 人工（全确认）", shouldAutoApprove(confirm, "low") === null);
  check("confirm 档 medium → 人工", shouldAutoApprove(confirm, "medium") === null);
  check("confirm 档 high → 人工", shouldAutoApprove(confirm, "high") === null);
  check("confirm 档 + requireExplicit → 人工", shouldAutoApprove(confirm, "low", true) === null);

  // v3.5 full 档：全权放行——所有级别 + requireExplicit 红线全部自动放行
  check("full 档 low → 放行", shouldAutoApprove(full, "low") === true);
  check("full 档 medium → 放行", shouldAutoApprove(full, "medium") === true);
  check("full 档 high → 放行", shouldAutoApprove(full, "high") === true);
  check("full 档 + requireExplicit → 也放行（全权）", shouldAutoApprove(full, "high", true) === true);
  check("full 档 + requireExplicit medium → 也放行", shouldAutoApprove(full, "medium", true) === true);
}

// ── 3. 工具覆盖 ──
console.log("▶ 工具覆盖（精确 / 前缀 / 顺序）");
{
  const ov = [
    { tool: "write_file", risk: "high" as const },
    { tool: "git*", risk: "low" as const },
    { tool: "run_test", disabled: true },
  ];
  const exact = matchOverride("write_file", ov);
  check("精确名命中", exact?.tool === "write_file");
  const prefix = matchOverride("git_diff", ov);
  check("前缀*命中", prefix?.tool === "git*");
  const none = matchOverride("read_file", ov);
  check("未命中 → undefined", none === undefined);
  const order = matchOverride("write_file", [{ tool: "*", risk: "low" as const }, { tool: "write_file", risk: "high" as const }]);
  check("首个命中生效（先通配后精确 → 通配）", order?.risk === "low");

  check("disabled 命中", isToolDisabled("run_test", ov) === true);
  check("disabled 前缀命中", isToolDisabled("run_test2", [{ tool: "run_test*", disabled: true }]) === true);
  check("未 disabled 不拦", isToolDisabled("write_file", ov) === false);
  check("无覆盖不拦", isToolDisabled("anything", []) === false);

  check("风险覆盖生效", resolveToolRisk("write_file", "medium", ov) === "high");
  check("前缀覆盖生效", resolveToolRisk("git_status", "medium", ov) === "low");
  check("未命中保留基础", resolveToolRisk("read_file", "low", ov) === "low");
  check("覆盖缺 risk 保留基础", resolveToolRisk("run_test", "medium", [{ tool: "run_test", disabled: true }]) === "medium");
}

// ── 4. 命令白名单 ──
console.log("▶ 命令白名单（glob 通配）");
{
  check("精确命中", isCommandAllowed("npm run build", ["npm run build"]) === true);
  check("前缀通配命中", isCommandAllowed("git status", ["git*"]) === true);
  check("通配任意", isCommandAllowed("rm -rf node_modules", ["rm -rf *"]) === true);
  check("未命中", isCommandAllowed("npm run build", ["git*"]) === false);
  check("空白名单不命中", isCommandAllowed("ls", []) === false);
  check("空白容忍", isCommandAllowed("  npm run build  ", ["npm run build"]) === true);
  check("空命令不命中", isCommandAllowed("", ["*"]) === false);
  check("大小写不敏感", isCommandAllowed("NPM RUN BUILD", ["npm run build"]) === true);
  check("正则元字符被转义（. 不当通配）", isCommandAllowed("npmxrunxbuild", ["npm.run.build"]) === false);
  check("glob 转义：问号不匹配任意字符", globToRegExp("a?b").test("axb") === false);
  check("glob：星号匹配多段", globToRegExp("a*b").test("a/very/long/path/b") === true);
}

// ── 5. guard 集成（真实工具 + 临时 config）──
console.log("▶ guard 集成（write_file × 档位）");
{
  // v3.6：config 已重定向到临时数据目录（saveConfig 只写临时目录，无需备份/恢复）
  const proj = mkdtempSync(join(tmpdir(), "infu-approval-"));
  const approvals: Array<{ desc: string; risk: string }> = [];
  const mkCtx = (): ToolContext => ({
    root: proj,
    cwd: proj,
    requestApproval: async (desc, risk) => { approvals.push({ desc, risk }); return true; },
    emit: (e: AgentEvent) => {},
  });

  try {
    // auto 档：不弹窗直接执行
    saveConfig({ models: [], approvalPolicy: { mode: "auto" } });
    approvals.length = 0;
    const autoOut = await TOOLS.write_file.execute({ path: "a.txt", content: "x" }, mkCtx());
    check("auto 档：执行成功", autoOut.includes("已写入"), autoOut);
    check("auto 档：不触发审批", approvals.length === 0, JSON.stringify(approvals));

    // smart 档（默认）：v2.10 文件编辑降 low → 自动放行（对齐主流：写文件不弹窗）
    saveConfig({ models: [], approvalPolicy: { mode: "smart" } });
    approvals.length = 0;
    const smartOut = await TOOLS.write_file.execute({ path: "b.txt", content: "x" }, mkCtx());
    check("smart 档：执行成功", smartOut.includes("已写入"), smartOut);
    check("smart 档：写文件自动放行不弹窗", approvals.length === 0, JSON.stringify(approvals));

    // confirm 档：全部弹窗（含 low 文件编辑）
    saveConfig({ models: [], approvalPolicy: { mode: "confirm" } });
    approvals.length = 0;
    await TOOLS.write_file.execute({ path: "c.txt", content: "x" }, mkCtx());
    check("confirm 档：同样触发审批", approvals.length === 1, JSON.stringify(approvals));

    // auto 档 + 工具风险覆盖（write_file → high）：仍自动放行（档位优先）
    saveConfig({ models: [], approvalPolicy: { mode: "auto", toolOverrides: [{ tool: "write_file", risk: "high" }] } });
    approvals.length = 0;
    await TOOLS.write_file.execute({ path: "d.txt", content: "x" }, mkCtx());
    check("auto 档 + 覆盖 high：仍自动放行", approvals.length === 0, JSON.stringify(approvals));

    // 禁用工具：拒绝执行
    saveConfig({ models: [], approvalPolicy: { mode: "auto", toolOverrides: [{ tool: "write_file", disabled: true }] } });
    const disabledOut = await TOOLS.write_file.execute({ path: "e.txt", content: "x" }, mkCtx());
    check("禁用工具：返回拒绝", disabledOut.includes("用户拒绝"), disabledOut);
    check("禁用工具：未写文件", !existsSync(join(proj, "e.txt")));

    // requireExplicit（mcp_register）在 auto 档也要人工（安全线不豁免）
    saveConfig({ models: [], approvalPolicy: { mode: "auto" } });
    approvals.length = 0;
    const regOut = await TOOLS.mcp_register.execute({ name: "xyz", type: "stdio", command: "node x.mjs" }, mkCtx());
    check("auto 档 + requireExplicit：仍弹窗", approvals.length === 1, JSON.stringify(approvals));
    check("requireExplicit 风险为 high", approvals[0]?.risk === "high");
    check("mock 批准后注册成功", regOut.includes("已注册"), regOut);

    // v3.5 full 档：红线（mcp_register requireExplicit）也直接放行，不触发审批
    saveConfig({ models: [], approvalPolicy: { mode: "full" } });
    approvals.length = 0;
    const fullRegOut = await TOOLS.mcp_register.execute({ name: "xyz2", type: "stdio", command: "node x.mjs" }, mkCtx());
    check("full 档 + requireExplicit：不弹窗", approvals.length === 0, JSON.stringify(approvals));
    check("full 档红线放行后注册成功", fullRegOut.includes("已注册"), fullRegOut);

    // full 档：显式禁用工具仍拒绝（对齐 opencode 显式 deny 不覆盖）
    saveConfig({ models: [], approvalPolicy: { mode: "full", toolOverrides: [{ tool: "write_file", disabled: true }] } });
    const fullDisabledOut = await TOOLS.write_file.execute({ path: "f.txt", content: "x" }, mkCtx());
    check("full 档 + 禁用工具：仍拒绝", fullDisabledOut.includes("用户拒绝"), fullDisabledOut);
  } finally {
    // v3.6：无需恢复——config 已重定向到临时数据目录，随 tmpData 一并清理
  }
}

// 清理临时数据目录（v3.6：只删测试自己的临时目录，绝不动用户 ~/.infu）
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
