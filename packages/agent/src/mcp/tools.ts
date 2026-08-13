/**
 * MCP 工具适配器（v2.3）— MCP 工具 → InFu ToolDef
 *
 * 风险策略：默认 medium（MCP 工具可读写任意文件/执行任意命令，是 prompt 注入的潜在载体），
 * riskOverrides 按「工具名精确 > 前缀*通配」覆盖（默认值见 docs/MCP.md）。
 * 审批/审计：走现有通道——requestApproval（approval-required/approval-result 事件）
 * + tool-start/tool-result 事件全量落库（会话回放即审计）。
 */

import type { McpServerConfig, RiskLevel, ToolDef } from "@infu/shared";
import type { McpConnection, McpToolInfo } from "./client.js";
import { jsonSchemaToZod } from "./schema.js";

/** 解析工具有效风险：riskOverrides 精确匹配 > 前缀通配（key*）> 默认 medium */
export function resolveToolRisk(cfg: McpServerConfig, toolName: string): RiskLevel {
  const ov = cfg.riskOverrides ?? {};
  if (ov[toolName]) return ov[toolName] as RiskLevel;
  for (const [k, v] of Object.entries(ov)) {
    if (k.endsWith("*") && toolName.startsWith(k.slice(0, -1))) return v as RiskLevel;
  }
  return "medium";
}

/** MCP 工具 → ToolDef 适配器（displayName 为注入后的工具名，冲突时带服务器前缀） */
export function mcpToolToDef(
  cfg: McpServerConfig,
  conn: McpConnection,
  tool: McpToolInfo,
  displayName: string
): ToolDef {
  const risk = resolveToolRisk(cfg, tool.name);
  return {
    name: displayName,
    description: tool.description || `MCP 工具（服务器 ${cfg.name}）`,
    schema: jsonSchemaToZod(tool.inputSchema ?? {}),
    risk,
    execute: async (args, ctx) => {
      // 审批：medium/high 需人工确认（默认 medium，防投毒；low 直接放行）
      if (risk !== "low") {
        const approved = await ctx.requestApproval(
          `MCP 工具「${cfg.name}」调用 ${tool.name}${tool.description ? `（${tool.description.slice(0, 200)}）` : ""}`,
          risk
        );
        if (!approved) return `用户拒绝了 MCP 工具 ${displayName} 的调用`;
      }
      try {
        const r = await conn.callTool(tool.name, args);
        return r.ok ? r.text : `MCP 工具 ${displayName} 执行失败（服务器标记 isError）：\n${r.text}`;
      } catch (e) {
        // 调用异常：返回错误文本而非抛错——模型可读到错误并调整（与 run_command 语义一致）
        return `MCP 工具 ${displayName} 调用异常：${(e as Error).message}`;
      }
    },
  };
}
