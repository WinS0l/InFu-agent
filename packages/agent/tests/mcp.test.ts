/**
 * MCP 客户端自测（v2.3 批 1：schema 转换 / 风险解析 / 工具适配器 / 加载去重 /
 * config schema / API CRUD+探测 / 阶段级续跑推断）
 * 运行：npx tsx packages/agent/tests/mcp.test.ts
 *
 * 覆盖：
 *  - jsonSchemaToZod：各类 JSON Schema → zod 校验行为（必填/可选/枚举/联合/回退）
 *  - resolveToolRisk：精确匹配 > 前缀通配 > 默认 medium
 *  - mcpToolToDef：审批调用（medium/high 触发 / low 直放）、结果文本化、isError 透传
 *  - loadMcpTools：注入 connectFn 验证合并/重名前缀/失败跳过（不 spawn 真实进程）
 *  - infuConfigSchema：mcpServers 节解析 + 未知字段保留
 *  - API：/api/mcp CRUD + 探测端点（app.request；数据目录重定向隔离）
 *  - inferResumePhase：阶段级续跑起点推断
 */
import { createApp } from "../src/server.js";
import { jsonSchemaToZod } from "../src/mcp/schema.js";
import { resolveToolRisk, mcpToolToDef } from "../src/mcp/tools.js";
import { loadMcpTools } from "../src/mcp/index.js";
import { validateHttpMcpUrl } from "../src/mcp/client.js";
import type { McpConnection } from "../src/mcp/index.js";
import { registerMcpServer, mcpIdFromName } from "../src/mcp/register.js";
import { TOOLS } from "../src/tools/index.js";
import { inferResumePhase } from "../src/agent/resume.js";
import { parseInfuConfig } from "@infu/shared";
import type { AgentEvent, McpServerConfig, ToolDef } from "@infu/shared";
import { z } from "zod";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== MCP 客户端自测 ===\n");

// v3.6：数据目录重定向到临时目录（原备份/恢复真实 ~/.infu/config.json 崩溃即污染用户数据）
const tmpData = mkdtempSync(join(tmpdir(), "infu-test-"));
setDataDirForTest(tmpData);
writeFileSync(join(tmpData, "index.html"), "<!doctype html><html><head></head><body></body></html>", "utf-8");

// ── 1. JSON Schema → zod 转换 ──
console.log("▶ schema 转换器");
{
  // 简单 string
  const s1 = jsonSchemaToZod({ type: "string", description: "路径" });
  check("string → z.string", s1 instanceof z.ZodString, String(s1.constructor?.name));
  check("description 保留", s1.description === "路径");

  // object：required/optional
  const obj = jsonSchemaToZod({
    type: "object",
    properties: { path: { type: "string" }, lines: { type: "integer" }, opt: { type: "boolean" } },
    required: ["path"],
  }) as z.ZodObject<any>;
  check("object → z.object", obj instanceof z.ZodObject);
  const r = obj.safeParse({ path: "a.ts" });
  check("required 字段必填", r.success, JSON.stringify(r.error?.issues));
  const r2 = obj.safeParse({ path: "a.ts", lines: 3.2 });
  check("integer 校验", !r2.success && r2.error!.issues[0].path[0] === "lines", JSON.stringify(r2.error?.issues));
  const r3 = obj.safeParse({ path: "a.ts", opt: true });
  check("optional 字段可缺省", r3.success);

  // 数组 + 枚举
  const arr = jsonSchemaToZod({ type: "array", items: { type: "string" } }) as z.ZodArray<any>;
  check("array → z.array(z.string)", arr.safeParse(["a", "b"]).success && !arr.safeParse([1]).success);
  const en = jsonSchemaToZod({ type: "string", enum: ["add", "remove"] }) as z.ZodEnum<any>;
  check("enum 校验", en.safeParse("add").success && !en.safeParse("x").success);

  // anyOf 联合
  const un = jsonSchemaToZod({ anyOf: [{ type: "string" }, { type: "number" }] });
  check("anyOf 联合（字符串/数字都过）", un.safeParse("s").success && un.safeParse(1).success && !un.safeParse(true).success);

  // 未知形态回退 z.any（不抛错）
  const fb = jsonSchemaToZod({ type: "weird" });
  check("未知类型回退 z.any", fb.safeParse({ anything: 1 }).success);
  const fb2 = jsonSchemaToZod(undefined);
  check("undefined 回退 z.any", fb2.safeParse(null).success);
}

