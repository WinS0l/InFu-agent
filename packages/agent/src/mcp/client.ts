/**
 * MCP 客户端（v2.3 批 1）— stdio（本地子进程）/ Streamable HTTP（远程）两种传输
 *
 * 生命周期：connect → listTools → callTool（多次）→ close。
 * 安全边界：stdio 服务器子进程不受 L1.5 沙箱约束（v1 已知限制，配置即信任；
 * 工具调用层默认 medium 审批兜底，见 tools.ts 与 docs/MCP.md）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "@infu/shared";

/** MCP 工具信息（listTools 返回） */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** 与一个 MCP 服务器的连接（工具拉取/调用转发） */
export interface McpConnection {
  serverId: string;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
  close(): Promise<void>;
}

/** 握手超时（stdio 子进程启动/远程端点响应慢时兜底，避免任务悬挂） */
const CONNECT_TIMEOUT_MS = 20_000;

export async function connectMcp(cfg: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: "infu-agent", version: "1.0.0" });
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (cfg.type === "http") {
    if (!cfg.url) throw new Error(`MCP 服务器「${cfg.name}」：http 类型需要 url`);
    transport = new StreamableHTTPClientTransport(new URL(cfg.url));
  } else {
    if (!cfg.command) throw new Error(`MCP 服务器「${cfg.name}」：stdio 类型需要 command`);
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ? { ...process.env, ...cfg.env } as Record<string, string> : undefined,
    });
  }

  // 握手超时兜底（SDK 默认更久；连接失败时子进程由 transport 自行清理）
  await Promise.race([
    client.connect(transport),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("连接超时（20s）")), CONNECT_TIMEOUT_MS).unref()
    ),
  ]);

  return {
    serverId: cfg.id,
    async listTools() {
      const r = await client.listTools();
      return (r.tools ?? []).map((t) => ({
        name: t.name,
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? (t.inputSchema as Record<string, unknown>)
            : undefined,
      }));
    },
    async callTool(name, args) {
      const r = await client.callTool({ name, arguments: args });
      // 文本化：拼接 text 内容；image 等非文本给占位提示
      // （callTool 返回带 unknown 索引签名，content 需显式断言为块数组）
      const blocks = (r.content ?? []) as Array<{ type: string; [k: string]: unknown }>;
      const parts: string[] = [];
      for (const c of blocks) {
        if (c.type === "text") parts.push(String(c.text));
        else if (c.type === "image") parts.push("[图片内容]");
        else parts.push(`[${c.type} 内容]`);
      }
      return { ok: r.isError !== true, text: parts.join("\n") || "(空结果)" };
    },
    async close() {
      try {
        await client.close();
      } catch {
        /* 已关闭/失败忽略 */
      }
    },
  };
}
