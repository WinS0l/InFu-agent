/**
 * 插件系统 v1（v2.3 批 2）— 从 MCP 适配器实例反推的插件协议
 *
 * 插件 = JS/TS 模块（opencode 式），可注册 工具/钩子/技能：
 *   export default { id, name, description, tools?, hooks?, skills? }  // PluginDef
 *
 * 安全边界：插件代码在 Agent 进程内任意执行（配置即信任——与 MCP 服务器同级信任，
 * 文档见 docs/PLUGINS.md）；插件工具走现有 risk 审批体系（未声明默认 medium）。
 * 失败插件跳过不阻塞任务（emit 提示，与 loadMcpTools 哲学一致）。
 */

import { pathToFileURL } from "node:url";
import type { AgentEvent, HookFn, PluginConfig, PluginDef, ToolDef } from "@infu/shared";

export interface PluginLoadResult {
  /** 插件注册的工具（与 MCP 工具一并注入 Executor；重名加插件 id 前缀） */
  tools: ToolDef[];
  /** 插件注册的钩子（任务期间对全部工具生效） */
  hooks: { preToolUse: HookFn[]; postToolUse: HookFn[] };
  /** 每个插件的归属信息（CLI status / API probe 展示用） */
  perPlugin: Array<{ id: string; toolNames: string[]; hookCount: number }>;
  /** 加载失败的插件（提示用） */
  failures: Array<{ id: string; message: string }>;
}

/** 校验插件导出形态并提取工具（宽松：导出异常/非插件 → 抛错由调用方捕获） */
async function loadPluginModule(cfg: PluginConfig): Promise<PluginDef> {
  const mod = await import(pathToFileURL(cfg.path).href);
  const def = (mod as { default?: unknown }).default;
  if (!def || typeof def !== "object") {
    throw new Error(`插件模块 ${cfg.path} 缺少 default 导出（需导出 PluginDef 对象）`);
  }
  const d = def as Partial<PluginDef>;
  if (!d.id || !d.name) throw new Error(`插件 ${cfg.path} 缺少 id/name`);
  return d as PluginDef;
}

/** 加载所有启用插件；失败插件 emit 提示后跳过（不阻塞任务） */
export async function loadPlugins(
  plugins: PluginConfig[] | undefined,
  emit: (e: AgentEvent) => void
): Promise<PluginLoadResult> {
  const tools: ToolDef[] = [];
  const hooks: PluginLoadResult["hooks"] = { preToolUse: [], postToolUse: [] };
  const perPlugin: PluginLoadResult["perPlugin"] = [];
  const failures: Array<{ id: string; message: string }> = [];
  const usedNames = new Set<string>();

  for (const cfg of plugins ?? []) {
    if (cfg.enabled === false) continue;
    try {
      const def = await loadPluginModule(cfg);
      // 工具（数组或延迟生成函数；risk 缺失默认 medium——插件工具是潜在注入载体）
      const defTools = typeof def.tools === "function" ? def.tools() : (def.tools ?? []);
      const toolNames: string[] = [];
      for (const t of defTools) {
        let name = t.name;
        if (usedNames.has(name)) name = `${cfg.id}_${name}`; // 跨插件重名加前缀
        usedNames.add(name);
        toolNames.push(name);
        tools.push({ ...t, name, risk: t.risk ?? "medium" });
      }
      // 钩子（插件级，对所有工具生效）
      let hookCount = 0;
      if (def.hooks?.preToolUse) { hooks.preToolUse.push(def.hooks.preToolUse); hookCount++; }
      if (def.hooks?.postToolUse) { hooks.postToolUse.push(def.hooks.postToolUse); hookCount++; }
      perPlugin.push({ id: cfg.id, toolNames, hookCount });
      emit({
        type: "text",
        text: `插件「${def.name}」（${cfg.id}）已加载：${defTools.length} 个工具、${hookCount} 个钩子${def.skills?.length ? `、${def.skills.length} 个技能目录` : ""}`,
      });
    } catch (e) {
      const msg = (e as Error).message;
      failures.push({ id: cfg.id, message: msg });
      emit({ type: "text", text: `⚠ 插件「${cfg.id}」加载失败：${msg.slice(0, 200)}（任务继续，未加载该插件）` });
    }
  }

  return { tools, hooks, perPlugin, failures };
}

/** 合并帮助：内置工具 + 插件/MCP 工具 */
export function withPlugins(base: Record<string, ToolDef>, extra: ToolDef[]): Record<string, ToolDef> {
  const merged: Record<string, ToolDef> = { ...base };
  for (const t of extra) merged[t.name] = t;
  return merged;
}
