// 复现：InFu 完整工具集 × streamText 是否卡住
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool as aiTool } from "ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "../packages/agent/src/tools/index.js";
import { DEFAULT_SYSTEM_PROMPT } from "../packages/agent/src/agent/loop.js";

async function main() {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".infu", "config.json"), "utf-8"));
  const m = cfg.models.find((x: any) => x.apiKey);
  const model = createOpenAI({ apiKey: m.apiKey, baseURL: "https://api.deepseek.com/v1" })(m.model);

  const aiTools = Object.fromEntries(
    Object.entries(TOOLS).map(([name, t]) => [
      name,
      aiTool({ description: t.description, inputSchema: t.schema, execute: async () => "ok" }),
    ])
  );
  console.log("工具数:", Object.keys(aiTools).length);

  console.log("发起调用（带完整工具集 + abortSignal）...");
  const controller = new AbortController();
  const started = Date.now();
  const result = await streamText({
    model,
    system: DEFAULT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "列出 src 目录" }] as any,
    tools: aiTools,
    abortSignal: controller.signal,
  });
  console.log("流已建立（", Date.now() - started, "ms）");
  let out = "";
  for await (const chunk of result.textStream) out += chunk;
  const steps = await result.steps;
  console.log("文本:", out.slice(0, 80));
  console.log("工具调用:", steps[0]?.toolCalls?.map((t) => t.toolName).join(", ") ?? "无");
}
main().catch((e) => console.error("FAIL:", e.message));
