// 验证：AI SDK v6 + DeepSeek reasoning 流
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

async function main() {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".infu", "config.json"), "utf-8"));
  const m = cfg.models.find((x: any) => x.apiKey);
  const model = createOpenAI({ apiKey: m.apiKey, baseURL: "https://api.deepseek.com/v1" }).chat(m.model);

  console.log("发起带思考的调用（deepseek 默认思考模型）...");
  const result = await streamText({
    model,
    prompt: "请思考一下 17*23 等于多少，先推理再回答",
    onChunk: (c: any) => {
      const keys = Object.keys(c);
      const raw = c.rawChunk ? JSON.stringify(c.rawChunk).slice(0, 150) : (c as any).rawDelta ? JSON.stringify((c as any).rawDelta).slice(0, 150) : "";
      if (c.type !== "text-delta" || (raw && raw.includes("reasoning"))) {
        console.log("chunk type:", c.type, "| raw:", raw);
      }
    },
  });

  // 1) reasoningStream 是否存在
  console.log("result.reasoningStream:", typeof (result as any).reasoningStream);
  if ((result as any).reasoningStream) {
    let r = "";
    for await (const chunk of (result as any).reasoningStream) {
      r += chunk;
    }
    console.log("reasoning 内容长度:", r.length, "| 前 120 字:", r.slice(0, 120));
  }

  // 2) textStream
  let text = "";
  for await (const chunk of result.textStream) text += chunk;
  console.log("正文:", text.slice(0, 120));

  // 3) 检查 steps 里的 reasoning parts
  const steps = await result.steps;
  const parts = (steps as any)[0]?.parts ?? [];
  const reasoningParts = parts.filter((p: any) => p.type === "reasoning");
  console.log("step parts 类型:", parts.map((p: any) => p.type).join(", "));
  if (reasoningParts.length) {
    console.log("reasoning part 长度:", reasoningParts[0].text?.length ?? 0);
  }
}
main().catch((e) => console.error("FAIL:", e.message));
