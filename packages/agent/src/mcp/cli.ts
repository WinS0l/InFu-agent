/**
 * CLI 子命令：infu mcp add/list/remove/status（v2.3 批 1）
 *
 * 分发由 cli.ts main() 完成（args[0] === "mcp"）；本模块为业务逻辑。
 * 交互向导的行迭代器为模块级单例（与 cli.ts 的 config 向导同构；
 * 同一 CLI 进程内同时只有一个向导运行，不抢 stdin）。
 */

import type { McpServerConfig } from "@infu/shared";
import { loadConfig, saveConfig } from "../providers/registry.js";
import { connectMcp, resolveToolRisk } from "./index.js";

// ── 终端着色（与 cli.ts 一致）──
const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

// 行迭代器（async generator：对 TTY 与管道输入都健壮）
let linesGen: AsyncGenerator<string> | null = null;
function getLines(): AsyncGenerator<string> {
  if (!linesGen) {
    linesGen = (async function* () {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin });
      for await (const line of rl) yield line;
      rl.close();
    })();
  }
  return linesGen;
}
function ask(question: string, def?: string): Promise<string> {
  process.stderr.write(def ? `${question}（默认 ${def}）: ` : `${question}: `);
  return getLines()
    .next()
    .then((r) => r.value?.trim() || def || "");
}

// v4.0 审计修复（M2）：删除本地直写 saveConfig（无原子写/无 0600 chmod，与常驻 server
// 并发写可截断半写）——统一走 registry.saveConfig（tmp + rename 原子写 + chmod 0600）

export async function mcpCli(args: string[]): Promise<void> {
  const cmd = args[0];
  if (cmd === "add") return mcpAdd(args.slice(1));
  if (cmd === "list") return mcpList();
  if (cmd === "remove") return mcpRemove(args[1]);
  if (cmd === "status") return mcpStatus(args[1]);
  console.log(`InFu MCP 管理

用法：
  infu mcp add <名称>                交互式添加 MCP 服务器（stdio/http）
       [--type stdio|http] [--command <cmd>] [--args a,b] [--url <url>]  参数直传跳过交互
  infu mcp list                      列出已配置的服务器
  infu mcp remove <id>               删除服务器
  infu mcp status [id]               探测连接，列出服务器工具与风险级别

示例：
  infu mcp add filesystem
  infu mcp add filesystem --type stdio --command npx.cmd --args "-y,@modelcontextprotocol/server-filesystem"`);
}

/** 从 args 提取 --key value（直传参数） */
function argValue(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

async function mcpAdd(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.log("用法：infu mcp add <名称> [--type stdio|http] [--command <cmd>] [--url <url>]");
    return;
  }
  const cfg = loadConfig() ?? { models: [], providers: [] };
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if ((cfg.mcpServers ?? []).some((s) => s.id === id)) {
    console.error(C.red(`MCP 服务器 "${id}" 已存在（infu mcp list 查看）`));
    return;
  }

  const typeArg = argValue(args, "--type");
  const type: McpServerConfig["type"] =
    typeArg === "http" ? "http" : typeArg === "stdio" ? "stdio" : ((await ask("类型（stdio 本地进程 / http 远程端点）", "stdio")) === "http" ? "http" : "stdio");

  const s: McpServerConfig = { id, name, type };
  if (type === "stdio") {
    const command = argValue(args, "--command") ?? (await ask("启动命令（Windows 下 npx 需写 npx.cmd）"));
    if (!command) {
      console.error(C.red("command 不能为空"));
      return;
    }
    s.command = command;
    const argsRaw = argValue(args, "--args");
    if (argsRaw) s.args = argsRaw.split(",").map((a) => a.trim()).filter(Boolean);
    else {
      const extra = await ask("命令参数（逗号分隔，可留空）");
      if (extra) s.args = extra.split(",").map((a) => a.trim()).filter(Boolean);
    }
  } else {
    const url = argValue(args, "--url") ?? (await ask("Streamable HTTP 端点 URL"));
    if (!url) {
      console.error(C.red("url 不能为空"));
      return;
    }
    s.url = url;
  }

  // 风险覆盖（可选：默认所有工具 medium 审批；格式 "read*:low,write_file:high"）
  const riskRaw = await ask("风险覆盖（格式 read*:low,write_file:high；留空=默认 medium）");
  if (riskRaw.trim()) {
    const ro: NonNullable<McpServerConfig["riskOverrides"]> = {};
    for (const pair of riskRaw.split(",")) {
      const [k, v] = pair.split(":").map((x) => x.trim());
      if (k && (v === "low" || v === "medium" || v === "high")) ro[k] = v;
    }
    if (Object.keys(ro).length) s.riskOverrides = ro;
  }

  cfg.mcpServers = [...(cfg.mcpServers ?? []), s];
  saveConfig(cfg);
  console.log(C.green(`✅ 已添加 MCP 服务器 ${name}（${id} · ${type}）`));
  console.log(C.dim(`   可用 infu mcp status ${id} 探测连接；任务执行阶段将自动注入该服务器工具（默认 medium 审批）`));
}