// ── 2. 风险解析 ──
console.log("\n▶ resolveToolRisk");
{
  const cfg: McpServerConfig = {
    id: "fs", name: "FS",
    riskOverrides: { read_file: "low", "read*": "low", write_file: "high" },
  };
  check("精确匹配优先", resolveToolRisk(cfg, "read_file") === "low");
  check("前缀通配", resolveToolRisk(cfg, "read_directory") === "low");
  check("精确命中 high", resolveToolRisk(cfg, "write_file") === "high");
  check("未命中默认 medium", resolveToolRisk(cfg, "delete_all") === "medium");
  check("无覆盖默认 medium", resolveToolRisk({ id: "x", name: "X" }, "anything") === "medium");
}

// ── 3. 工具适配器（fake 连接，验证审批/文本化/isError）──
console.log("\n▶ mcpToolToDef 适配器");
{
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const conn: McpConnection = {
    serverId: "fs",
    listTools: async () => [],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, text: `RESULT:${name}` };
    },
    close: async () => {},
  };
  const approvals: Array<{ desc: string; risk: string }> = [];
  const ctx = {
    root: ".", cwd: ".",
    requestApproval: async (desc: string, risk: "low" | "medium" | "high") => {
      approvals.push({ desc, risk });
      return true;
    },
    emit: () => {},
  } as any;

  // medium 默认 → 触发审批
  const t1 = mcpToolToDef({ id: "fs", name: "FS" }, conn, { name: "read", description: "读文件" }, "fs_read");
  check("工具元信息透传", t1.name === "fs_read" && t1.risk === "medium" && t1.description.includes("读文件"));
  const out1 = await t1.execute({ path: "a" }, ctx);
  check("调用转发 + 结果文本化", out1 === "RESULT:read" && calls.length === 1 && calls[0].name === "read");
  check("medium 触发审批（description 含服务器名与工具名）", approvals.length === 1 && approvals[0].risk === "medium" && approvals[0].desc.includes("FS") && approvals[0].desc.includes("read"));

  // 审批拒绝
  const denied: string[] = [];
  const ctx2 = { ...ctx, requestApproval: async () => { denied.push("x"); return false; } };
  const out2 = await t1.execute({}, ctx2);
  check("拒绝返回提示文本", out2.includes("拒绝"));

  // low → 不触发审批
  const approvals2: string[] = [];
  const t2 = mcpToolToDef({ id: "fs", name: "FS", riskOverrides: { read: "low" } }, conn, { name: "read" }, "fs_read2");
  const ctx3 = { ...ctx, requestApproval: async () => { approvals2.push("x"); return true; } };
  await t2.execute({}, ctx3);
  check("low 直接执行不审批", approvals2.length === 0);

  // isError 透传
  const connErr: McpConnection = { ...conn, callTool: async () => ({ ok: false, text: "boom" }) };
  const t3 = mcpToolToDef({ id: "fs", name: "FS", riskOverrides: { e: "low" } }, connErr, { name: "e" }, "e");
  const out3 = await t3.execute({}, ctx);
  check("isError → 错误文本透传", out3.includes("boom") && out3.includes("失败"));

  // 调用异常 → 返回错误文本（不抛）
  const connThrow: McpConnection = { ...conn, callTool: async () => { throw new Error("conn lost"); } };
  const t4 = mcpToolToDef({ id: "fs", name: "FS", riskOverrides: { c: "low" } }, connThrow, { name: "c" }, "c");
  const out4 = await t4.execute({}, ctx);
  check("调用异常 → 错误文本（模型可读）", out4.includes("conn lost"));
}

// ── 4. loadMcpTools：注入 fake connectFn ──
console.log("\n▶ loadMcpTools（注入连接）");
{
  const fakeConn = (cfg: McpServerConfig): McpConnection => ({
    serverId: cfg.id,
    listTools: async () => {
      if (cfg.id === "broken") throw new Error("模拟连接失败");
      return [
        { name: "shared_tool", description: "通用" },
        { name: cfg.id + "_tool", description: cfg.id },
      ];
    },
    callTool: async () => ({ ok: true, text: "" }),
    close: async () => {},
  });
  const events: AgentEvent[] = [];
  const servers: McpServerConfig[] = [
    { id: "a", name: "A", type: "stdio", command: "x" },
    { id: "b", name: "B", type: "stdio", command: "y" },
    { id: "off", name: "OFF", type: "stdio", command: "z", enabled: false },
    { id: "broken", name: "BROKEN", type: "stdio", command: "w" },
  ];
  const r = await loadMcpTools(servers, (e) => events.push(e), fakeConn as any);
  // a: shared_tool/a_tool；b: shared_tool 重名 → b_shared_tool + b_tool；off 禁用不连；broken 失败跳过
  check("禁用服务器不连接（4 个：a 2 + b 2）",
    r.tools.length === 4, r.tools.map((t) => t.name).join(","));
  check("重名工具加服务器前缀", r.tools.some((t) => t.name === "b_shared_tool"), r.tools.map((t) => t.name).join(","));
  check("失败服务器跳过并记录", r.failures.length === 1 && r.failures[0].id === "broken");
  check("失败 emit 提示事件（不阻塞）", events.some((e) => e.type === "text" && e.text.includes("BROKEN")), JSON.stringify(events));
  // v3：成功连接不再 emit text（避免对话流环境噪音；工具列表即环境感知）
  // close 调用
  let closed = 0;
  const r2 = await loadMcpTools(
    [{ id: "c", name: "C", type: "stdio", command: "x" }],
    () => {},
    (async () => ({ serverId: "c", listTools: async () => [], callTool: async () => ({ ok: true, text: "" }), close: async () => { closed++; } })) as any
  );
  await r2.close();
  check("close 关闭所有连接", closed === 1);
  // 无服务器
  const r3 = await loadMcpTools(undefined, () => {});
  check("无服务器 → 空结果", r3.tools.length === 0 && r3.failures.length === 0);
}

