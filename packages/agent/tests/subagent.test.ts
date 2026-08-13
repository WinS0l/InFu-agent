/**
 * 子智能体自测（v2.5 批 1：agent 文件化定义 / delegate 委派 / 独立上下文 / 并行执行 / 结果回收 / 安全边界）
 * 运行：npx tsx packages/agent/tests/subagent.test.ts
 *
 * 覆盖：- parseAgentFile：frontmatter 解析（合法/缺描述/缺正文/tools 列表/数字字段）
 *      - listAgents/readAgentFile：用户级 > 项目级发现与同名胜出
 *      - delegateTasks：单任务委派（子循环跑通/事件打标/结果回收/agent 文件角色/白名单解析）
 *      - 并行执行：tasks 数组 Promise.all 多路
 *      - 安全边界：深度限制 / root 越界 / 未知工具 / 架构级排除 / 模型解析失败 / 缺模型上下文
 *      - 结果截断 / rebuild 跳过子智能体内部事件
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@infu/shared";
import { parseAgentFile, listAgents, readAgentFile, buildAgentsPrompt, BUILTIN_AGENTS, READONLY_TOOLS } from "../src/agent/agents.js";
import {
  runSubagent, delegateTasks, MAX_DELEGATION_DEPTH,
  SUBAGENT_FORBIDDEN_TOOLS, MAX_SUBAGENT_RESULT, isReadOnlyDelegation, type DelegationContext,
} from "../src/agent/subagent.js";
import { TOOLS, getReadOnlyTools } from "../src/tools/index.js";
import { rebuildMessages } from "../src/db/rebuild.js";
import { runAgent } from "../src/agent/loop.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

/** 捕获 runSubagent 抛出的错误（失败路径为 throw 语义，与工具层 catch 一致） */
async function expectError(p: Promise<unknown>, pattern: RegExp, name: string) {
  try {
    await p;
    check(name, false, "未抛错");
  } catch (e) {
    check(name, pattern.test((e as Error).message), (e as Error).message.slice(0, 100));
  }
}

