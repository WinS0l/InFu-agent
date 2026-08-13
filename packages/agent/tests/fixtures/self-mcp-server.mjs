/**
 * 最小 stdio MCP 服务器（自研闭环夹具）
 * 运行：node packages/agent/tests/fixtures/self-mcp-server.mjs
 *
 * 提供一个工具：
 *  - get_time：无参数，返回当前日期时间字符串
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "my-time", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_time",
      description: "返回当前日期时间字符串（无参数）",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  if (name === "get_time") {
    return { content: [{ type: "text", text: new Date().toString() }] };
  }
  return { content: [{ type: "text", text: `未知工具：${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
