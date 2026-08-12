// AI SDK × DeepSeek 最小调用诊断
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

async function main() {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".infu", "config.json"), "utf-8"));
  const m = cfg.models.find((x: any) => x.apiKey);
  console.log("模型:", m.model, "key:", m.apiKey.slice(0, 6) + "****");

  const model = createOpenAI({ apiKey: m.apiKey, baseURL: "https://api.deepseek.com/v1" })(m.model);

  console.log("1) 最简调用（无工具）...");
  try {
    const r1 = await streamText({ model, prompt: "say hi" });
    let out = "";
    for await (const c of r1.textStream) out += c;
    console.log("   ✅ 结果:", out.slice(0, 100));
  } catch (e: any) {
    console.log("   ❌ 错误:", e.message?.slice(0, 200));
  }

  console.log("2) 带工具调用（zod schema）...");
  try {
    const { tool } = await import("ai");
    const { z } = await import("zod");
    const r2 = await streamText({
      model,
      prompt: "调用 list 工具",
      tools: {
        list: tool({
          description: "列出内容",
          inputSchema: z.object({ keyword: z.string().optional() }),
          execute: async () => "ok",
        }),
      },
    });
    const steps = await r2.steps;
    const text = await r2.textStream?.toArray?.() ?? [];
    console.log("   ✅ 文本:", text.join("").slice(0, 80));
    console.log("   工具调用:", steps[0]?.toolCalls?.map((t) => `${t.toolName}(${JSON.stringify((t as any).input)})`).join(", ") ?? "无");
  } catch (e: any) {
    console.log("   ❌ 错误:", e.message?.slice(0, 200));
  }
}
main();
