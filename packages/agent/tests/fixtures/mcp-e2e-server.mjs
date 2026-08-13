/**
 * 最小 stdio MCP 服务器（v2.3 端到端实测夹具）
 * 运行：node packages/agent/tests/fixtures/mcp-e2e-server.mjs
 *
 * 提供两个工具：
 *  - greet：纯读（验证工具注入/调用转发）
 *  - add_note：写文件（验证 medium 审批拦截与批准后执行）
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

const server = new Server({ name: "infu-e2e", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "greet",
      description: "向某人发出问候（纯读，无副作用）",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "要问候的名字" } },
        required: ["name"],
      },
    },
    {
      name: "add_note",
      description: "把一条笔记追加写入指定文件（有副作用，验证审批）",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件绝对路径" },
          content: { type: "string", description: "笔记内容" },
        },
        required: ["path", "content"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "greet") {
    return { content: [{ type: "text", text: `你好，${args?.name ?? "朋友"}！这是来自 MCP 服务器 infu-e2e 的问候。` }] };
  }
  if (name === "add_note") {
    const p = resolve(String(args?.path ?? ""));
    appendFileSync(p, String(args?.content ?? "") + "\n", "utf-8");
    return { content: [{ type: "text", text: `已追加笔记到 ${p}` }] };
  }
  return { content: [{ type: "text", text: `未知工具：${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
