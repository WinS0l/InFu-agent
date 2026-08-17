/**
 * MCP 服务器自注册（v2.3 增强）— Agent 自主注册 MCP 给 InFu 自己用
 *
 * 参考 主流 生态的「插件 config hook 自注册」模式（config.mcp["x"] = {...}），
 * 映射到 InFu 的「受控工具 + 人工审批」模型：
 *  - 白名单：只允许追加 mcpServers 节；models/providers/roles/apiKey 等其余
 *    配置字段不可达（防自我提权/自我投毒——Agent 不能改自己的模型/凭据/角色）
 *  - 审批：调用方（mcp_register 工具）负责 high 级 + requireExplicit 审批
 *    （-y 自动批准也不放行，与联网放行同级特权）
 *  - 校验与 CLI（infu mcp add）/ API 完全一致：id 生成/command 或 url 非空/重名拒绝
 */

import { readFileSync, existsSync } from "node:fs";
import type { InfuConfig, McpServerConfig, RiskLevel } from "@infu/shared";
import { parseInfuConfig } from "@infu/shared";
import { configPath, saveConfig } from "../providers/registry.js";

export interface RegisterInput {
  name: string;
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  riskOverrides?: Record<string, RiskLevel>;
}

export type RegisterResult =
  | { ok: true; id: string; message: string }
  | { ok: false; message: string };

/** 生成服务器 id（与 CLI/API 一致：小写 + 非字母数字转连字符） */
export function mcpIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 校验并追加 mcpServers 到全局配置（幂等：重名拒绝；只触碰 mcpServers 节） */
export function registerMcpServer(input: RegisterInput): RegisterResult {
  const id = mcpIdFromName(input.name);
  if (!id) return { ok: false, message: "名称无法生成有效 id（需含字母/数字）" };
  if (input.type === "http") {
    if (!input.url?.trim()) return { ok: false, message: "http 类型需要 url" };
  } else {
    if (!input.command?.trim()) {
      return { ok: false, message: "stdio 类型需要 command（Windows 下 npx 需写 npx.cmd）" };
    }
  }
  const cfg = readConfig();
  if ((cfg.mcpServers ?? []).some((s) => s.id === id)) {
    return {
      ok: false,
      message: `MCP 服务器 "${id}" 已存在（如需更新请手动编辑配置，或删除后重新注册）`,
    };
  }
  const s: McpServerConfig = { id, name: input.name.trim(), type: input.type === "http" ? "http" : "stdio" };
  if (s.type === "stdio") {
    s.command = input.command!.trim();
    if (input.args?.length) s.args = input.args;
  } else {
    s.url = input.url!.trim();
  }
  if (input.riskOverrides && Object.keys(input.riskOverrides).length) {
    s.riskOverrides = input.riskOverrides;
  }
  cfg.mcpServers = [...(cfg.mcpServers ?? []), s];
  saveConfig(cfg);
  return {
    ok: true,
    id,
    message:
      `已注册 MCP 服务器「${s.name}」（${id} · ${s.type}）：下一任务执行阶段将自动注入该服务器工具（默认 medium 审批）。` +
      `\n查看/探测：npm run infu -- mcp status ${id}`,
  };
}

/** 读取配置（损坏/缺失时返回空配置，不抛错；与 server/cli 的 readConfigRaw 同构） */
export function readConfig(): InfuConfig {
  const CONFIG_PATH = configPath();
  if (!existsSync(CONFIG_PATH)) return { models: [] };
  try {
    const r = parseInfuConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
    return r.ok ? r.config : { models: [] };
  } catch {
    return { models: [] };
  }
}
