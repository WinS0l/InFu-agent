/**
 * v3 会话自动命名（主流 Agent 做法）：任务完成后用模型生成简短标题（≤10 字）。
 * 仅当标题仍是自动截断的原文（未手动重命名）时执行；失败保留原标题（fire-and-forget）。
 * server 与 CLI 共用。
 */

import { streamChat } from "./providers/chat.js";
import { loadConfig, toRuntimeModel } from "./providers/registry.js";
import type { SessionStore } from "./db/store.js";
import type { ModelConfig } from "@infu/shared";

export async function autoNameSession(
  store: SessionStore,
  sessionId: string,
  prompt: string,
  finalText: string,
  modelCfg: ModelConfig
): Promise<void> {
  const fallbackTitle = prompt.slice(0, 40);
  const s = store.getSession(sessionId);
  if (!s || s.title !== fallbackTitle) return; // 已手动重命名过则跳过
  try {
    const rt = toRuntimeModel(loadConfig(), modelCfg);
    const gen = streamChat({
      baseURL: rt.baseURL,
      apiKey: rt.apiKey,
      model: rt.model,
      messages: [
        {
          role: "system",
          content:
            "你是会话命名助手。根据用户的开发任务与完成情况，生成一个 10 字以内的中文简短标题（如「修复测试失败」「添加用户登录」）。直接输出标题本身，不要引号、前缀或任何多余文字。",
        },
        { role: "user", content: `任务：${prompt.slice(0, 200)}\n完成情况：${finalText.slice(0, 200)}` },
      ],
      retry: { maxAttempts: 1 },
      timeoutMs: 15000,
    });
    let text = "";
    for await (const d of gen) text += d.text ?? "";
    const title = text.trim().replace(/["'“”「」【】]/g, "").slice(0, 30);
    if (title && title.length > 1) store.renameSession(sessionId, title);
  } catch {
    /* 命名失败保留原标题（不阻塞任务） */
  }
}