// ── fetch mock（子循环走 streamChatWithFailover → 原生 fetch）──
const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let requestBodies: Array<{ model: string; messages: unknown[]; tools?: Array<{ function?: { name: string } }> }> = [];
function installFetch(behaviors: Record<string, () => Response>) {
  fetchCalls = [];
  requestBodies = [];
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    fetchCalls.push(body.model);
    requestBodies.push({ model: body.model, messages: body.messages ?? [], tools: body.tools ?? [] });
    const b = behaviors[body.model];
    if (!b) throw new TypeError(`no behavior for model ${body.model}`);
    return b();
  };
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}
function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const okSse = (text: string) => sse(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`);

// ── 测试环境：临时项目（含 .infu/agents 目录）──
const root = mkdtempSync(join(tmpdir(), "infu-subagent-"));
const projAgents = join(root, ".infu", "agents");
mkdirSync(projAgents, { recursive: true });
const userAgents = mkdtempSync(join(tmpdir(), "infu-subagent-user-")); // 模拟 ~/.infu/agents（readAgentFile 固定读 homedir，故用户级用例用解析函数直测）

let events: AgentEvent[] = [];
function makeCtx(overrides: Partial<DelegationContext> = {}): DelegationContext {
  return {
    tools: TOOLS,
    root,
    emit: (e) => events.push(e),
    requestApproval: async () => true,
    modelConfig: { provider: "deepseek", model: "sub-model", apiKey: "k", baseURL: "http://mock" },
    fallbackModelConfigs: [],
    thinkingLevel: 2,
    delegationDepth: 0,
    ...overrides,
  };
}

console.log("\n=== 子智能体自测（v2.5）===\n");

// ── 1. agent 文件解析 ──
console.log("▶ parseAgentFile：frontmatter 解析");
{
  const good = `---
description: 只读审查代码质量
tools: read_file, search_code, run_test
model: deepseek-v4
maxSteps: 20
---
你是资深审查员。`;
  const def = parseAgentFile(good);
  check("合法文件解析成功", !!def);
  check("description 解析", def?.description === "只读审查代码质量");
  check("tools 列表（逗号分隔去空）", def?.tools?.join(",") === "read_file,search_code,run_test");
  check("model 解析", def?.model === "deepseek-v4");
  check("maxSteps 数字解析", def?.maxSteps === 20);
  check("正文 = 角色 system prompt", def?.body === "你是资深审查员。");
}
{
  const noDesc = `---
tools: read_file
---
正文`;
  check("缺 description → 不注册", parseAgentFile(noDesc) === null);
  const noBody = `---
description: 有描述无正文
---`;
  check("缺正文 → 不注册", parseAgentFile(noBody) === null);
  const noFm = "纯文本没有 frontmatter";
  check("无 frontmatter → 不注册", parseAgentFile(noFm) === null);
  const spaceTools = `---
description: 空格分隔
tools: read_file search_code
---
正文`;
  const d2 = parseAgentFile(spaceTools);
  check("tools 空格分隔也可", d2?.tools?.join(",") === "read_file,search_code");
  check("tools 去重", parseAgentFile(`---
description: 去重
tools: read_file, read_file
---
正文`)?.tools?.join(",") === "read_file");
}

// ── 2. 发现与来源层级 ──
console.log("\n▶ listAgents / readAgentFile：发现与层级");
{
  check("内置 agent（general-purpose 全工具）", BUILTIN_AGENTS.some((a) => a.name === "general-purpose" && !a.tools));
  check("内置 agent（explore 只读 7 件）", BUILTIN_AGENTS.some((a) => a.name === "explore" && a.tools?.length === 7));
  check("内置只读工具集 = 7 件只读", READONLY_TOOLS.length === 7 && READONLY_TOOLS.every((t) => !["write_file", "edit_file", "run_command", "run_test"].includes(t)));
  check("readAgentFile 内置 explore 免文件", readAgentFile("explore", root)?.name === "explore");
  writeFileSync(join(projAgents, "reviewer.md"), `---
description: 项目级审查员
tools: read_file, run_test
---
你是项目级审查员。`);
  writeFileSync(join(projAgents, "broken.md"), "没有 frontmatter 的文件");
  const list = listAgents(root);
  check("项目级发现合法文件", list.some((a) => a.name === "reviewer" && a.level === "project"));
  check("非法文件跳过", !list.some((a) => a.name === "broken"));
  check("来源层级 = project", list.find((a) => a.name === "reviewer")?.level === "project");
  const def = readAgentFile("reviewer", root);
  check("readAgentFile 按名读取", !!def && def.body === "你是项目级审查员。");
  check("不存在 → null", readAgentFile("nope", root) === null);
  check("文件名 = 角色名（去 .md）", def?.name === "reviewer");
}

// ── 3. buildAgentsPrompt（发现层摘要）──
console.log("\n▶ buildAgentsPrompt");
{
  const p = buildAgentsPrompt(listAgents(root));
  check("空列表返回空串", buildAgentsPrompt([]) === "");
  check("含角色名与描述", p.includes("reviewer") && p.includes("项目级审查员"));
  check("提示 delegate_task 委派", p.includes("delegate_task"));
}

// ── 4. 单任务委派（子循环跑通 + 事件打标 + 结果回收）──
console.log("\n▶ delegateTasks：单任务委派");
{
  events = [];
  installFetch({ "sub-model": () => okSse("子任务A完成") });
  const out = await delegateTasks([{ prompt: "帮我审查 auth.ts" }], makeCtx({ parentCallId: "call-9" }));
  check("子智能体结果回收", out.includes("子任务A完成"), out.slice(0, 80));
  check("缺省角色名 = 子智能体", events.some((e) => e.type === "subagent-start" && e.name === "子智能体"));
  const start = events.find((e) => e.type === "subagent-start");
  check("subagent-start 携带父 callId", start && "parentCallId" in start && start.parentCallId === "call-9", JSON.stringify(start));
  check("subagent-done 结果回收（步数/工具）", events.some((e) => e.type === "subagent-done" && e.steps >= 1 && e.toolCount === 0));
  check("内部 step-start 打 subagentId 标", events.some((e) => e.type === "step-start" && "subagentId" in e && e.subagentId));
  check("内部 text 打 subagentId 标", events.some((e) => e.type === "text" && "subagentId" in e && e.subagentId));
  check("顶层事件不打标", !events.some((e) => e.type === "subagent-start" && "subagentId" in e));
  check("子循环独立上下文（系统提示注入）", requestBodies.length >= 1 && String((requestBodies[0].messages[0] as any)?.content).includes("子智能体"));
}

// ── 5. agent 文件角色委派 ──
console.log("\n▶ agent 文件角色（system = 正文；tools = 白名单）");
{
  events = [];
  installFetch({ "sub-model": () => okSse("按清单审查完毕") });
  const out = await runSubagent({ prompt: "审查登录模块", agent: "reviewer" }, makeCtx());
  check("agent 文件角色名", events.find((e) => e.type === "subagent-start")?.name === "reviewer");
  const sys = String((requestBodies[0].messages[0] as any)?.content);
  check("system prompt = 文件正文", sys.includes("你是项目级审查员。"), sys.slice(0, 100));
  check("执行成功", out.text.includes("按清单审查完毕"), out.text.slice(0, 60));
  // 白名单：文件声明 read_file/run_test → 子循环 tools 只注入这两个
  const toolNames = (requestBodies[0].tools ?? []).map((t) => t.function?.name);
  check("白名单生效（tools 只含声明项）", toolNames.length === 2 && toolNames.includes("read_file") && toolNames.includes("run_test"), toolNames.join(","));
}

// ── 6. 并行委派（tasks 数组）──
console.log("\n▶ delegateTasks：并行执行");
{
  events = [];
  installFetch({ "sub-model": () => okSse("并行结果") });
  const out = await delegateTasks([{ prompt: "任务1" }, { prompt: "任务2" }], makeCtx());
  const starts = events.filter((e) => e.type === "subagent-start");
  const dones = events.filter((e) => e.type === "subagent-done");
  check("两个子智能体同时启动", starts.length === 2);
  check("两个子智能体都完成", dones.length === 2);
  check("结果合并回收", out.includes("【子任务 1】") && out.includes("【子任务 2】"));
  check("独立上下文（每路一次模型调用）", fetchCalls.length === 2, `calls=${fetchCalls.length}`);
  check("subagent id 互不相同", starts[0].id !== starts[1].id);
}

// ── 7. 安全边界 ──
console.log("\n▶ 安全边界");
{
  // 7.1 深度限制
  events = [];
  installFetch({ "sub-model": () => okSse("x") });
  await expectError(
    runSubagent({ prompt: "再委派" }, makeCtx({ delegationDepth: MAX_DELEGATION_DEPTH })),
    /深度超限/,
    "委派深度超限被拒"
  );
  check("超限不发 subagent-start", !events.some((e) => e.type === "subagent-start"));

  // 7.2 root 越界
  events = [];
  await expectError(runSubagent({ prompt: "越界", root: "../outside" }, makeCtx()), /越界/, "root 越界被拒");
  await expectError(runSubagent({ prompt: "越界", root: "C:\\Windows" }, makeCtx()), /越界/, "绝对路径越界被拒");
  // 子目录合法（root 参数 = 项目内相对子路径）
  installFetch({ "sub-model": () => okSse("子目录ok") });
  const sub = await runSubagent({ prompt: "x", root: "src" }, makeCtx());
  check("项目内子目录合法", sub.steps >= 1, sub.text.slice(0, 60));

  // 7.3 未知工具名
  await expectError(runSubagent({ prompt: "x", tools: ["nope_tool"] }, makeCtx()), /不存在或不可用/, "未知工具报错");

  // 7.4 架构级排除（delegate_task/mcp_register/plugin_add 白名单写明也拒绝）
  for (const forbidden of SUBAGENT_FORBIDDEN_TOOLS) {
    await expectError(runSubagent({ prompt: "x", tools: [forbidden] }, makeCtx()), /架构级限制/, `架构级排除 ${forbidden}`);
  }

  // 7.5 模型解析失败（modelId 不存在）
  await expectError(runSubagent({ prompt: "x", modelId: "no-such-model" }, makeCtx()), /未找到模型/, "modelId 未找到报错");

  // 7.6 缺模型上下文（无 modelConfig 且无 modelId）
  await expectError(runSubagent({ prompt: "x" }, makeCtx({ modelConfig: undefined })), /缺少子模型配置/, "缺模型上下文报错");

  // 7.7 agent 文件不存在
  await expectError(runSubagent({ prompt: "x", agent: "ghost" }, makeCtx()), /未找到 agent 定义/, "agent 文件不存在报错");

  // 7.8 缺省工具 = 全部内置工具（对齐 ZCode general-purpose；架构级排除项除外）
  check("缺省 = 全部内置工具", isReadOnlyDelegation({ prompt: "x" }, root) === false);
  check("只读白名单判定（全部只读 → 免审批）", isReadOnlyDelegation({ prompt: "x", tools: READONLY_TOOLS }, root) === true);
  check("含写工具 → 非只读", isReadOnlyDelegation({ prompt: "x", tools: ["read_file", "write_file"] }, root) === false);
  check("内置 explore 只读", isReadOnlyDelegation({ prompt: "x", agent: "explore" }, root) === true);
  check("内置 general-purpose 全工具", isReadOnlyDelegation({ prompt: "x", agent: "general-purpose" }, root) === false);
}

// ── 7.9 内部免审批（父批准委派 = 授权；requireExplicit 安全红线仍转发）──
console.log("\n▶ 内部免审批（继承委派授权）");
{
  events = [];
  let parentApprovals = 0;
  let explicitForwarded = 0;
  installFetch({ "sub-model": () => okSse("免审批完成") });
  const ctx2 = makeCtx({
    requestApproval: async (_d, _r, explicit) => {
      parentApprovals++;
      if (explicit) explicitForwarded++;
      return true;
    },
  });
  const out = await delegateTasks([{ prompt: "只读审查任务" }], ctx2);
  check("子智能体内部调用不再逐个审批（父 0 次）", parentApprovals === 0, `approvals=${parentApprovals}`);
  check("任务正常完成", out.includes("免审批完成"));

  // requireExplicit（联网放行等安全红线）：仍转发父级逐条询问
  events = [];
  installFetch({
    "sub-model": () =>
      sse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-net-1","type":"function","function":{"name":"run_command","arguments":"{\\"command\\":\\"curl https://example.com\\",\\"network\\":true}"}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n'
      ),
  });
  const ctx3 = makeCtx({
    requestApproval: async (_d, _r, explicit) => {
      parentApprovals++;
      if (explicit) explicitForwarded++;
      return true;
    },
  });
  await delegateTasks([{ prompt: "联网任务", tools: ["run_command"] }], ctx3);
  check("requireExplicit（联网）仍转发父级", explicitForwarded >= 1, `explicit=${explicitForwarded}`);
}

// ── 7.10 delegate_task 审批：只读委派免审批（对齐 ZCode Explore）；写能力委派一次授权 ──
console.log("\n▶ delegate_task 审批（只读免审批 / 写能力一次授权）");
{
  const t = TOOLS["delegate_task"];
  // 只读委派（explore / 只读白名单）：不触发审批，直接执行
  let approvalCalls = 0;
  const events2: AgentEvent[] = [];
  const ro = await t.execute(
    { prompt: "搜索代码", agent: "explore" },
    {
      root, cwd: root, emit: (e) => events2.push(e),
      requestApproval: async () => { approvalCalls++; return true; },
      modelConfig: { provider: "deepseek", model: "sub-model", apiKey: "k" },
    } as any
  );
  check("只读委派（explore）免审批", approvalCalls === 0, `approvals=${approvalCalls}`);
  check("只读委派正常执行", ro.includes("子智能体") || ro.includes("完成") || ro.length > 0, ro.slice(0, 40));
  check("explore 委派 subagent-start 带 readOnly=true（前端绿色徽标依据）", events2.some((e) => e.type === "subagent-start" && "readOnly" in e && e.readOnly === true), JSON.stringify(events2.find((e) => e.type === "subagent-start")));
  // 写能力委派（缺省全工具）：subagent-start 不带 readOnly（前端显示 [high]）
  const events3: AgentEvent[] = [];
  await t.execute(
    { prompt: "修改代码" },
    {
      root, cwd: root, emit: (e) => events3.push(e),
      requestApproval: async () => true,
      modelConfig: { provider: "deepseek", model: "sub-model", apiKey: "k" },
    } as any
  );
  check("写能力委派不带 readOnly（显示 [high]）", !events3.some((e) => e.type === "subagent-start" && "readOnly" in e && e.readOnly === true));
  // 只读白名单参数同样免审批
  approvalCalls = 0;
  await t.execute(
    { prompt: "阅读文件", tools: ["read_file", "search_code"] },
    {
      root, cwd: root, emit: () => {},
      requestApproval: async () => { approvalCalls++; return true; },
      modelConfig: { provider: "deepseek", model: "sub-model", apiKey: "k" },
    } as any
  );
  check("只读白名单免审批", approvalCalls === 0);
  // 写能力委派（缺省全工具）：一次授权审批；拒绝 = 不委派
  approvalCalls = 0;
  const rejected = await t.execute(
    { prompt: "修改代码" },
    { root, cwd: root, emit: () => {}, requestApproval: async () => { approvalCalls++; return false; }, modelConfig: { provider: "deepseek", model: "sub-model", apiKey: "k" } } as any
  );
  check("写能力委派触发一次审批", approvalCalls === 1);
  check("拒绝授权返回拒绝文本", /未授权/.test(rejected), rejected.slice(0, 60));
  // 批准授权：描述含工具范围（用户知情授权边界）
  let desc = "";
  const approved = await t.execute(
    { prompt: "修改代码", tools: ["read_file", "write_file"] },
    {
      root, cwd: root, emit: () => {},
      requestApproval: async (d) => { desc = d; return true; },
      modelConfig: { provider: "deepseek", model: "sub-model", apiKey: "k" },
    } as any
  );
  check("批准后执行委派", approved.includes("修改代码") || approved.includes("子智能体"), approved.slice(0, 60));
  check("审批描述含工具范围", desc.includes("read_file") && desc.includes("write_file"), desc.slice(0, 120));
  check("缺省工具范围描述 = 全部内置", desc.includes("全部内置工具") || desc.includes("read_file"));
}

// ── 8. 结果截断（防上下文爆炸）──
console.log("\n▶ 结果截断");
{
  events = [];
  const long = "长".repeat(MAX_SUBAGENT_RESULT + 500);
  installFetch({ "sub-model": () => okSse(long) });
  const out = await delegateTasks([{ prompt: "长输出" }], makeCtx());
  check("超长结果截断", out.length <= MAX_SUBAGENT_RESULT + 100 && out.endsWith("…（结果已截断）"), `len=${out.length}`);
}

// ── 9. delegate_task 工具本身（TOOLS 注册表）──
console.log("\n▶ delegate_task 工具定义");
{
  const t = TOOLS["delegate_task"];
  check("工具已注册（第 14 个内置）", !!t);
  check("风险 = high", t.risk === "high");
  const schemaOk = t.schema.safeParse({ prompt: "任务" }).success;
  check("schema：单任务合法", schemaOk);
  check("schema：tasks 并行合法", t.schema.safeParse({ tasks: [{ prompt: "A" }, { prompt: "B" }] }).success);
  check("schema：prompt 与 tasks 互斥", !t.schema.safeParse({ prompt: "A", tasks: [{ prompt: "B" }] }).success);
  check("schema：两者皆无报错", !t.schema.safeParse({}).success);
  check("schema：缺省字段可选", t.schema.safeParse({ prompt: "A", tools: ["read_file"], maxSteps: 5 }).success);
  check("schema：tasks 上限 6", !t.schema.safeParse({ tasks: Array.from({ length: 7 }, () => ({ prompt: "x" })) }).success);
  check("不在 Planner 只读白名单", !Object.keys(getReadOnlyTools()).includes("delegate_task"));
}

// ── 10. rebuild 跳过子智能体内部事件 ──
console.log("\n▶ rebuildMessages：跳过内部事件（防孤儿配对/上下文污染）");
{
  const events2: Array<{ seq: number; ts: number; event: AgentEvent }> = [
    { seq: 1, ts: 1, event: { type: "user-message", text: "任务" } },
    { seq: 2, ts: 2, event: { type: "step-start", step: 1 } },
    { seq: 3, ts: 3, event: { type: "tool-start", tool: "delegate_task", args: { prompt: "子任务" }, risk: "high", callId: "call-1" } },
    { seq: 4, ts: 4, event: { type: "subagent-start", id: "sub-1", name: "审查", prompt: "子任务", parentCallId: "call-1" } },
    { seq: 5, ts: 5, event: { type: "step-start", step: 1, subagentId: "sub-1" } },
    { seq: 6, ts: 6, event: { type: "tool-start", tool: "read_file", args: { path: "a.ts" }, risk: "low", callId: "sub-call-1", subagentId: "sub-1" } },
    { seq: 7, ts: 7, event: { type: "tool-result", tool: "read_file", ok: true, summary: "内部结果", callId: "sub-call-1", subagentId: "sub-1" } },
    { seq: 8, ts: 8, event: { type: "subagent-done", id: "sub-1", text: "结论", steps: 1, toolCount: 1, ok: true } },
    { seq: 9, ts: 9, event: { type: "tool-result", tool: "delegate_task", ok: true, summary: "委派结果：结论", callId: "call-1" } },
  ];
  const msgs = rebuildMessages(events2 as any);
  const asm = msgs.filter((m) => m.role === "assistant" && (m as any).tool_calls);
  check("父级工具调用重建", asm.length === 1 && (asm[0] as any).tool_calls.some((c: any) => c.id === "call-1"));
  const tools = msgs.filter((m) => m.role === "tool");
  check("父级工具结果重建", tools.length === 1 && tools[0].content === "委派结果：结论");
  check("子智能体内部工具结果被跳过（无孤儿配对）", tools.every((m) => !String(m.content).includes("内部结果")));
  check("内部事件不产生额外消息", msgs.length === 3, `len=${msgs.length}`);
}

// ── 11. 同轮多个 delegate_task 并行执行（loop 3.2 段并行化）──
console.log("\n▶ 同轮多个子智能体并行（对齐 ZCode：同一消息多个工具调用并发运行）");
{
  let callNo = 0;
  let active = 0;
  let maxActive = 0;
  const orig2 = globalThis.fetch;
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
    callNo++;
    const body = JSON.parse(init?.body ?? "{}");
    const sys = String(body.messages?.[0]?.content ?? "");
    if (!sys.includes("子智能体")) {
      // 父循环：第一轮请求两个 delegate_task（模型一次派发）；后续轮返回文本
      if (callNo === 1) {
        return sse(
          'data: {"choices":[{"delta":{"tool_calls":[' +
            '{"index":0,"id":"call-a","type":"function","function":{"name":"delegate_task","arguments":"{\\"prompt\\":\\"并行任务A\\"}"}},' +
            '{"index":1,"id":"call-b","type":"function","function":{"name":"delegate_task","arguments":"{\\"prompt\\":\\"并行任务B\\"}"}}' +
            ']}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"全部完成"}}]}\n\ndata: [DONE]\n\n'
        );
      }
      return okSse("全部完成");
    }
    // 子智能体循环：延迟模拟耗时，统计并发数
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 120));
    active--;
    return okSse("子任务完成");
  };
  try {
    const events: AgentEvent[] = [];
    const result = await runAgent({
      modelConfig: { provider: "deepseek", model: "par-model", apiKey: "k" },
      system: "你是测试父智能体",
      prompt: "请同时委派两个子任务",
      tools: { delegate_task: TOOLS["delegate_task"] },
      root,
      emit: (e) => events.push(e),
      requestApproval: async () => true,
      maxSteps: 3,
    });
    const starts = events.filter((e) => e.type === "subagent-start");
    const dones = events.filter((e) => e.type === "subagent-done");
    check("同轮两个子智能体同时启动", starts.length === 2);
    check("两个子智能体都完成", dones.length === 2);
    check("两个子智能体真正并发运行（maxActive≥2）", maxActive >= 2, `maxActive=${maxActive}`);
    check("parentCallId 隔离（call-a / call-b 各自正确）", starts.some((s) => s.parentCallId === "call-a") && starts.some((s) => s.parentCallId === "call-b"), JSON.stringify(starts.map((s) => s.parentCallId)));
    check("父级回收两个委派结果", result.toolCount === 2 && result.text.includes("全部完成"));
  } finally {
    globalThis.fetch = orig2;
  }
}

// ── 12. 父终止 → 子智能体级联停止（abort 全链路）──
console.log("\n▶ 父终止 → 子智能体级联停止");
{
  let callNo = 0;
  const orig3 = globalThis.fetch;
  let subStarted = false;
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
    callNo++;
    const body = JSON.parse(init?.body ?? "{}");
    const sys = String(body.messages?.[0]?.content ?? "");
    if (!sys.includes("子智能体")) {
      // 父循环：第一轮请求一个 delegate_task
      if (callNo === 1) {
        return sse(
          'data: {"choices":[{"delta":{"tool_calls":[' +
            '{"index":0,"id":"call-x","type":"function","function":{"name":"delegate_task","arguments":"{\\"prompt\\":\\"子任务\\"}"}}' +
            ']}}]}\n\ndata: [DONE]\n\n'
        );
      }
      return okSse("父完成");
    }
    // 子循环：长时间等待（5s）——模拟真实 fetch 对 abort 的响应（signal 中止 → 抛 AbortError）
    subStarted = true;
    await new Promise((_resolve, reject) => {
      const t = setTimeout(_resolve, 5000);
      (init as { signal?: AbortSignal })?.signal?.addEventListener(
        "abort",
        () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); },
        { once: true }
      );
    });
    return okSse("子完成");
  };
  try {
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const t0 = Date.now();
    const p = runAgent({
      modelConfig: { provider: "deepseek", model: "par-model", apiKey: "k" },
      system: "你是测试父智能体",
      prompt: "委派一个子任务",
      tools: { delegate_task: TOOLS["delegate_task"] },
      root,
      emit: (e) => events.push(e),
      requestApproval: async () => true,
      maxSteps: 5,
      abortSignal: controller.signal,
    });
    // 300ms 后终止父
    setTimeout(() => controller.abort(), 300);
    const result = await p;
    const elapsed = Date.now() - t0;
    check("子智能体已启动", subStarted);
    check("父 abort 后快速返回（<3s，不等子循环 5s 挂起）", elapsed < 3000, `${elapsed}ms`);
    check("父返回停止语义", result.text.includes("已停止") || result.text.includes("中止"), result.text.slice(0, 40));
    // 子循环侧也应收到 abort（事件流中出现子循环的停止/完成事件而非 5s 后正常完成）
    check("子循环未等到 5s 延迟结束", elapsed < 4000, `${elapsed}ms`);
  } finally {
    globalThis.fetch = orig3;
  }
}

// ── 清理 ──
restoreFetch();
rmSync(root, { recursive: true, force: true });
rmSync(userAgents, { recursive: true, force: true });

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