// ── 5. config schema（mcpServers 节）──
console.log("\n▶ config schema");
{
  const raw = {
    version: 2,
    models: [],
    providers: [{ id: "d", name: "D", kind: "deepseek" }],
    mcpServers: [
      { id: "fs", name: "文件系统", type: "stdio", command: "npx.cmd", args: ["-y", "server"], riskOverrides: { "read*": "low" } },
      { id: "remote", name: "远程", type: "http", url: "https://x/mcp", enabled: false },
    ],
    someFuture: { keep: 1 },
  };
  const r = parseInfuConfig(raw);
  check("解析成功", r.ok);
  if (r.ok) {
    check("mcpServers 数量", r.config.mcpServers?.length === 2);
    check("字段解析（command/args/riskOverrides）",
      r.config.mcpServers?.[0].command === "npx.cmd" &&
      r.config.mcpServers?.[0].args?.[0] === "-y" &&
      r.config.mcpServers?.[0].riskOverrides?.["read*"] === "low");
    check("enabled 缺省为 undefined（启用）", r.config.mcpServers?.[1].enabled === false);
    check("未知字段保留", (r.config as any).someFuture.keep === 1);
    check("v2 迁移幂等（mcpServers 不触发迁移）", r.config.providers?.length === 1);
  }
  // 无 mcpServers 的旧配置兼容
  const r2 = parseInfuConfig({ version: 2, models: [{ id: "m", name: "M", model: "m1", providerId: "d" }], providers: [{ id: "d", name: "D", kind: "deepseek" }] });
  check("旧配置无 mcpServers 兼容", r2.ok && r2.config.mcpServers === undefined);
  // 非法级别拒绝
  const r3 = parseInfuConfig({ models: [], mcpServers: [{ id: "x", name: "X", riskOverrides: { a: "nuke" } }] });
  check("非法风险级别拒绝", !r3.ok);
}

