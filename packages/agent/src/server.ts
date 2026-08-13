/**
 * InFu Agent 服务层 — Hono HTTP + SSE 流式
 *
 * 端点：
 *   GET  /api/models         模型列表（脱敏）
 *   POST /api/chat           发起 Agent 任务（SSE 流式返回 AgentEvent；支持分层编排）
 *   GET  /api/templates      模板任务列表（M4 小白引导）
 *   GET  /api/health         健康检查
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelConfig, AgentEvent, RiskLevel, InfuConfig, OrchestrateMode, PhaseId, ProviderConfig } from "@infu/shared";
import { loadConfig, saveConfig, resolveFallbackModels, resolveRoleModel, resolveRoleThinking, toRuntimeModel, resolveBaseURL, CONFIG_PATH } from "./providers/registry.js";
import { parseInfuConfig, approvalPolicySchema, sandboxConfigSchema, generalConfigSchema, appearanceConfigSchema } from "@infu/shared";
import { TOOLS } from "./tools/index.js";
import { runAgent, DEFAULT_SYSTEM_PROMPT } from "./agent/loop.js";
import { runOrchestratedTask, type OrchestratedRunOptions } from "./agent/orchestrator.js";
import { inferResumePhase } from "./agent/resume.js";
import { loadMcpTools } from "./mcp/index.js";
import { loadPlugins } from "./plugin/index.js";
import { registerPlugin } from "./plugin/register.js";
import { listSkills, buildSkillsPrompt } from "./plugin/skills.js";
import { listAgents, buildAgentsPrompt, writeAgentFile, deleteAgentFile } from "./agent/agents.js";
import { TASK_TEMPLATES } from "./templates.js";
import { getStore } from "./db/store.js";
import { rebuildMessages } from "./db/rebuild.js";
import type { ChatMessageLike } from "./providers/chat.js";
import { resolveApprovalPolicy, shouldAutoApprove } from "./approval/policy.js";
import { dockerAvailable } from "./sandbox/index.js";
import { winRestrictedAvailable } from "./sandbox/win-restricted.js";
import {
  createTerminalSession, getTerminalSession, subscribeOutput, writeInput, resizeSession,
  killTerminalSession, closeAllTerminalSessions, listTerminalSessions,
} from "./terminal/session.js";
import { detectDangerousTerminalCommand, auditTerminalCommand } from "./terminal/policy.js";

const execFileAsync = promisify(execFile);

/** git 命令辅助（cwd = 主仓库） */
async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** 是否为 git 仓库 */
async function isGitRepo(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** 读取配置（损坏/缺失返回空配置；写入统一走 registry.saveConfig） */
function readConfigRaw(): InfuConfig {
  if (!existsSync(CONFIG_PATH)) return { models: [] };
  try {
    const r = parseInfuConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
    return r.ok ? r.config : { models: [] };
  } catch {
    return { models: [] };
  }
}

// ── 后台运行日志（服务窗口实时打印 + 落盘 ~/.infu/logs/agent.log）──
const LOG_DIR = join(homedir(), ".infu", "logs");
const LOG_FILE = join(LOG_DIR, "agent.log");
function ensureLogDir() {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* 忽略 */ }
}
function logEvent(e: AgentEvent) {
  const brief =
    e.type === "text"
      ? `text: ${JSON.stringify(e.text.slice(-80))}`
      : e.type === "tool-start"
        ? `tool-start: ${e.tool} ${JSON.stringify(e.args).slice(0, 150)} [${e.risk}]`
        : e.type === "tool-result"
          ? `tool-result: ${e.tool} ${e.ok ? "ok" : "ERROR"} ${e.summary.slice(0, 120)}`
          : e.type === "approval-required"
            ? `approval-required: ${e.description} [${e.risk}]`
            : JSON.stringify(e).slice(0, 200);
  const line = `[${new Date().toISOString().slice(11, 19)}] ${brief}`;
  console.log(line);
  try {
    ensureLogDir();
    appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch { /* 日志失败不影响主流程 */ }
}

export interface ServerOptions {
  port?: number;
  host?: string;
  /** 默认项目根目录（无 root 时使用） */
  defaultRoot?: string;
}

/**
 * Bridge a Web `Response` returned by Hono to Node's HTTP response.
 *
 * @hono/node-server 1.19.x can accept a chunked SSE response on Node 24 but
 * leave its chunks buffered indefinitely.  Keep the Hono application and its
 * Web-standard streaming API, while using this small, direct Node bridge for
 * the final socket write.
 */
async function forwardResponse(response: Response, outgoing: ServerResponse) {
  const headers = Object.fromEntries(response.headers.entries());
  outgoing.writeHead(response.status, headers);
  outgoing.flushHeaders();

  if (!response.body) {
    outgoing.end();
    return;
  }

  const reader = response.body.getReader();
  let closed = false;
  const cancel = (reason?: Error) => {
    if (!closed) reader.cancel(reason).catch(() => {});
  };
  outgoing.once("close", cancel);
  outgoing.once("error", cancel);

  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!outgoing.write(value)) {
        await new Promise<void>((resolve, reject) => {
          outgoing.once("drain", resolve);
          outgoing.once("error", reject);
        });
      }
    }
    if (!outgoing.writableEnded) outgoing.end();
  } catch (error) {
    if (!outgoing.destroyed) outgoing.destroy(error instanceof Error ? error : undefined);
  } finally {
    closed = true;
    outgoing.off("close", cancel);
    outgoing.off("error", cancel);
    reader.releaseLock();
  }
}

