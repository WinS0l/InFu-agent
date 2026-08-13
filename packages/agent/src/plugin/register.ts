/**
 * 插件自注册（v2.3 批 2）— Agent 自主给 InFu 装插件（与 mcp_register 同模式）
 *
 * 白名单：只追加 config.plugins 节（models/providers/roles/mcpServers 等不可达）；
 * 审批由调用方（plugin_add 工具）负责 high + requireExplicit。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { InfuConfig, PluginConfig } from "@infu/shared";
import { parseInfuConfig } from "@infu/shared";
import { CONFIG_PATH, saveConfig } from "../providers/registry.js";

export interface RegisterPluginInput {
  id: string;
  path: string;
}

export type RegisterPluginResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** 校验并追加 plugins 节（幂等：重名拒绝；只触碰 plugins 节） */
export function registerPlugin(input: RegisterPluginInput): RegisterPluginResult {
  const id = input.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const path = input.path.trim();
  if (!id) return { ok: false, message: "id 不能为空（需含字母/数字）" };
  if (!path) return { ok: false, message: "path 不能为空（插件模块的绝对路径）" };
  const cfg = readConfig();
  if ((cfg.plugins ?? []).some((p) => p.id === id)) {
    return { ok: false, message: `插件 "${id}" 已存在（如需更新请手动编辑配置，或删除后重新添加）` };
  }
  cfg.plugins = [...(cfg.plugins ?? []), { id, path: resolve(path) } as PluginConfig];
  saveConfig(cfg);
  return {
    ok: true,
    message: `已注册插件「${id}」（${resolve(path)}）：下一任务执行阶段自动加载其工具/钩子（插件代码在 Agent 进程内运行，配置即信任）。` +
      `\n查看/探测：npm run infu -- plugin status ${id}`,
  };
}

/** 读取配置（损坏/缺失返回空配置，不抛错；与 mcp/register.ts 同构） */
export function readConfig(): InfuConfig {
  if (!existsSync(CONFIG_PATH)) return { models: [] };
  try {
    const r = parseInfuConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
    return r.ok ? r.config : { models: [] };
  } catch {
    return { models: [] };
  }
}