function mcpList(): void {
  const cfg = loadConfig();
  const servers = cfg?.mcpServers ?? [];
  if (!servers.length) {
    console.log("暂无 MCP 服务器（infu mcp add <名称> 添加；例如 npx @modelcontextprotocol/server-filesystem）");
    return;
  }
  console.log(C.cyan(`\n═══ MCP 服务器（${servers.length}）═══`));
  servers.forEach((s, i) => {
    const st = s.enabled === false ? C.yellow("禁用") : C.green("启用");
    const target = s.type === "stdio" ? `${s.command ?? "?"} ${(s.args ?? []).join(" ")}`.trim() : s.url ?? "?";
    console.log(` ${String(i + 1).padStart(2)}. ${s.name}（${s.id} · ${s.type}）${st}`);
    console.log(C.dim(`     ${target}${s.riskOverrides ? ` · 风险覆盖 ${Object.keys(s.riskOverrides).length} 条` : ""}`));
  });
  console.log(C.dim(`\n详情/工具列表：infu mcp status [id]；删除：infu mcp remove <id>`));
}

async function mcpRemove(id?: string): Promise<void> {
  if (!id) {
    console.log("用法：infu mcp remove <id>（infu mcp list 查看 id）");
    return;
  }
  const cfg = loadConfig();
  const s = (cfg?.mcpServers ?? []).find((x) => x.id === id);
  if (!s) {
    console.error(C.red(`MCP 服务器 "${id}" 不存在`));
    return;
  }
  const ok = await ask(`确认删除 "${s.name}"（${s.id}）？(y/N)`, "n");
  if (!/^y/i.test(ok)) {
    console.log("已取消");
    return;
  }
  cfg!.mcpServers = (cfg!.mcpServers ?? []).filter((x) => x.id !== id);
  saveConfig(cfg!);
  console.log(C.green(`✅ 已删除 ${s.name}（${s.id}）`));
}

async function mcpStatus(id?: string): Promise<void> {
  const cfg = loadConfig();
  const servers = id ? (cfg?.mcpServers ?? []).filter((s) => s.id === id) : (cfg?.mcpServers ?? []);
  if (!servers.length) {
    console.log(id ? `MCP 服务器 "${id}" 不存在（infu mcp list 查看）` : "暂无 MCP 服务器");
    return;
  }
  for (const s of servers) {
    console.log(C.cyan(`\n${s.name}（${s.id} · ${s.type}${s.enabled === false ? " · 已禁用" : ""}）`));
    if (s.enabled === false) {
      console.log(C.dim("  已禁用，跳过探测（启用后自动注入）"));
      continue;
    }
    try {
      const conn = await connectMcp(s);
      const tools = await conn.listTools();
      console.log(C.green(`  ✅ 已连接：${tools.length} 个工具`));
      for (const t of tools) {
        const risk = resolveToolRisk(s, t.name);
        const riskColor = risk === "low" ? C.green : risk === "high" ? C.red : C.yellow;
        console.log(`   · ${t.name} ${riskColor(`[${risk}]`)}${t.description ? C.dim(" " + t.description.slice(0, 80)) : ""}`);
      }
      await conn.close();
    } catch (e) {
      console.error(C.red(`  ✗ 连接失败：${(e as Error).message.slice(0, 200)}`));
    }
  }
}
