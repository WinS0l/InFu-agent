/**
 * v3.1 审批流优化自测：会话级「已批准记忆」（approval/cache.ts + guard 集成）
 */
import { guard } from "../src/tools/util.js";
import {
  approvalMemoryKey, approvalRemembered, approvalRemember,
  clearApprovalMemory, resetApprovalMemory, setSessionBypass, isSessionBypassed, clearSessionBypass,
} from "../src/approval/cache.js";
import type { ToolContext, RiskLevel } from "@infu/shared";

const SID = "test-session";
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

console.log("=== v3.1 审批记忆（approval/cache.ts）===");
resetApprovalMemory();

// ── 键生成 ──
ok("命令类：run_command 按命令串为键（不拼风险前缀）", approvalMemoryKey("run_command", "medium", "执行命令：npm install") === "run_command|cmd|执行命令：npm install");
ok("命令类：高危前缀不同 → 键不同", approvalMemoryKey("run_command", "high", "执行高风险命令：rm -rf x") !== approvalMemoryKey("run_command", "medium", "执行命令：rm -rf x"));
ok("工具类：工具+风险+描述", approvalMemoryKey("write_file", "medium", "写入文件：a.ts") === "write_file|medium|写入文件：a.ts");
ok("工具类：风险不同 → 键不同", approvalMemoryKey("write_file", "low", "写入文件：a.ts") !== approvalMemoryKey("write_file", "medium", "写入文件：a.ts"));

// ── 记忆/命中/会话隔离 ──
const k = approvalMemoryKey("run_command", "medium", "执行命令：npm test");
ok("初始未命中", !approvalRemembered(SID, k));
approvalRemember(SID, k);
ok("记住后命中", approvalRemembered(SID, k));
ok("其他会话不命中", !approvalRemembered("other-session", k));
clearApprovalMemory(SID);
ok("清理后不命中", !approvalRemembered(SID, k));

// ── 有界（FIFO 淘汰）──
{
  const sid = "fifo";
  for (let i = 0; i < 300; i++) approvalRemember(sid, `k${i}`);
  ok("超 256 条 FIFO 淘汰最旧", !approvalRemembered(sid, "k0"));
  ok("保留最新", approvalRemembered(sid, "k299"));
  clearApprovalMemory(sid);
}

// ── guard 集成：批准一次 → 同会话同参第二次不弹窗 ──
{
  resetApprovalMemory();
  let popups = 0;
  const ctx: ToolContext = {
    root: process.cwd(), cwd: process.cwd(), sessionId: SID,
    emit: () => {},
    requestApproval: async () => { popups++; return true; },
  } as unknown as ToolContext;
  const r1 = await guard(ctx, "run_command", "medium", "执行命令：npm install");
  ok("首次调用弹窗并批准", r1 === true && popups === 1);
  const r2 = await guard(ctx, "run_command", "medium", "执行命令：npm install");
  ok("第二次同命令直接放行（弹窗数不变）", r2 === true && popups === 1);
  const r3 = await guard(ctx, "run_command", "medium", "执行命令：npm test");
  ok("不同命令仍弹窗", r3 === true && popups === 2);
}

// ── guard 集成：requireExplicit 永不记忆（安全红线）──
{
  resetApprovalMemory();
  let popups = 0;
  const ctx: ToolContext = {
    root: process.cwd(), cwd: process.cwd(), sessionId: SID,
    emit: () => {},
    requestApproval: async () => { popups++; return true; },
  } as unknown as ToolContext;
  const r1 = await guard(ctx, "run_command", "high", "🌐 联网放行执行命令：curl x.com", true);
  ok("红线首次人工批准", r1 === true && popups === 1);
  const r2 = await guard(ctx, "run_command", "high", "🌐 联网放行执行命令：curl x.com", true);
  ok("红线重复出现仍人工（不记忆）", r2 === true && popups === 2);
}

// ── guard 集成：用户拒绝不记忆 ──
{
  resetApprovalMemory();
  let popups = 0;
  const ctx: ToolContext = {
    root: process.cwd(), cwd: process.cwd(), sessionId: SID,
    emit: () => {},
    requestApproval: async () => { popups++; return false; },
  } as unknown as ToolContext;
  await guard(ctx, "run_command", "medium", "执行命令：git push");
  const r2 = await guard(ctx, "run_command", "medium", "执行命令：git push");
  ok("拒绝后再次出现仍弹窗", r2 === false && popups === 2);
}

// ── guard 集成：auto 档不写记忆（本来就放行，无弹窗可省）──
{
  resetApprovalMemory();
  let popups = 0;
  const ctx: ToolContext = {
    root: process.cwd(), cwd: process.cwd(), sessionId: SID,
    emit: () => {},
    requestApproval: async () => { popups++; return true; },
  } as unknown as ToolContext;
  const r = await guard(ctx, "write_file", "low", "写入文件：x.ts");
  ok("low 在 smart 档自动放行且无弹窗", r === true && popups === 0);
}

// ── v3.2 会话级全权放行（approval/cache.ts + guard 集成）──
{
  resetApprovalMemory();
  clearSessionBypass(SID);
  ok("初始未开启", !isSessionBypassed(SID));
  setSessionBypass(SID, true);
  ok("开启后命中", isSessionBypassed(SID));
  ok("其他会话不命中", !isSessionBypassed("other"));
  clearSessionBypass(SID);
  ok("清理后不命中", !isSessionBypassed(SID));

  // guard 集成：bypass 后红线（requireExplicit）不再弹窗
  setSessionBypass(SID, true);
  let popups = 0;
  const ctx: ToolContext = {
    root: process.cwd(), cwd: process.cwd(), sessionId: SID,
    emit: () => {},
    requestApproval: async () => { popups++; return true; },
  } as unknown as ToolContext;
  const r1 = await guard(ctx, "run_command", "high", "🌐 联网放行执行命令：curl x.com", true);
  ok("bypass 后红线直接放行（无弹窗）", r1 === true && popups === 0);
  const r2 = await guard(ctx, "write_file", "medium", "写入文件：a.ts");
  ok("bypass 后普通审批也直接放行", r2 === true && popups === 0);
  // 显式禁用工具仍拒绝（对齐 opencode 显式 deny 不覆盖）
  const r3 = await guard(ctx, "write_file", "medium", "写入文件：b.ts");
  ok("bypass 下普通工具仍放行", r3 === true);
  clearSessionBypass(SID);
  const r4 = await guard(ctx, "run_command", "high", "🌐 联网放行执行命令：curl x.com", true);
  ok("关闭后红线恢复弹窗", r4 === true && popups === 1);
  clearSessionBypass(SID);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);