// ── 6. API：/api/mcp CRUD + 探测 ──
console.log("\n▶ /api/mcp API");
{
  // v3.6：config 已重定向到临时数据目录（无需备份/恢复真实 ~/.infu/config.json）
  const CONFIG = join(tmpData, "config.json");
  const saveTestConfig = (cfg: unknown) => writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), "utf-8");

   const app = createApp({ staticDir: tmpData });
   const tokenHtml = await (await app.fetch(new Request("http://localhost/"))).text();
   const token = /window\.__INFU_TOKEN__="([0-9a-f]{32})"/.exec(tokenHtml)?.[1] ?? "";
   const call = (url: string, init?: RequestInit) => app.request(url, { ...init, headers: { ...init?.headers, "x-infu-token": token } });
  try {
    saveTestConfig({ version: 2, models: [], providers: [] });

    // 添加（stdio）
    let r = await call("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "fs", name: "文件系统", type: "stdio", command: "infu-no-such-cmd-xyz", args: ["-y", "srv"], riskOverrides: { "read*": "low" } }),
    });
    let j = (await r.json()) as any;
    check("添加成功", r.status === 200 && j.ok, JSON.stringify(j));

    // 重复 id 409
    r = await call("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "fs", name: "X", type: "stdio", command: "x" }),
    });
    j = await r.json();
    check("重复 id → 409", r.status === 409 && j.ok === false);

    // stdio 缺 command 400
    r = await call("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad", name: "B", type: "stdio" }),
    });
    j = await r.json();
    check("stdio 缺 command → 400", r.status === 400);

    // 添加 http
    r = await call("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
       body: JSON.stringify({ id: "remote", name: "远程", type: "http", url: "http://8.8.8.8/mcp", enabled: false }),
    });
    j = await r.json();
    check("添加 http 成功", r.status === 200 && j.ok);

    // 列表（env 脱敏字段存在）
    r = await call("/api/mcp");
    j = await r.json();
    check("列表 2 台", j.servers.length === 2, JSON.stringify(j.servers));
    check("禁用状态透出", j.servers.find((s: any) => s.id === "remote")?.enabled === false);

    // 更新：切换启用
    r = await call("/api/mcp/remote", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    j = await r.json();
    check("更新成功", r.status === 200 && j.ok);
    r = await call("/api/mcp");
    j = await r.json();
    check("enabled 已切换", j.servers.find((s: any) => s.id === "remote")?.enabled === true);

    // 探测：command 不存在 → 502（spawn ENOENT 快速失败）
    r = await call("/api/mcp/fs/tools", { method: "POST" });
    j = await r.json();
    check("探测无效 command → 502（结构化错误）", r.status === 502 && j.ok === false && typeof j.message === "string", JSON.stringify(j));

    // 探测不存在服务器 → 404
    r = await call("/api/mcp/nope/tools", { method: "POST" });
    j = await r.json();
    check("探测不存在 → 404", r.status === 404);

    // 删除
    r = await call("/api/mcp/fs", { method: "DELETE" });
    j = await r.json();
    check("删除成功", r.status === 200 && j.ok);
    r = await call("/api/mcp/fs", { method: "DELETE" });
    j = await r.json();
    check("删除不存在 → 404", r.status === 404);
    r = await call("/api/mcp");
    j = await r.json();
    check("删除后剩 1 台", j.servers.length === 1);
  } finally {
    // v3.6：无需恢复——config 已重定向到临时数据目录，随 tmpData 一并清理
  }
}

// ── 7. 阶段级续跑推断 ──
console.log("\n▶ inferResumePhase");
{
  const ev = (e: AgentEvent) => ({ event: e });
  // 空事件 → 从头
  check("无事件 → 从头", inferResumePhase([]).startPhase === undefined);
  // 直接模式（无 phase-start）→ 从头
  check("直接模式不受影响", inferResumePhase([ev({ type: "tool-start", tool: "read_file", args: {}, risk: "low" })]).startPhase === undefined);
  // planner 阶段有计划事件 → executor 续跑
  const r1 = inferResumePhase([
    ev({ type: "phase-start", phase: "planner", label: "规划" }),
    ev({ type: "plan", id: "p1", content: "第一步做 A" }),
  ]);
  check("planner 尾部+有计划 → executor 起点", r1.startPhase === "executor" && r1.planText === "第一步做 A");
  // executor 阶段 → executor 续跑（计划沿用最后一次确认的）
  const r2 = inferResumePhase([
    ev({ type: "phase-start", phase: "planner", label: "规划" }),
    ev({ type: "plan", id: "p1", content: "计划 v1" }),
    ev({ type: "phase-start", phase: "executor", label: "执行" }),
    ev({ type: "tool-start", tool: "write_file", args: {}, risk: "medium" }),
  ]);
  check("executor 尾部 → executor 起点", r2.startPhase === "executor" && r2.planText === "计划 v1");
  // reviewer 尾部 → 从头（只读中断重跑成本低）
  const r3 = inferResumePhase([
    ev({ type: "phase-start", phase: "planner", label: "规划" }),
    ev({ type: "plan", id: "p1", content: "计划" }),
    ev({ type: "phase-start", phase: "executor", label: "执行" }),
    ev({ type: "phase-start", phase: "reviewer", label: "审查" }),
  ]);
  check("reviewer 尾部 → 从头", r3.startPhase === undefined);
  // planner 尾部但无计划 → 从头
  const r4 = inferResumePhase([ev({ type: "phase-start", phase: "planner", label: "规划" })]);
  check("planner 无计划 → 从头", r4.startPhase === undefined);
}