async function handleNodeRequest(app: ReturnType<typeof createApp>, incoming: IncomingMessage, outgoing: ServerResponse) {
  try {
    const host = incoming.headers.host ?? "127.0.0.1";
    const method = incoming.method ?? "GET";
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
    }
    const request = new Request(`http://${host}${incoming.url ?? "/"}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" as const }),
    });
    await forwardResponse(await app.fetch(request), outgoing);
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json" });
    if (!outgoing.writableEnded) outgoing.end(JSON.stringify({ ok: false, message: "Internal server error" }));
    console.error("[infu-agent] request failed:", error);
  }
}

/** API Key 脱敏 */
function maskSecret(s: string): string {
  if (s.length <= 8) return "****";
  return s.slice(0, 4) + "****" + s.slice(-4);
}

export function createApp(opts: ServerOptions = {}) {
  const app = new Hono();
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  // 计划确认挂起队列（M4 计划卡片：POST /api/plan/:id 决策）
  const pendingPlans = new Map<string, (d: { plan?: string; feedback?: string; cancelled?: boolean }) => void>();

  // ── v2 供应商凭据（模型管理重构：一份 key 挂多个模型）──

  // 供应商列表（脱敏）
  app.get("/api/providers", (c) => {
    const cfg = loadConfig();
    const providers = (cfg?.providers ?? []).map((p: ProviderConfig) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseURL: p.baseURL,
      hasKey: !!(p.apiKey || process.env[`INFU_${p.kind.toUpperCase()}_API_KEY`]),
      modelCount: cfg?.models.filter((m) => m.providerId === p.id).length ?? 0,
    }));
    return c.json({ providers });
  });

  // 新增供应商（模板机制：kind → baseURL 前端自动填；id 可自定义）
  app.post("/api/providers", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const p: ProviderConfig = {
      id: String(body.id || "").trim(),
      name: String(body.name || "").trim(),
      kind: String(body.kind || "custom") as ProviderConfig["kind"],
    };
    if (!p.id || !p.name) return c.json({ ok: false, message: "id/name 不能为空" }, 400);
    if ((cfg.providers ?? []).some((x) => x.id === p.id)) {
      return c.json({ ok: false, message: `供应商 id "${p.id}" 已存在` }, 409);
    }
    if (body.baseURL) p.baseURL = String(body.baseURL);
    if (body.apiKey) p.apiKey = String(body.apiKey);
    cfg.providers = [...(cfg.providers ?? []), p];
    saveConfig(cfg);
    return c.json({ ok: true, provider: p.id });
  });

  // 更新供应商（Key 只增不改，防误清）
  app.put("/api/providers/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const p = (cfg.providers ?? []).find((x) => x.id === id);
    if (!p) return c.json({ ok: false, message: "供应商不存在" }, 404);
    if (body.name) p.name = String(body.name);
    if (body.kind) p.kind = body.kind as ProviderConfig["kind"];
    if (typeof body.baseURL === "string") p.baseURL = body.baseURL || undefined;
    if (typeof body.apiKey === "string" && body.apiKey.trim()) p.apiKey = body.apiKey.trim();
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // 删除供应商（连带删除引用它的模型；默认模型迁移到剩余第一个）
  app.delete("/api/providers/:id", async (c) => {
    const id = c.req.param("id");
    const cfg = readConfigRaw();
    if (!(cfg.providers ?? []).some((x) => x.id === id)) {
      return c.json({ ok: false, message: "供应商不存在" }, 404);
    }
    cfg.providers = (cfg.providers ?? []).filter((x) => x.id !== id);
    cfg.models = cfg.models.filter((m) => m.providerId !== id);
    if (cfg.defaultModelId && !cfg.models.some((m) => m.id === cfg.defaultModelId)) {
      cfg.defaultModelId = cfg.models[0]?.id;
    }
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // 从上游获取模型列表（OpenAI 兼容 GET {baseURL}/models；v2 勾选启用）
  app.post("/api/providers/:id/models", async (c) => {
    const id = c.req.param("id");
    const cfg = readConfigRaw();
    const p = (cfg.providers ?? []).find((x) => x.id === id);
    if (!p) return c.json({ ok: false, message: "供应商不存在" }, 404);
    const key = p.apiKey || process.env[`INFU_${p.kind.toUpperCase()}_API_KEY`];
    const base = resolveBaseURL(p.kind, p.baseURL);
    if (!base) return c.json({ ok: false, message: "供应商缺少 API 地址（baseURL）" }, 400);
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        return c.json({ ok: false, message: `上游返回 ${res.status}：${(await res.text()).slice(0, 200)}` }, 502);
      }
      const data = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
      const list = Array.isArray(data.data)
        ? data.data.map((m) => ({
            id: String(m.id ?? ""),
            name: String(m.name ?? m.id ?? ""),
          }))
        : [];
      return c.json({ ok: true, models: list.filter((m: { id: string }) => m.id) });
    } catch (e) {
      return c.json(
        { ok: false, message: `获取模型列表失败：${(e as Error).message.slice(0, 150)}（部分端点不支持 /models）` },
        502
      );
    }
  });

  // 模型列表（脱敏；v2：kind/端点/key 状态经供应商凭据解析）
  app.get("/api/models", (c) => {
    const cfg = loadConfig();
    const models = (cfg?.models ?? []).map((m: ModelConfig) => {
      const p = cfg?.providers?.find((x) => x.id === m.providerId);
      const kind = p?.kind ?? m.provider ?? "custom";
      return {
        id: m.id,
        name: m.name,
        provider: kind,
        providerId: m.providerId,
        model: m.model,
        baseURL: p?.baseURL ?? m.baseURL,
        hasKey: !!((p?.apiKey ?? m.apiKey) || process.env[`INFU_${kind.toUpperCase()}_API_KEY`]),
        isDefault: m.id === cfg?.defaultModelId,
        fallbackModelIds: m.fallbackModelIds,
        contextWindow: m.contextWindow,
        thinkingLevels: m.thinkingLevels,
      };
    });
    return c.json({ models, configPath: CONFIG_PATH });
  });

  // 新增模型
  app.post("/api/models", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const m: ModelConfig = {
      id: String(body.id || "").trim(),
      name: String(body.name || "").trim(),
      model: String(body.model || "").trim(),
      // v2：providerId 引用供应商凭据；v1 遗留字段兼容
      ...(typeof body.provider === "string" && body.provider ? { provider: body.provider as ModelConfig["provider"] } : {}),
      ...(typeof body.providerId === "string" && body.providerId ? { providerId: body.providerId } : {}),
    };
    if (!m.id || !m.name || !m.model) return c.json({ ok: false, message: "id/name/model 不能为空" }, 400);
    if (cfg.models.some((x) => x.id === m.id)) return c.json({ ok: false, message: `模型 id "${m.id}" 已存在` }, 409);
    if (body.baseURL) m.baseURL = String(body.baseURL);
    if (body.apiKey) m.apiKey = String(body.apiKey);
    if (Array.isArray(body.fallbackModelIds)) m.fallbackModelIds = body.fallbackModelIds.map(String);
    // v2 上下文窗口/思考级别（缺省自动推断；0 = 清除）
    if (typeof body.contextWindow === "number") m.contextWindow = body.contextWindow > 0 ? body.contextWindow : undefined;
    if (typeof body.thinkingLevels === "number") m.thinkingLevels = body.thinkingLevels > 0 ? body.thinkingLevels : undefined;
    if (Array.isArray(body.thinkingOverride)) m.thinkingOverride = body.thinkingOverride;
    cfg.models.push(m);
    if (!cfg.defaultModelId) cfg.defaultModelId = m.id;
    saveConfig(cfg);
    return c.json({ ok: true, model: m.id });
  });

  // 更新模型（含 API Key）
  app.put("/api/models/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const m = cfg.models.find((x) => x.id === id);
    if (!m) return c.json({ ok: false, message: "模型不存在" }, 404);
    if (body.name) m.name = String(body.name);
    if (body.model) m.model = String(body.model);
    if (body.provider) m.provider = body.provider as ModelConfig["provider"];
    if (body.providerId) m.providerId = String(body.providerId);
    if (typeof body.baseURL === "string") m.baseURL = body.baseURL || undefined;
    // 备用模型（v2.2 降级链）
    if (Array.isArray(body.fallbackModelIds)) {
      const ids = body.fallbackModelIds.map(String).filter(Boolean);
      m.fallbackModelIds = ids.length ? ids : undefined;
    }
    // 上下文窗口/思考级别（v2 压缩预算与思考映射；0/空 = 清除恢复自动）
    if (typeof body.contextWindow === "number") {
      m.contextWindow = body.contextWindow > 0 ? body.contextWindow : undefined;
    }
    if (typeof body.thinkingLevels === "number") {
      m.thinkingLevels = body.thinkingLevels > 0 ? body.thinkingLevels : undefined;
    }
    if (Array.isArray(body.thinkingOverride)) m.thinkingOverride = body.thinkingOverride;
    // ⚠️ Key 只增不改：空字符串/缺省时保持原 Key 不变（防止编辑表单误清 Key）
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      m.apiKey = String(body.apiKey).trim();
    }
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // 删除模型
  app.delete("/api/models/:id", async (c) => {
    const id = c.req.param("id");
    const cfg = readConfigRaw();
    cfg.models = cfg.models.filter((x) => x.id !== id);
    if (cfg.defaultModelId === id) cfg.defaultModelId = cfg.models[0]?.id;
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // 设置默认模型
  app.post("/api/models/:id/default", async (c) => {
    const id = c.req.param("id");
    const cfg = readConfigRaw();
    if (!cfg.models.some((x) => x.id === id)) return c.json({ ok: false, message: "模型不存在" }, 404);
    cfg.defaultModelId = id;
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // ── v2.3 角色路由（Web 面板：每角色 模型 + 独立思考级别）──

  // 当前角色配置（脱敏：模型 id + 思考级别；面板初始化）
  app.get("/api/roles", (c) => {
    const cfg = loadConfig();
    const roles = (["planner", "executor", "reviewer"] as const).map((role) => {
      const ref = cfg?.roles?.[role];
      const modelId = typeof ref === "string" ? ref : ref?.model;
      return {
        role,
        modelId: cfg?.models.some((m) => m.id === modelId) ? modelId : undefined,
        thinkingLevel: typeof ref === "object" && ref.thinkingLevel ? ref.thinkingLevel : undefined,
      };
    });
    return c.json({ roles });
  });

  // 保存角色配置（body: { planner?: { model?: string; thinkingLevel?: number }, ... }；缺省清除该角色）
  app.put("/api/roles", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const roles: NonNullable<InfuConfig["roles"]> = {};
    for (const role of ["planner", "executor", "reviewer"] as const) {
      const r = body[role];
      if (!r || typeof r !== "object") continue; // 缺省 = 清除
      const modelId = typeof r.model === "string" && r.model ? r.model : undefined;
      const thinkingLevel = typeof r.thinkingLevel === "number" && r.thinkingLevel >= 1 && r.thinkingLevel <= 4
        ? Math.round(r.thinkingLevel)
        : undefined;
      if (!modelId && thinkingLevel == null) continue;
      if (modelId && !cfg.models.some((m) => m.id === modelId)) {
        return c.json({ ok: false, message: `角色 ${role} 指定了不存在的模型 "${modelId}"` }, 400);
      }
      roles[role] = thinkingLevel != null ? { model: modelId ?? cfg.defaultModelId ?? "", thinkingLevel } : modelId!;
    }
    cfg.roles = Object.keys(roles).length ? roles : undefined;
    saveConfig(cfg);
    return c.json({ ok: true, roles: cfg.roles });
  });

  // ── v2.4 设置界面（配置系统 UI 化：权限等级 / 沙箱等级 / 常规 / 外观）──

  // 读取设置四节（缺省节返回空对象，Web 端渲染默认态；defaultModelId 供常规 Tab 默认模型）
  // 附带沙箱可用性（docker/win 受限），供 UI 标注「当前机器不可用」
  app.get("/api/config", async (c) => {
    const cfg = loadConfig();
    const [dockerOk, winOk] = await Promise.all([
      dockerAvailable().catch(() => false),
      (async () => process.platform === "win32" && (await winRestrictedAvailable()))(),
    ]);
    return c.json({
      approvalPolicy: cfg?.approvalPolicy ?? {},
      sandbox: { ...(cfg?.sandbox ?? {}), dockerAvailable: dockerOk, winRestrictedOk: winOk },
      general: cfg?.general ?? {},
      appearance: cfg?.appearance ?? {},
      defaultModelId: cfg?.defaultModelId ?? null,
    });
  });

  // 保存设置四节（白名单：只接受 approvalPolicy/sandbox/general/appearance/defaultModelId；
  // models/providers/apiKey 等其余配置节不可达——防提权，与 mcp_register/plugin_add 同模式）
  app.put("/api/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== "object") {
      return c.json({ ok: false, message: "请求体必须为 JSON 对象" }, 400);
    }
    const ALLOWED = ["approvalPolicy", "sandbox", "general", "appearance", "defaultModelId"] as const;
    const bad = Object.keys(body).filter((k) => !(ALLOWED as readonly string[]).includes(k));
    if (bad.length) {
      return c.json({ ok: false, message: `不允许写入的配置节: ${bad.join(", ")}` }, 400);
    }
    const clean: Partial<InfuConfig> = {};
    for (const key of ALLOWED) {
      if (body[key] === undefined || key === "defaultModelId") continue;
      const schema =
        key === "approvalPolicy" ? approvalPolicySchema
        : key === "sandbox" ? sandboxConfigSchema
        : key === "general" ? generalConfigSchema
        : appearanceConfigSchema;
      // strip 模式：拒绝未知字段落盘（防通过设置接口混入敏感字段）
      const r = schema.strip().safeParse(body[key]);
      if (!r.success) {
        const issue = r.error.issues[0];
        return c.json({ ok: false, message: `${key}: ${issue?.message ?? "格式错误"}` }, 400);
      }
      clean[key] = r.data as never;
    }
    const cfg = readConfigRaw();
    const merged: InfuConfig = { ...cfg, ...clean };
    // 默认模型：字符串 = 设置；null/空 = 清除（显式删键）
    if (typeof body.defaultModelId === "string" && body.defaultModelId.trim()) {
      merged.defaultModelId = body.defaultModelId.trim();
    } else if (body.defaultModelId !== undefined) {
      delete merged.defaultModelId;
    }
    const validated = parseInfuConfig(merged);
    if (!validated.ok) {
      return c.json({ ok: false, message: `配置校验失败: ${validated.error}` }, 400);
    }
    saveConfig(validated.config);
    return c.json({ ok: true });
  });

  // ── v2.4 批 2 Web 交互式终端（node-pty；高危命令审批 + 全量审计）──

  // 创建终端会话（cwd = 项目根；shell 可选 cmd/powershell/bash）
  app.post("/api/terminal", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session = createTerminalSession(
      typeof body.cwd === "string" ? body.cwd : undefined,
      typeof body.shell === "string" ? body.shell : undefined
    );
    return c.json({ ok: true, id: session.id, cwd: session.cwd, shell: session.shell, pid: session.pid });
  });

  // 写入输入。命令级高危审批协议：携带整命令（command 字段），命中高危且未 confirmed → 拦截返回
  // requireApproval（不写入），前端人工确认后带 confirmed:true 重发才执行；每条命令审计落盘。
  app.post("/api/terminal/:id/input", async (c) => {
    const session = getTerminalSession(c.req.param("id"));
    if (!session) return c.json({ ok: false, message: "终端会话不存在或已关闭" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const data = typeof body.data === "string" ? body.data : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!data) return c.json({ ok: true });
    if (command && detectDangerousTerminalCommand(command) && body.confirmed !== true) {
      // 高危命令：拦截 + 要求人工确认（安全红线，与 run_command 一致）
      return c.json({ ok: false, requireApproval: true, risk: "high", description: `执行高风险命令：${command}` });
    }
    if (session.exited) return c.json({ ok: false, message: "终端会话已退出" }, 400);
    writeInput(session, data);
    if (command) auditTerminalCommand(session.cwd, command);
    return c.json({ ok: true });
  });

  // PTY 尺寸同步（前端 xterm fit 后调用）
  app.post("/api/terminal/:id/resize", async (c) => {
    const session = getTerminalSession(c.req.param("id"));
    if (!session) return c.json({ ok: false, message: "终端会话不存在" }, 404);
    const body = await c.req.json().catch(() => ({}));
    resizeSession(session, Number(body.cols) || 0, Number(body.rows) || 0);
    return c.json({ ok: true });
  });

  // 输出流（SSE：output / exit / ping；新连接先重放会话缓冲）
  // 注意：hono streamSSE 在 callback resolve 后立即 close 流——回调必须保持 pending
  // 直到连接中断（abort 时释放），否则未 await 的 writeSSE 与 close 竞态丢数据。
  app.get("/api/terminal/:id/stream", (c) => {
    const session = getTerminalSession(c.req.param("id"));
    if (!session) return c.json({ ok: false, message: "终端会话不存在" }, 404);
    return streamSSE(c, async (stream) => {
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
      }, 10000);
      // 连接存活期间保持 callback pending（abort 时释放）
      let releaseHold!: () => void;
      const hold = new Promise<void>((r) => { releaseHold = r; });
      const unsubscribe = subscribeOutput(session, (data) => {
        stream.writeSSE({ event: "output", data: JSON.stringify({ data }) }).catch(() => {});
      });
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
        releaseHold();
      });
      if (session.exited) {
        await stream.writeSSE({ event: "exit", data: JSON.stringify({ code: 0 }) }).catch(() => {});
      }
      await hold;
    });
  });

  // 终止会话（kill 进程树 + 移除）
  app.delete("/api/terminal/:id", (c) => {
    const ok = killTerminalSession(c.req.param("id"));
    return c.json({ ok });
  });

  // 活动会话列表（调试/管理用；含 buffer 长度与订阅者数诊断字段）
  app.get("/api/terminal", (c) => {
    return c.json({
      sessions: listTerminalSessions().map((s) => {
        const live = getTerminalSession(s.id);
        return { ...s, bufferLen: live?.buffer.length ?? 0, listeners: live?.listeners.size ?? 0 };
      }),
    });
  });

  // Agent 任务（SSE）
  app.post("/api/chat", (c) => {
    return streamSSE(c, async (stream) => {
      // SSE 心跳：模型思考/生成期间可能长时间无数据，防止连接被网络层断开（fetch failed）
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
      }, 10000);
      const stopHeartbeat = () => clearInterval(heartbeat);

      const body = await c.req.json().catch(() => ({}));
      const prompt: string = body.prompt || "";
      const modelId: string | undefined = body.modelId;
      const fallbackModelIds: string[] | undefined = Array.isArray(body.fallbackModelIds)
        ? body.fallbackModelIds.map(String)
        : undefined;
      // v2.2 轻量模型选择：按角色指定模型（planner/executor/reviewer）
      const roleModelIds: { planner?: string; executor?: string; reviewer?: string } =
        body.roleModelIds && typeof body.roleModelIds === "object" ? body.roleModelIds : {};
      const maxSteps: number | undefined = typeof body.maxSteps === "number" ? body.maxSteps : undefined;
      // v2 思考级别（4 档 UI，按模型实际级别数自动映射；缺省 2）
      const thinkingLevel: number | undefined =
        typeof body.thinkingLevel === "number" && body.thinkingLevel >= 1 && body.thinkingLevel <= 4
          ? Math.round(body.thinkingLevel)
          : undefined;
      // v2.2 动态步数：模板任务 id（启发式参考）
      const templateId: string | undefined =
        typeof body.templateId === "string" && body.templateId ? body.templateId : undefined;
      // 分层编排（M4）：默认 full（Planner→Executor→Reviewer）；计划默认需用户确认
      const orchestrate: OrchestrateMode =
        body.orchestrate === "off" || body.orchestrate === "plan" || body.orchestrate === "full"
          ? body.orchestrate
          : "full";
      const planApproval: boolean = body.planApproval !== false;
      // 建议模式：模型只出方案不执行（Web 三档选择器的"只出方案"）
      const suggestOnly: boolean = body.suggestOnly === true;

      // 停止支持：客户端断开连接时中止 Agent 循环
      const controller = new AbortController();
      stream.onAbort(() => {
        stopHeartbeat();
        controller.abort();
        // 中断/停止（用户停止/连接断流）：会话标记 stopped（正常收尾由 finally 处理，不覆盖）
        if (sessionId && store.getSession(sessionId)?.status === "running") {
          store.updateStatus(sessionId, "stopped");
        }
      });

      if (!prompt) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "prompt 不能为空" }) });
        return;
      }

      // ── v2.1 会话绑定（持久化落库）──
      const store = getStore();
      let sessionId: string | undefined =
        typeof body.sessionId === "string" && body.sessionId ? body.sessionId : undefined;
      let root: string = body.root || opts.defaultRoot || process.cwd();
      let effectivePrompt = prompt;
      // v2.2 断点恢复：继续会话 = 从事件流重建完整 messages（工具结果直接来自 DB，不重放副作用）
      let initialMessages: ChatMessageLike[] | undefined;
      // v2.3 阶段级精确续跑：从事件流推断续跑起点（已确认计划 → 跳过规划阶段）
      let resumePoint: ReturnType<typeof inferResumePhase> = {};
      if (sessionId) {
        // 继续会话：校验存在 + 消息级重建 + 沿用历史 root/model
        const s = store.getSession(sessionId);
        if (!s) {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ message: `会话不存在: ${sessionId}` }) });
          return;
        }
        if (!body.root && s.root) root = s.root;
        initialMessages = rebuildMessages(store.getEvents(sessionId));
        resumePoint = inferResumePhase(store.getEvents(sessionId));
      } else {
        // 新会话：SSE 首帧回传会话 id（Web 绑定 activeSessionId）
        const title = prompt.slice(0, 40);
        sessionId = store.createSession({ title, root, modelId, mode: suggestOnly ? "ask" : orchestrate === "off" ? "direct" : "orchestrate" });
        await stream.writeSSE({ event: "session", data: JSON.stringify({ type: "session", id: sessionId }) });
      }
      // 用户消息落库（检查点之一：Rewind 锚点）
      store.appendEvent(sessionId, { type: "user-message", text: prompt });

      // 项目根目录校验：路径不存在/不是目录时直接报明确错误（避免 AI 根据工具报错瞎猜路径）
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        store.updateStatus(sessionId, "error");
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: `项目根目录不存在或不是目录: ${root}（请检查输入框里的路径是否正确，使用绝对路径）` }),
        });
        return;
      }

      const config = loadConfig();
      const models = config?.models ?? [];
      if (!models.length) {
        store.updateStatus(sessionId, "error");
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "未配置模型，请先配置 ~/.infu/config.json" }) });
        return;
      }
      const modelCfg =
        (modelId ? models.find((m) => m.id === modelId && m.apiKey) ?? models.find((m) => m.id === modelId) : undefined) ||
        models.find((m) => m.apiKey) ||
        models[0];
      // v2.2 降级链：显式指定优先，否则用模型自身 fallbackModelIds（去重/跳过自身/未知 id）
      const fallbackModels = resolveFallbackModels(config, modelCfg, fallbackModelIds);
      // v2.2 角色路由：各角色独立模型 + 各自降级链（未指定角色 → 默认模型）
      const roleModelConfigs: OrchestratedRunOptions["roleModelConfigs"] = {};
      // v2.3 角色独立思考级别：角色级优先于全局 thinkingLevel
      const roleThinking: Partial<Record<PhaseId, number>> = {};
      for (const phase of ["planner", "executor", "reviewer"] as const) {
        const rm = resolveRoleModel(config, modelCfg, phase, roleModelIds[phase]);
        roleModelConfigs[phase] = {
          modelConfig: toRuntimeModel(config, rm),
          fallbackModelConfigs: resolveFallbackModels(config, rm).map((m) => toRuntimeModel(config, m)),
        };
        const rt = resolveRoleThinking(config, phase);
        if (rt != null) roleThinking[phase] = rt;
      }

      const emit = (e: AgentEvent) => {
        logEvent(e); // 后台日志（窗口 + 文件）
        store.appendEvent(sessionId, e); // 全量落库（tool-result 含完整输出）
        stream.writeSSE({ event: "agent", data: JSON.stringify(e) }).catch(() => {});
      };

      // 审批：推送 approval-required 事件 → 挂 pending → 等待 POST /api/approvals/:id 决策
      // 连接中断（停止）时自动拒绝并释放
      // v2.4 审批档位（config.approvalPolicy.mode）：auto 直接放行不发事件；confirm 全部人工；
      // requireExplicit（联网放行等安全线）任何档位都弹窗人工确认（guard 对内置工具已按档位拦截，此处兜底 MCP/插件直调路径）
      const requestApproval = async (description: string, risk: RiskLevel, requireExplicit?: boolean) => {
        if (shouldAutoApprove(resolveApprovalPolicy(loadConfig()), risk, requireExplicit) === true) return true;
        const id = randomUUID();
        emit({ type: "approval-required", id, description, risk });
        return new Promise<boolean>((resolve) => {
          pendingApprovals.set(id, resolve);
          controller.signal.addEventListener(
            "abort",
            () => {
              if (pendingApprovals.delete(id)) resolve(false);
            },
            { once: true }
          );
        });
      };

      // 计划确认（Web 计划卡片 v2.3）：emit plan 事件 → 挂 pending → 等 POST /api/plan/:id
      // 返回 { plan?, feedback } 或 null（用户取消 = 中止任务）；连接中断（停止）时视为取消
      const confirmPlan = async (planText: string) => {
        const id = randomUUID();
        emit({ type: "plan", id, content: planText });
        return new Promise<{ plan?: string; feedback: string } | null>((resolve) => {
          pendingPlans.set(id, (d) => {
            if (d.cancelled) resolve(null);
            else resolve({ plan: d.plan, feedback: d.feedback ?? "批准执行" });
          });
          controller.signal.addEventListener(
            "abort",
            () => {
              if (pendingPlans.delete(id)) resolve(null);
            },
            { once: true }
          );
        });
      };

      try {
        // v2.3 动态扩展：MCP 服务器 + JS 插件（suggestOnly 不注入任何外部能力；
        // 连接/加载失败的跳过不阻塞任务）。任务结束后统一 close/释放。
        const mcp = suggestOnly ? null : await loadMcpTools(config?.mcpServers, emit);
        const plugin = suggestOnly ? null : await loadPlugins(config?.plugins, emit);
        // skill 发现层：可用技能 name+description 追加到 Executor system（progressive disclosure）
        const skillsPrompt = buildSkillsPrompt(listSkills(config, root));
        // v2.5 子智能体发现层：可用 agent 角色 name+description（delegate_task 委派参考）
        const agentsPrompt = buildAgentsPrompt(listAgents(root));
        try {
          // 阶段级续跑提示（emit 已就绪；跳过规划阶段直接续执行）
          if (resumePoint.startPhase) {
            emit({ type: "text", text: "↻ 阶段级续跑：历史中已有确认过的计划，跳过规划阶段，直接从执行阶段继续。" });
          }
          const modelRun = {
            modelConfig: toRuntimeModel(config, modelCfg),
            fallbackModelConfigs: fallbackModels.map((m) => toRuntimeModel(config, m)),
            roleModelConfigs,
            roleThinking,
            initialMessages,
            thinkingLevel,
            prompt,
            root,
            emit,
            requestApproval,
            abortSignal: controller.signal,
            maxSteps,
          };
          // 建议模式：单 Agent 直跑（不注入工具，模型只出方案）
          const final = suggestOnly
            ? await runAgent({
                ...modelRun,
                system: DEFAULT_SYSTEM_PROMPT,
                tools: TOOLS,
                suggestOnly: true,
              })
            : await runOrchestratedTask({
                ...modelRun,
                orchestrate,
                planApproval,
                confirmPlan,
                templateId,
                // v2.3：MCP 工具 + 插件工具只进 Executor（Planner/Reviewer 架构级只读不暴露）；
                // 插件钩子随 Executor 生效；skill 描述注入 Executor system
                executorTools: [...(mcp?.tools ?? []), ...(plugin?.tools ?? [])],
                hooks: plugin?.hooks,
                skillsPrompt,
                agentsPrompt,
                // 阶段级续跑：跳过已完成的规划阶段（计划沿用上次确认的）
                startPhase: resumePoint.startPhase,
                resumePlanText: resumePoint.planText,
              });
          await stream.writeSSE({ event: "done", data: JSON.stringify({ final: final.text }) });
          store.updateStatus(sessionId, "done");
        } finally {
          if (mcp) await mcp.close();
        }
      } catch (e) {
        store.updateStatus(sessionId, "error");
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: (e as Error).message }) });
      } finally {
        stopHeartbeat();
      }
    });
  });

  // ── 模板任务（M4 小白引导：一键初始化项目 / 修复测试失败等）──
  app.get("/api/templates", (c) => c.json(TASK_TEMPLATES));

  // ── 任务工作树（Cursor /worktree 借鉴：每任务独立 git worktree）──

  // 创建任务工作树（基于当前 HEAD 建独立分支 + 工作树副本）
  app.post("/api/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const root: string = body.root || opts.defaultRoot || process.cwd();
    if (!(await isGitRepo(root))) {
      return c.json({ ok: false, message: "该目录不是 Git 仓库，无法创建工作树；将在当前目录直接执行" });
    }
    const name = `infu-task-${Date.now().toString(36)}`;
    const wtPath = path.join(root, ".infu-worktrees", name);
    try {
      await git(root, ["worktree", "add", wtPath, "-b", name]);
      return c.json({ ok: true, name, path: wtPath, branch: name });
    } catch (e) {
      return c.json({ ok: false, message: `创建工作树失败: ${(e as Error).message}` }, 500);
    }
  });

  // 合并任务分支回主分支并清理工作树
  app.post("/api/worktree/:name/merge", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => ({}));
    const root: string = body.root || opts.defaultRoot || process.cwd();
    const wtPath = path.join(root, ".infu-worktrees", name);
    try {
      // 1) 先把 worktree 里的改动提交（Agent 的改动是未提交状态，直接 merge 会丢失）
      try {
        await git(wtPath, ["add", "-A"]);
        await git(wtPath, ["commit", "-m", `infu-task(${name}): 任务改动`]);
      } catch {
        /* 无改动时提交会失败，忽略 */
      }
      // 2) 合并分支到主分支
      await git(root, ["merge", name, "--no-edit"]);
      // 3) 清理工作树与分支
      await git(root, ["worktree", "remove", "--force", wtPath]);
      await git(root, ["branch", "-D", name]);
      return c.json({ ok: true, message: `已合并分支 ${name} 并清理工作树` });
    } catch (e) {
      return c.json({ ok: false, message: `合并失败（可能有冲突，请手动处理）: ${(e as Error).message}` }, 500);
    }
  });

  // 丢弃任务工作树（不合并，直接清理）
  app.post("/api/worktree/:name/discard", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => ({}));
    const root: string = body.root || opts.defaultRoot || process.cwd();
    const wtPath = path.join(root, ".infu-worktrees", name);
    try {
      await git(root, ["worktree", "remove", "--force", wtPath]);
      await git(root, ["branch", "-D", name]);
      return c.json({ ok: true, message: `已丢弃任务分支 ${name}` });
    } catch (e) {
      return c.json({ ok: false, message: `丢弃失败: ${(e as Error).message}` }, 500);
    }
  });

  // 审批决策入口（Web UI 调用）
  app.post("/api/approvals/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const resolve = pendingApprovals.get(id);
    if (!resolve) return c.json({ ok: false, message: "审批不存在或已过期" });
    pendingApprovals.delete(id);
    resolve(!!body.approved);
    return c.json({ ok: true });
  });

  // 计划确认入口（v2.3 计划卡片：提交 = {plan?, feedback}；取消 = {cancelled: true}）
  app.post("/api/plan/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const resolve = pendingPlans.get(id);
    if (!resolve) return c.json({ ok: false, message: "计划不存在或已过期" });
    pendingPlans.delete(id);
    if (body.cancelled === true) {
      resolve({ cancelled: true });
    } else {
      resolve({
        plan: typeof body.plan === "string" && body.plan.trim() ? body.plan : undefined,
        feedback: typeof body.feedback === "string" && body.feedback.trim() ? body.feedback.trim() : "批准执行",
      });
    }
    return c.json({ ok: true });
  });

  // ── 会话管理（v2.1 持久化：多会话/历史浏览/继续会话/Rewind）──

  // 创建会话（Web 新建 / v1 数据迁移；任务发起请直接 POST /api/chat）
  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const store = getStore();
    const id = store.createSession({
      title: String(body.title || "新会话").slice(0, 200),
      root: String(body.root || opts.defaultRoot || process.cwd()),
      modelId: typeof body.modelId === "string" ? body.modelId : undefined,
      mode: typeof body.mode === "string" ? body.mode : undefined,
    });
    // 手动创建 → 非运行中（避免列表显示 running 残留）
    store.updateStatus(id, "stopped");
    return c.json({ ok: true, id });
  });

  // 批量导入事件（v1 localStorage 数据迁移；校验事件类型与格式）
  app.post("/api/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const store = getStore();
    if (!store.getSession(id)) return c.json({ ok: false, message: "会话不存在" }, 404);
    const events: unknown[] = Array.isArray(body.events) ? body.events : [];
    if (!events.length) return c.json({ ok: false, message: "events 不能为空" }, 400);
    for (const e of events) {
      if (!e || typeof e !== "object" || typeof (e as any).type !== "string") {
        return c.json({ ok: false, message: "事件格式错误" }, 400);
      }
      store.appendEvent(id, e as AgentEvent);
    }
    return c.json({ ok: true, count: events.length });
  });

  // 会话列表（多会话/历史浏览）
  app.get("/api/sessions", (c) => {
    const limit = Math.min(parseInt(String(c.req.query("limit") ?? "50"), 10) || 50, 200);
    return c.json({ sessions: getStore().listSessions(limit) });
  });

  // 会话详情（全量事件流 → Web 端重放历史）
  app.get("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    const store = getStore();
    const session = store.getSession(id);
    if (!session) return c.json({ ok: false, message: "会话不存在" }, 404);
    return c.json({ session, events: store.getEvents(id) });
  });

  // 删除会话（事件流一并删除）
  app.delete("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    const store = getStore();
    if (!store.getSession(id)) return c.json({ ok: false, message: "会话不存在" }, 404);
    store.deleteSession(id);
    return c.json({ ok: true });
  });

  // Rewind：回滚到检查点（seq 及之后的事件全部删除，会话回到"未完成"态）
  app.post("/api/sessions/:id/rewind", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const seq = parseInt(String(body.seq ?? ""), 10);
    if (!Number.isInteger(seq) || seq < 0) return c.json({ ok: false, message: "seq 必须是 >= 0 的整数" }, 400);
    if (!getStore().rewind(id, seq)) return c.json({ ok: false, message: "会话不存在" }, 404);
    return c.json({ ok: true });
  });

  // ── v2.3 MCP 服务器管理（MCP 客户端作为第一个插件类型；工具动态注入 Agent 循环）──

  // 服务器列表（脱敏：env 只回传键名，防密钥泄漏）
  app.get("/api/mcp", (c) => {
    const cfg = readConfigRaw();
    const servers = (cfg.mcpServers ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      command: s.command,
      args: s.args,
      url: s.url,
      enabled: s.enabled !== false,
      envKeys: s.env ? Object.keys(s.env) : [],
      riskOverrides: s.riskOverrides,
    }));
    return c.json({ servers });
  });

  // 新增服务器（stdio：command/args；http：url）
  app.post("/api/mcp", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const id = String(body.id || "").trim();
    const name = String(body.name || "").trim();
    const type = body.type === "http" ? "http" : "stdio";
    if (!id || !name) return c.json({ ok: false, message: "id/name 不能为空" }, 400);
    if ((cfg.mcpServers ?? []).some((x) => x.id === id)) {
      return c.json({ ok: false, message: `MCP 服务器 id "${id}" 已存在` }, 409);
    }
    const s: NonNullable<InfuConfig["mcpServers"]>[number] = { id, name, type };
    if (type === "stdio") {
      if (!body.command) return c.json({ ok: false, message: "stdio 类型需要 command" }, 400);
      s.command = String(body.command);
      if (Array.isArray(body.args)) s.args = body.args.map(String);
    } else {
      if (!body.url) return c.json({ ok: false, message: "http 类型需要 url" }, 400);
      s.url = String(body.url);
    }
    if (body.env && typeof body.env === "object") {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.env)) if (typeof v === "string") env[k] = v;
      if (Object.keys(env).length) s.env = env;
    }
    if (typeof body.enabled === "boolean") s.enabled = body.enabled;
    if (body.riskOverrides && typeof body.riskOverrides === "object") {
      const ro: Record<string, RiskLevel> = {};
      for (const [k, v] of Object.entries(body.riskOverrides)) {
        if (v === "low" || v === "medium" || v === "high") ro[k] = v;
      }
      if (Object.keys(ro).length) s.riskOverrides = ro;
    }
    cfg.mcpServers = [...(cfg.mcpServers ?? []), s];
    saveConfig(cfg);
    return c.json({ ok: true, server: s.id });
  });

  // 更新服务器（enabled 切换/编辑）
  app.put("/api/mcp/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const s = (cfg.mcpServers ?? []).find((x) => x.id === id);
    if (!s) return c.json({ ok: false, message: "MCP 服务器不存在" }, 404);
    if (body.name) s.name = String(body.name);
    if (typeof body.enabled === "boolean") s.enabled = body.enabled;
    if (typeof body.command === "string") s.command = body.command || undefined;
    if (Array.isArray(body.args)) s.args = body.args.map(String);
    if (typeof body.url === "string") s.url = body.url || undefined;
    if (body.env && typeof body.env === "object") {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.env)) if (typeof v === "string") env[k] = v;
      s.env = Object.keys(env).length ? env : undefined;
    }
    if (body.riskOverrides && typeof body.riskOverrides === "object") {
      const ro: Record<string, RiskLevel> = {};
      for (const [k, v] of Object.entries(body.riskOverrides)) {
        if (v === "low" || v === "medium" || v === "high") ro[k] = v;
      }
      s.riskOverrides = Object.keys(ro).length ? ro : undefined;
    }
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // 删除服务器
  app.delete("/api/mcp/:id", (c) => {
    const id = c.req.param("id");
    const cfg = readConfigRaw();
    if (!(cfg.mcpServers ?? []).some((x) => x.id === id)) {
      return c.json({ ok: false, message: "MCP 服务器不存在" }, 404);
    }
    cfg.mcpServers = (cfg.mcpServers ?? []).filter((x) => x.id !== id);
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // 探测：连接服务器拉取工具列表（返回名称/描述/有效风险；15s 超时仿上游模型拉取）
  app.post("/api/mcp/:id/tools", async (c) => {
    const id = c.req.param("id");
    const cfg = readConfigRaw();
    const s = (cfg.mcpServers ?? []).find((x) => x.id === id);
    if (!s) return c.json({ ok: false, message: "MCP 服务器不存在" }, 404);
    let conn: Awaited<ReturnType<typeof import("./mcp/index.js").connectMcp>> | undefined;
    try {
      const { connectMcp, resolveToolRisk } = await import("./mcp/index.js");
      conn = await Promise.race([
        connectMcp(s),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("连接超时（15s）")), 15000)
        ),
      ]);
      const tools = await conn.listTools();
      return c.json({
        ok: true,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          risk: resolveToolRisk(s, t.name),
        })),
      });
    } catch (e) {
      return c.json({ ok: false, message: `连接失败：${(e as Error).message.slice(0, 200)}` }, 502);
    } finally {
      if (conn) {
        try {
          await conn.close();
        } catch {
          /* 忽略 */
        }
      }
    }
  });

  // ── v2.3 批 2 插件管理（JS 模块插件：工具/钩子/技能）──

  // 插件列表
  app.get("/api/plugins", (c) => {
    const cfg = readConfigRaw();
    return c.json({ plugins: cfg.plugins ?? [] });
  });

  // 添加插件
  app.post("/api/plugins", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const id = String(body.id || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const path = String(body.path || "").trim();
    if (!id || !path) return c.json({ ok: false, message: "id/path 不能为空" }, 400);
    if ((cfg.plugins ?? []).some((x) => x.id === id)) {
      return c.json({ ok: false, message: `插件 "${id}" 已存在` }, 409);
    }
    cfg.plugins = [...(cfg.plugins ?? []), { id, path }];
    saveConfig(cfg);
    return c.json({ ok: true, plugin: id });
  });

  // 生成带钩子的插件（v2.4 追加：设置界面「新建钩子」——钩子是插件属性，
  // 生成一个完整的插件模块文件（默认 ~/.infu/plugins/<id>.mjs，可指定 path）并注册；
  // 用户自写代码 = 配置即信任，与 plugin_add 同信任级别）
  app.post("/api/plugins/generate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const id = String(body.id || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!id) return c.json({ ok: false, message: "插件 id 不能为空" }, 400);
    if (!code) return c.json({ ok: false, message: "插件代码不能为空" }, 400);
    if ((cfg.plugins ?? []).some((x) => x.id === id)) {
      return c.json({ ok: false, message: `插件 "${id}" 已存在` }, 409);
    }
    // 默认落盘：~/.infu/plugins/<id>.mjs（用户级）；body.path 可指定绝对路径——
    // 以 .mjs/.js/.ts 结尾视为完整文件路径，否则视为目录
    const explicitPath = typeof body.path === "string" && body.path.trim() ? body.path.trim() : "";
    const file = explicitPath
      ? /\.(mjs|js|ts)$/i.test(explicitPath)
        ? explicitPath
        : join(explicitPath, `${id}.mjs`)
      : join(homedir(), ".infu", "plugins", `${id}.mjs`);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, code, "utf-8");
    } catch (e) {
      return c.json({ ok: false, message: `写入插件文件失败: ${(e as Error).message}` }, 500);
    }
    const r = registerPlugin({ id, path: file });
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, plugin: id, path: file });
  });

  // 更新插件（启停/路径）
  app.put("/api/plugins/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const p = (cfg.plugins ?? []).find((x) => x.id === id);
    if (!p) return c.json({ ok: false, message: "插件不存在" }, 404);
    if (typeof body.path === "string" && body.path.trim()) p.path = body.path.trim();
    if (typeof body.enabled === "boolean") p.enabled = body.enabled;
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // 删除插件
  app.delete("/api/plugins/:id", (c) => {
    const id = c.req.param("id");
    const cfg = readConfigRaw();
    if (!(cfg.plugins ?? []).some((x) => x.id === id)) {
      return c.json({ ok: false, message: "插件不存在" }, 404);
    }
    cfg.plugins = (cfg.plugins ?? []).filter((x) => x.id !== id);
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // 探测：动态 import 加载插件，报告工具/钩子数（失败返回结构化错误）
  app.post("/api/plugins/:id/probe", async (c) => {
    const id = c.req.param("id");
    const cfg = readConfigRaw();
    const p = (cfg.plugins ?? []).find((x) => x.id === id);
    if (!p) return c.json({ ok: false, message: "插件不存在" }, 404);
    try {
      const { loadPlugins } = await import("./plugin/index.js");
      const r = await loadPlugins([p], () => {});
      if (r.failures.length) {
        return c.json({ ok: false, message: `加载失败：${r.failures[0].message.slice(0, 200)}` }, 502);
      }
      return c.json({
        ok: true,
        tools: r.tools.map((t) => ({ name: t.name, risk: t.risk })),
        hooks: { preToolUse: r.hooks.preToolUse.length, postToolUse: r.hooks.postToolUse.length },
      });
    } catch (e) {
      return c.json({ ok: false, message: `加载失败：${(e as Error).message.slice(0, 200)}` }, 502);
    }
  });

  // ── v2.3 批 2 skill 管理（SKILL.md 社区标准；列表来自用户级/项目级/显式引用）──

  // 可用技能列表（含显式引用与来源层级）
  app.get("/api/skills", (c) => {
    const cfg = readConfigRaw();
    const root = opts.defaultRoot || process.cwd();
    const skills = listSkills(cfg, root).map((s) => ({
      name: s.name,
      description: s.description.slice(0, 200),
      path: s.path,
      level: s.level,
    }));
    return c.json({ skills });
  });

  // 添加显式引用（path 缺省 = 按 name 查找；校验 SKILL.md 合法性）
  app.post("/api/skills", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "name 不能为空" }, 400);
    if ((cfg.skills ?? []).some((s) => s.name === name)) {
      return c.json({ ok: false, message: `技能 "${name}" 已在显式引用中` }, 409);
    }
    const { readSkillMeta } = await import("./plugin/skills.js");
    const pathArg = typeof body.path === "string" && body.path.trim() ? body.path.trim() : undefined;
    if (pathArg) {
      const meta = readSkillMeta(path.resolve(pathArg), "config");
      if (!meta) {
        return c.json({ ok: false, message: `路径 "${pathArg}" 下未找到合法 SKILL.md` }, 400);
      }
    } else if (!listSkills(cfg, opts.defaultRoot || process.cwd()).some((s) => s.name === name)) {
      return c.json({ ok: false, message: `未找到技能 "${name}"（需 --path 或放到 skills 目录）` }, 404);
    }
    cfg.skills = [...(cfg.skills ?? []), pathArg ? { name, path: pathArg } : { name }];
    saveConfig(cfg);
    return c.json({ ok: true, skill: name });
  });

  // 移除显式引用（不删文件）
  app.delete("/api/skills/:name", (c) => {
    const name = c.req.param("name");
    const cfg = readConfigRaw();
    if (!(cfg.skills ?? []).some((s) => s.name === name)) {
      return c.json({ ok: false, message: "技能不在显式引用中" }, 404);
    }
    cfg.skills = (cfg.skills ?? []).filter((s) => s.name !== name);
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // ── v2.5 子智能体管理（agent 文件化定义：内置 > ~/.infu/agents > 项目 .infu/agents；文件系统即注册）──

  // 列表（含完整定义：工具/权限/沙箱/模型/推理强度/正文，供设置面板编辑回填）
  app.get("/api/agents", (c) => {
    const root = opts.defaultRoot || process.cwd();
    const agents = listAgents(root).map((a) => ({
      name: a.name,
      description: a.description.slice(0, 200),
      tools: a.tools,
      model: a.model,
      maxSteps: a.maxSteps,
      thinkingLevel: a.thinkingLevel,
      permission: a.permission,
      sandbox: a.sandbox,
      body: a.body,
      path: a.path,
      level: a.level,
    }));
    return c.json({ agents });
  });

  // 保存（创建/更新）：level = 用户级 ~/.infu/agents 或项目级 <root>/.infu/agents；内容 = 完整 markdown
  app.post("/api/agents", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const level = body.level === "user" ? "user" : "project";
    const content = String(body.content || "");
    if (!name || !content.trim()) return c.json({ ok: false, message: "name 与 content 不能为空" }, 400);
    try {
      const path = writeAgentFile(name, level, content, opts.defaultRoot || process.cwd());
      return c.json({ ok: true, name, level, path });
    } catch (e) {
      return c.json({ ok: false, message: (e as Error).message }, 400);
    }
  });

  // 删除（仅用户级/项目级文件；内置 agent 不可删）
  app.delete("/api/agents/:name", (c) => {
    const name = c.req.param("name");
    const root = opts.defaultRoot || process.cwd();
    const removed = deleteAgentFile(name, root, "user") || deleteAgentFile(name, root, "project");
    if (!removed) {
      return c.json({ ok: false, message: `未找到可删除的 agent 文件（${name}；内置 agent 不可删除）` }, 404);
    }
    return c.json({ ok: true });
  });

  app.get("/api/health", (c) => c.json({ ok: true, name: "infu-agent", tools: Object.keys(TOOLS).length }));

  return app;
}

/** 启动时检查模型配置健康度，给出明确引导 */
function checkConfigHealth() {
  const cfg = loadConfig();
  const models = cfg?.models ?? [];
  if (!models.length) {
    console.log(`[infu-agent] ⚠️ 尚未配置任何模型！`);
    console.log(`[infu-agent]    配置方法：运行 npm run config（交互式向导）`);
    return;
  }
  // v2：key/端点经供应商凭据解析（v1 遗留模型兼容内嵌字段）
  const keyOf = (m: ModelConfig) =>
    cfg?.providers?.find((p) => p.id === m.providerId)?.apiKey ||
    m.apiKey ||
    process.env[`INFU_${(m.provider ?? "custom").toUpperCase()}_API_KEY`];
  const kindOf = (m: ModelConfig) =>
    cfg?.providers?.find((p) => p.id === m.providerId)?.kind ?? m.provider ?? "custom";
  const baseOf = (m: ModelConfig) =>
    cfg?.providers?.find((p) => p.id === m.providerId)?.baseURL ?? m.baseURL;
  const withKey = models.filter((m) => keyOf(m));
  const withBaseURL = models.filter((m) => baseOf(m) || kindOf(m) !== "custom");
  const usable = withKey.filter((m) => baseOf(m) || kindOf(m) !== "custom");
  if (usable.length) {
    console.log(`[infu-agent] ✅ 模型就绪：${usable.map((m) => `${m.name}（${kindOf(m)}/${m.model}）`).join("、")}`);
  } else {
    console.log(`[infu-agent] ⚠️ 已配置 ${models.length} 个模型，但均未设置 API Key！`);
    console.log(`[infu-agent]    配置方法：模型管理 → 供应商 → 编辑 API Key`);
    console.log(`[infu-agent]    或编辑 ${CONFIG_PATH} 填入 apiKey（或用环境变量 INFU_<供应商>_API_KEY）`);
  }
  if (!withBaseURL.length) {
    console.log(`[infu-agent] ⚠️ 自定义端点模型缺少 baseURL`);
  }
}

/** 启动服务（端口被占用时自动递增重试） */
export function startServer(opts: ServerOptions = {}) {
  const host = opts.host ?? "127.0.0.1";
  const basePort = opts.port ?? 4317;
  const app = createApp(opts);

  const tryListen = (port: number, attemptsLeft: number) => {
    const server = createServer((incoming, outgoing) => void handleNodeRequest(app, incoming, outgoing));
    server.listen(port, host, () => {
      const address = server.address();
      const listeningPort = typeof address === "object" && address ? address.port : port;
      console.log(`[infu-agent] 服务已启动: http://${host}:${listeningPort}`);
      console.log(`[infu-agent] 工具数: ${Object.keys(TOOLS).length}`);
      checkConfigHealth();
      console.log(`[infu-agent] Ctrl+C 停止服务`);
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
        console.log(`[infu-agent] 端口 ${port} 被占用，自动切换到 ${port + 1}`);
        tryListen(port + 1, attemptsLeft - 1);
      } else {
        console.error(`[infu-agent] 启动失败: ${err.message}`);
        process.exit(1);
      }
    });
  };
  tryListen(basePort, 5);
  // v2.4 批 2：服务退出统一清理终端子进程（防残留 PTY；与 MCP 连接清理同模式）
  process.on("exit", () => closeAllTerminalSessions());
}

// 直接运行时入口：tsx src/server.ts / node dist/server.js
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer();
}
