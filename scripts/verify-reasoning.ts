// 验证自研 streamChat 的 reasoning 流
import { streamChat } from "../packages/agent/src/providers/chat.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

async function main() {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".infu", "config.json"), "utf-8"));
  const m = cfg.models.find((x: any) => x.apiKey);
  let r = 0, t = 0, tc = 0, firstReasoning = "";
  for await (const d of streamChat({
    baseURL: "https://api.deepseek.com/v1",
    apiKey: m.apiKey,
    model: m.model,
    messages: [{ role: "user", content: "思考一下 17*23 等于多少，先推理再回答" }],
  })) {
    if (d.reasoning) { r += d.reasoning.length; if (!firstReasoning) firstReasoning = d.reasoning.slice(0, 80); }
    if (d.text) { t += d.text.length; }
    if (d.toolCalls) tc = d.toolCalls.length;
  }
  console.log("reasoning 字符:", r, "| text 字符:", t, "| toolCalls:", tc);
  if (firstReasoning) console.log("reasoning 开头:", firstReasoning);
}
main().catch((e) => console.error("FAIL:", e.message));
