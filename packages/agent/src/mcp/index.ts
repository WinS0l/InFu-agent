/**
 * MCP 客户端总入口（v2.3 批 1）— 服务器配置 → ToolDef[] 动态注入
 *
 * 注入范围：仅 Executor 阶段与直接模式（Planner/Reviewer 只读阶段不注入，
 * 保持架构级只读保证）；suggestOnly 不注入。
 * 失败服务器：emit 提示后跳过，不阻塞任务。
 * 使用方负责在任务结束后调用 close()（不 await 会残留子进程）。
 */

import type { AgentEvent, McpServerConfig, ToolDef } from "@infu/shared";
import { connectMcp, type McpConnection } from "./client.js";
import { mcpToolToDef } from "./tools.js";

export { connectMcp, type McpConnection, type McpToolInfo } from "./client.js";
export { jsonSchemaToZod } from "./schema.js";
export { resolveToolRisk, mcpToolToDef } from "./tools.js";

export interface McpLoadResult {
  /** 注入的 MCP 工具（与 TOOLS 合并后传给 Agent 循环） */
  tools: ToolDef[];
  /** 任务结束后关闭所有连接（不 await 会残留子进程） */
  close: () => Promise<void>;
  /** 连接失败的服务器（日志/提示用） */
  failures: Array<{ id: string; message: string }>;
}

/** 连接所有启用服务器并生成工具列表；失败服务器 emit 提示后跳过（不阻塞任务） */
export async function loadMcpTools(
  servers: McpServerConfig[] | undefined,
  emit: (e: AgentEvent) => void,
  connectFn: typeof connectMcp = connectMcp
): Promise<McpLoadResult> {
  const tools: ToolDef[] = [];
  const connections: McpConnection[] = [];
  const failures: Array<{ id: string; message: string }> = [];
  const usedNames = new Set<string>();

  for (const cfg of servers ?? []) {
    if (cfg.enabled === false) continue;
    let conn: McpConnection | undefined;
    try {
      conn = await connectFn(cfg);
      const list = await conn.listTools();
      connections.push(conn);
      for (const t of list) {
        // 工具重名冲突：加服务器前缀（跨服务器防重）
        let name = t.name;
        if (usedNames.has(name)) name = `${cfg.id}_${name}`;
        usedNames.add(name);
        tools.push(mcpToolToDef(cfg, conn, t, name));
      }
      emit({ type: "text", text: `MCP 服务器「${cfg.name}」已连接，注入 ${list.length} 个工具` });
    } catch (e) {
      if (conn) {
        try {
          await conn.close();
        } catch {
          /* 忽略 */
        }
      }
      const msg = (e as Error).message;
      failures.push({ id: cfg.id, message: msg });
      emit({ type: "text", text: `⚠ MCP 服务器「${cfg.name}」连接失败：${msg.slice(0, 200)}（任务继续，未注入该服务器工具）` });
    }
  }

  return {
    tools,
    close: async () => {
      await Promise.all(connections.map((c) => c.close()));
    },
    failures,
  };
}

/** 注入帮助：Executor 工具集 = 内置工具 + MCP 工具 */
export function withMcpTools(base: Record<string, ToolDef>, mcp: ToolDef[]): Record<string, ToolDef> {
  const merged: Record<string, ToolDef> = { ...base };
  for (const t of mcp) merged[t.name] = t;
  return merged;
}