// ── 8. mcp_register 自注册（opencode config-hook 模式 → 受控工具 + 审批）──
console.log("\n▶ mcp_register 自注册");
{
  // v3.6：config 已重定向到临时数据目录（无需备份/恢复真实 ~/.infu/config.json）
  const CONFIG2 = join(tmpData, "config.json");
  try {
    // id 生成
    check("id 生成（大小写/空格/特殊字符）", mcpIdFromName("My File Server!") === "my-file-server");
    check("id 生成（中文名兜底空）", mcpIdFromName("文件系统") === "");

    // 校验失败
    const r1 = await registerMcpServer({ name: "x", type: "stdio" });
    check("stdio 缺 command 拒绝", !r1.ok && (r1 as any).message.includes("command"));
    const r2 = await registerMcpServer({ name: "x", type: "http" });
    check("http 缺 url 拒绝", !r2.ok && (r2 as any).message.includes("url"));

    // 成功注册 + 白名单约束（只动 mcpServers，其他字段保留）
    // v3.9：默认档位已改 full——本段验证 mcp_register 的审批触发语义（high + requireExplicit），
    // 必须显式固定档位（confirm：low 也弹窗，requireExplicit 必然弹窗）
    writeFileSync(CONFIG2, JSON.stringify({
      version: 2,
      models: [{ id: "m1", name: "M1", model: "x", providerId: "d" }],
      providers: [{ id: "d", name: "D", kind: "deepseek", apiKey: "sk-keep" }],
      roles: { planner: "m1" },
      customFuture: { keep: true },
      approvalPolicy: { mode: "confirm" },
    }, null, 2), "utf-8");
    const r3 = await registerMcpServer({
      name: "filesystem", type: "stdio", command: "npx.cmd",
      args: ["-y", "srv"], riskOverrides: { "read*": "low" },
    });
    check("注册成功", r3.ok && r3.id === "filesystem" && (r3 as any).message.includes("下一任务"));
    const saved = JSON.parse(readFileSync(CONFIG2, "utf-8"));
    check("mcpServers 已追加", saved.mcpServers?.length === 1 && saved.mcpServers[0].command === "npx.cmd");
    check("风险覆盖写入", saved.mcpServers[0].riskOverrides?.["read*"] === "low");
    check("白名单：models/providers/roles 原样保留", saved.models.length === 1 && saved.providers[0].apiKey === "sk-keep" && saved.roles.planner === "m1");
    check("白名单：未知字段保留", saved.customFuture.keep === true);
    check("version 保留", saved.version === 2);

    // 重名拒绝
    const r4 = await registerMcpServer({ name: "filesystem", type: "stdio", command: "x" });
    check("重名拒绝", !r4.ok && (r4 as any).message.includes("已存在"));

    // 工具层：审批触发（high + requireExplicit）与拒绝路径
    const approvals2: Array<{ desc: string; risk: string; exp: boolean }> = [];
    const ctxT = {
      root: ".", cwd: ".",
      requestApproval: async (desc: string, risk: "low" | "medium" | "high", requireExplicit?: boolean) => {
        approvals2.push({ desc, risk, exp: requireExplicit === true });
        return false; // 拒绝
      },
      emit: () => {},
    } as any;
    const t = TOOLS["mcp_register"];
    check("mcp_register 已注册且 high", !!t && t.risk === "high");
    const out = await t.execute({ name: "denied", type: "stdio", command: "node x.js" }, ctxT);
    check("审批触发（high + requireExplicit）", approvals2.length === 1 && approvals2[0].risk === "high" && approvals2[0].exp, JSON.stringify(approvals2));
    check("审批描述含完整配置", approvals2[0].desc.includes("denied") && approvals2[0].desc.includes("node x.js"));
    check("拒绝返回提示（不写入）", out.includes("拒绝") && !JSON.parse(readFileSync(CONFIG2, "utf-8")).mcpServers.some((s: any) => s.id === "denied"));

    // 工具层：批准 → 写入成功
    const ctxT2 = { ...ctxT, requestApproval: async () => true };
    const out2 = await t.execute({ name: "approved", type: "stdio", command: "node" }, ctxT2);
    check("批准后注册成功", out2.includes("已注册") && JSON.parse(readFileSync(CONFIG2, "utf-8")).mcpServers.some((s: any) => s.id === "approved"));
  } finally {
    // v3.6：无需恢复——config 已重定向到临时数据目录，随 tmpData 一并清理
  }
}

// ── 9. MCP HTTP SSRF validation ──
console.log("\n▶ MCP HTTP SSRF");
{
  const rejects = async (url: string) => {
    try { await validateHttpMcpUrl(url); return false; } catch { return true; }
  };
  check("回环 IPv4 拒绝", await rejects("http://127.0.0.1/mcp"));
  check("私有 IPv4 拒绝", await rejects("http://192.168.1.5/mcp"));
  check("IPv6 回环拒绝", await rejects("http://[::1]/mcp"));
  check("内嵌 URL 凭据拒绝", await rejects("https://user:pass@example.com/mcp"));
  check("非 HTTP 协议拒绝", await rejects("file:///tmp/mcp"));
}

// 清理临时数据目录（v3.6：只删测试自己的临时目录，绝不动用户 ~/.infu）
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
