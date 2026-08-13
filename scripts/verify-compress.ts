/**
 * 上下文压缩真实模型验证（一次性脚本，v2.2 批 2 收尾）
 * 直接调 compressMessages + 真实模型摘要链路（绕过 loop，不改用户配置）：
 *   1. 构造超预算历史（~5k token，模拟长会话）
 *   2. budget=4000（小窗口模型语义）→ 应触发压缩
 *   3. 摘要由真实 deepseek 生成
 *   4. 断言：压缩后 ≤ 60% 预算、含摘要消息、保留最近内容
 */
import { loadConfig, resolveModel, toRuntimeModel } from "../packages/agent/src/providers/registry.js";
import { streamChatWithFailover, ModelChain } from "../packages/agent/src/providers/gateway.js";
import { compressMessages, estimateTokens, serializeHistory, SUMMARIZE_PROMPT } from "../packages/agent/src/agent/context.js";
import type { ChatMessageLike } from "../packages/agent/src/providers/chat.js";

async function main() {
  const cfg = loadConfig();
  const model = resolveModel(cfg);
  const rt = toRuntimeModel(model);
  const chain = new ModelChain([rt]);
  console.log(`使用模型：${model.name}（${rt.model}）\n`);

  // 1. 构造超预算历史（~5k token）
  const history: ChatMessageLike[] = [
    { role: "system", content: "你是 InFu，软件工程智能体。" },
    { role: "user", content: "帮我给项目加一个登录功能" },
    ...Array.from({ length: 40 }, (_, i) => [
      {
        role: "assistant" as const,
        content: `第 ${i} 步：我先看一下现有的用户模块和路由配置，确认鉴权方案的落点。${"分析内容".repeat(30)}`,
        tool_calls: [{ id: `call-${i}`, type: "function" as const, function: { name: "read_file", arguments: `{"path":"src/auth/user.ts"}` } }],
      },
      {
        role: "tool" as const,
        tool_call_id: `call-${i}`,
        content: `文件 src/auth/user.ts 内容：...${"（代码内容略）".repeat(20)}...`,
      },
    ]).flat(),
    { role: "user", content: "继续，把登录接口加上，记得跑测试" },
  ];

  const before = estimateTokens(history);
  console.log(`历史估算：${before} tokens（预算 4000 → 触发线 3200）`);

  // 2. 真实模型摘要生成器（与 loop 内 ensureContextBudget 同链路）
  const summarize = async (h: ChatMessageLike[]): Promise<string> => {
    const out: string[] = [];
    for await (const d of streamChatWithFailover({
      chain,
      messages: [
        { role: "system", content: "你是 InFu 的上下文摘要器：把历史对话压缩为简洁中文摘要，保留任务目标、关键决策、文件改动、测试结果、未完成事项；不要编造内容。" },
        { role: "user", content: SUMMARIZE_PROMPT + serializeHistory(h) },
      ],
    })) {
      if (d.text) out.push(d.text);
    }
    return out.join("").trim();
  };

  // 3. 压缩
  const r = await compressMessages(history, 4000, summarize);
  console.log(`压缩后估算：${r.after} tokens（目标线 2400）`);
  console.log(`\n── 摘要（真实模型生成）──\n${r.summary.slice(0, 400)}\n`);

  // 4. 断言
  let ok = true;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "  ✅" : "  ❌"} ${name} ${detail}`);
    if (!cond) ok = false;
  };
  check("触发了压缩", r.after < r.before, `${r.before} → ${r.after}`);
  check("压缩后含摘要消息", r.messages[0].content.includes("此前会话摘要"));
  check("摘要非空（真实模型产出）", r.summary.trim().length > 20, `len=${r.summary.trim().length}`);
  check("保留最近内容", r.messages.length < history.length && r.messages.some((m) => m.role === "tool"));
  check("压缩后整体 ≤ 目标线+容差", r.after <= 4000 * 0.6 + 64, String(r.after));

  console.log(`\n${ok ? "✅ 上下文压缩真实模型链路验证通过" : "❌ 存在失败项"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`✗ 验证失败：${e.message}`);
  process.exit(1);
});
