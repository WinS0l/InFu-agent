/**
 * InFu Agent 服务层 — Hono HTTP + SSE 流式
 *
 * 端点：
 *   GET  /api/models         模型列表（脱敏）
 *   POST /api/chat           发起 Agent 任务（SSE 流式返回 AgentEvent；支持分层编排）
 *   GET  /api/templates      模板任务列表（M4 小白引导）
 *   GET  /api/health         健康检查
 */

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { ModelConfig, AgentEvent, RiskLevel, InfuConfig, PhaseId, ProviderConfig, AttachmentMeta } from "@infu/shared";
import { loadConfig, saveConfig, resolveFallbackModels, resolveRoleModel, resolveRoleThinking, toRuntimeModel, resolveBaseURL, configPath } from "./providers/registry.js";
import { resolveDataDir, defaultDataDir, migrateDataDir } from "./data-dir.js";
import { autoNameSession } from "./session-naming.js";
import { parseInfuConfig, approvalPolicySchema, sandboxConfigSchema, generalConfigSchema, appearanceConfigSchema, browserConfigSchema, memoryConfigSchema } from "@infu/shared";
import { TOOLS, clearObservedFiles } from "./tools/index.js";
import { clearRecovery, cleanupRecovery } from "./tools/recovery.js";
import { clearApprovalMemory, clearSessionBypass, setSessionBypass, isSessionBypassed } from "./approval/cache.js";
import { setEgressAllow, clearEgressAllow, isEgressAllowed, egressAllowRemaining } from "./egress-allow.js";
import { isPathInside } from "./tools/util.js";
import { runOrchestratedTask, type OrchestratedRunOptions } from "./agent/orchestrator.js";
import { inferResumePhase } from "./agent/resume.js";
import { loadMcpTools } from "./mcp/index.js";
import { loadPlugins } from "./plugin/index.js";
import { listBuiltinPlugins, isBuiltinPlugin } from "./plugin/marketplace.js";
import { registerPlugin } from "./plugin/register.js";
import { listSkills, buildSkillsPrompt, clearPluginSkillDirs } from "./plugin/skills.js";
import { clearTodos } from "./tools/task-tools.js";
import { listTopics as _listTopics, readMemory as _readMemory, globalMemoryDir as _globalMemoryDir, projectMemoryDir as _projectMemoryDir } from "./memory/store.js";
import { findInstructionFile as _findInstructionFile } from "./memory/infu.js";
import { buildInfuPrompt, buildMemoryPrompt, findInstructionFile, parseScopeRules } from "./memory/index.js";
import { listProjects, createProject, removeProject, resolveProjectByName, findProjectByRoot } from "./projects.js";
import { listAgents, buildAgentsPrompt, writeAgentFile, deleteAgentFile } from "./agent/agents.js";
import { abortBackgroundAgentsByDepth, SUBAGENT_FORBIDDEN_TOOLS } from "./agent/subagent.js";
import { killJob } from "./tools/jobs.js";
import { closeShellSession } from "./tools/persistent-shell.js";
import { TASK_TEMPLATES } from "./templates.js";
import { getStore, resetStore } from "./db/store.js";
import { rebuildMessages } from "./db/rebuild.js";
import type { ChatMessageLike } from "./providers/chat.js";
import { resolveApprovalPolicy, shouldAutoApprove } from "./approval/policy.js";
import { dockerAvailable, maybeRotateLog, isProtectedPath, commandLogPath } from "./sandbox/index.js";
import { validateHttpMcpUrl } from "./mcp/client.js";
import { winRestrictedAvailable } from "./sandbox/win-restricted.js";
import {
  createTerminalSession, getTerminalSession, subscribeOutput, writeInput, resizeSession,
  killTerminalSession, closeAllTerminalSessions, listTerminalSessions,
} from "./terminal/session.js";
import { detectDangerousTerminalCommand, auditTerminalCommand } from "./terminal/policy.js";

const execFileAsync = promisify(execFile);

const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 32 * 1024 * 1024;

/** Each new user task starts with a fresh visual evidence stream. Browser tabs and profile data stay intact. */
function clearTaskVisualArtifacts(root: string): void {
  for (const dir of [join(root, ".infu", "screenshots"), join(root, ".infu", "browser")]) {
    try {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (/\.png$/i.test(name)) fs.rmSync(join(dir, name), { force: true });
      }
    } catch {
      /* Visual evidence cleanup never blocks task startup. */
    }
  }
}

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

/** 读取供写端点修改的配置。损坏文件必须拒绝覆盖，避免一次普通 UI 保存抹掉凭据。 */
function readConfigRaw(): InfuConfig {
  const CONFIG_PATH = configPath();
  if (!existsSync(CONFIG_PATH)) return { models: [] };
  const config = loadConfig();
  if (config) return config;
  throw new Error("配置文件损坏，已备份原文件；请修复或恢复 config.json 后再保存设置");
}

// ── 后台运行日志（服务窗口实时打印 + 落盘 <dataDir>/logs/agent.log）──
function logDir(): string {
  return join(resolveDataDir(), "logs");
}
function logFile(): string {
  return join(logDir(), "agent.log");
}
function ensureLogDir() {
  try { mkdirSync(logDir(), { recursive: true }); } catch { /* 忽略 */ }
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
    // v3.5 数据生命周期：日志轮转（>5MB 滚动保留 3 份）——此前 agent.log 无限增长
    maybeRotateLog(logFile());
    appendFileSync(logFile(), line + "\n", "utf-8");
  } catch { /* 日志失败不影响主流程 */ }
}

export interface ServerOptions {
  port?: number;
  host?: string;
  /** 默认项目根目录（无 root 时使用） */
  defaultRoot?: string;
  /** 静态托管目录（桌面端传 web dist：同端口托管 → 前端相对路径 fetch 零改动；缺省不托管，Web/CLI 模式不变） */
  staticDir?: string;
  /** 监听成功回调（桌面端拿实际端口加载主窗口；端口冲突自动递增后回调真实端口） */
  onListening?: (port: number, localToken: string) => void;
  /**
   * v3.5 事件钩子（桌面端任务完成通知/防休眠用）：Agent 会话每个事件（含 done/error）
   * 都回调一次（已落库之后）；sessionId 为当前会话。桌面端据此发系统通知 / 释放防休眠。
   */
  onEvent?: (sessionId: string, event: import("@infu/shared").AgentEvent) => void;
  /** Internal only: share the generated local API bearer between createApp and startServer. */
  localToken?: string;
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

export function createApp(opts: ServerOptions = {}) {
  const app = new Hono();
  // Every local API request needs a per-process bearer. Static mode receives it through
  // index.html; Vite/desktop development receives it through the existing launch query.
  const localToken = opts.localToken ?? process.env.INFU_LOCAL_TOKEN ?? randomUUID().replace(/-/g, "");
  const authorizedRoot = (raw: string): string | null => {
    const root = raw.trim();
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
    const abs = path.resolve(root);
    if (isProtectedPath(abs)) return null;
    const equivalent = (a: string, b: string) => isPathInside(a, b) && isPathInside(b, a);
    const isDefault = (!!opts.defaultRoot && equivalent(path.resolve(opts.defaultRoot), abs)) || equivalent(process.cwd(), abs);
    const registered = listProjects().some((p) => equivalent(p.root, abs));
    const sessionOwned = getStore().listSessions(1000).some((s) => !!s.root && equivalent(s.root, abs));
    return isDefault || registered || sessionOwned ? abs : null;
  };
  // v3.0 桌面端：dev 模式前端（vite 5199）与后端（agent 端口）跨域 → 放开 CORS。
  // 安全边界（v3.0 审计修复）：仅放行本机来源（localhost/127.0.0.1/[::1] 任意端口），
  // 其余 Origin 一律 403——防止任意网页 fetch 本机 API 操纵 Agent（CSRF/远程执行）。
  const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const ALLOWED_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin) {
      if (!ALLOWED_ORIGIN.test(origin)) {
        return c.json({ ok: false, message: "跨域来源不被允许" }, 403);
      }
      c.header("Access-Control-Allow-Origin", origin);
    }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, X-InFu-Token");
      return c.body(null, 204);
    }
    // Host 校验：防 DNS rebinding（本机服务只接受本机主机名）
    const host = c.req.header("host") ?? "";
    if (host && !ALLOWED_HOST.test(host)) {
      return c.json({ ok: false, message: "非法 Host" }, 403);
    }
    await next();
  });
  app.use("/api/*", async (c, next) => {
      // v3.4 审计修复：接受 ?token= query（img 等浏览器原生资源加载无法带 header——
      // 截图预览此前在生产模式 401 全挂；token 为本机随机、随进程重建，query 暴露面可控）
      if (c.req.header("x-infu-token") !== localToken && c.req.query("token") !== localToken) {
        return c.json({ ok: false, message: "未授权：缺少本地令牌" }, 401);
      }
      await next();
  });
  // v3.5 审计修复（H4）：挂起队列条目带 sessionId——任务结束只清**本会话**的挂起项
  // （原实现清全部：会话 B 结束会强杀会话 A 用户正在看的审批/提问/计划卡片）
  const pendingApprovals = new Map<string, { sessionId: string; resolve: (approved: boolean) => void }>();
  // 计划确认挂起队列（M4 计划卡片：POST /api/plan/:id 决策）
  const pendingPlans = new Map<string, { sessionId: string; resolve: (d: { plan?: string; feedback?: string; cancelled?: boolean }) => void }>();
/** v2.6 收尾：Agent 执行中提问（ask_user 工具）挂起队列——emit ask-user 事件 → 等 POST /api/ask/:id 回答 */
const pendingQuestions = new Map<string, { sessionId: string; resolve: (answer: string | null) => void }>();

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
    return c.json({ models, configPath: configPath() });
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
      memory: cfg?.memory ?? {},
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
    const ALLOWED = ["approvalPolicy", "sandbox", "general", "appearance", "browser", "memory", "defaultModelId"] as const;
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
        : key === "browser" ? browserConfigSchema
        : key === "memory" ? memoryConfigSchema
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
    // v3.0 批 12：autoLaunch 变化 → 通知桌面主进程（app.setLoginItemSettings；Web 版无桥忽略）
    if (typeof clean.general?.autoLaunch === "boolean") {
      const setAuto = (globalThis as Record<string, unknown>).__infuSetAutoLaunch as
        | ((on: boolean) => void)
        | undefined;
      try { setAuto?.(clean.general.autoLaunch); } catch { /* 忽略 */ }
    }
    return c.json({ ok: true });
  });

  // ── v3.5 数据目录：根目录可选、内部结构固定；迁移 = 复制 + redirect 指针。──

  // 读取当前数据目录（Web 设置「数据与统计」展示用）
  app.get("/api/data-dir", (c) => {
    return c.json({
      ok: true,
      dir: resolveDataDir(),
      default: defaultDataDir(),
      redirected: resolveDataDir() !== defaultDataDir(),
    });
  });

  // 迁移数据目录：body {path} → 校验（绝对路径/非当前/非主目录/非盘根/非嵌套/空目标）→ 整体复制
  // → 写 ~/.infu-redirect.json 指针 → 进程内缓存失效即刻生效；旧目录保留为备份不删除
  app.post("/api/data-dir", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const target = typeof body?.path === "string" ? body.path.trim() : "";
    if (!target) return c.json({ ok: false, message: "请提供目标路径（path）" }, 400);
    const result = migrateDataDir(target);
    // v3.5：迁移成功 → 重连数据库（旧连接指向旧目录，不重连会继续写旧库）
    if (result.ok) resetStore();
    return c.json(result, result.ok ? 200 : 400);
  });

  // ── v5.0 命令审计查询（设置「数据与统计 → 命令审计」；commands.log 尾段解析展示）──
  // commands.log 行格式：[ISO] OK|ERR | cwd=<dir> | <command> | <detail> [ | sandbox=<tag>]
  app.get("/api/audit", (c) => {
    const limit = Math.min(parseInt(String(c.req.query("limit") ?? "100"), 10) || 100, 500);
    const q = String(c.req.query("q") ?? "").trim().toLowerCase();
    const onlyErr = c.req.query("err") === "1";
    const lines: Array<{ ts: string; ok: boolean; cwd: string; command: string; detail: string; sandbox: string }> = [];
    try {
      const file = commandLogPath();
      if (!existsSync(file)) return c.json({ ok: true, entries: [], truncated: false });
      // 只读尾段（最多 1MB——日志 5MB×3 轮转，尾部是最近内容）
      const st = statSync(file);
      const offset = Math.max(0, st.size - 1024 * 1024);
      const fd = fs.openSync(file, "r");
      let buf: Buffer;
      try {
        const len = st.size - offset;
        buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
      } finally {
        fs.closeSync(fd);
      }
      const text = buf.toString("utf-8");
      for (const line of text.split(/\r?\n/).reverse()) {
        const m = /^\[(.*?)\] (OK|ERR) \| cwd=(.*?) \| (.*?) \| (.*?)( \| sandbox=(.*))?$/.exec(line);
        if (!m) continue;
        const entry = {
          ts: m[1],
          ok: m[2] === "OK",
          cwd: m[3],
          command: m[4],
          detail: m[5],
          sandbox: m[7] ?? "",
        };
        if (onlyErr && entry.ok) continue;
        if (q && !entry.command.toLowerCase().includes(q) && !entry.detail.toLowerCase().includes(q)) continue;
        lines.push(entry);
        if (lines.length >= limit) break;
      }
    } catch { /* 读取失败返回空 */ }
    return c.json({ ok: true, entries: lines, truncated: lines.length >= limit });
  });

  // ── v5.0（C4）数据一键备份：一致性快照到 <数据目录>/backups/infu-backup-<ts>/ ──
  // 会话库走 VACUUM INTO（WAL 一致性快照），配置/记忆/技能/代理/插件/定时任务直接复制
  app.get("/api/backup", (c) => {
    const dataDir = resolveDataDir();
    const backupsDir = join(dataDir, "backups");
    try {
      mkdirSync(backupsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const target = join(backupsDir, `infu-backup-${ts}`);
      mkdirSync(target, { recursive: true });
      const copyIfExists = (name: string) => {
        const src = join(dataDir, name);
        if (existsSync(src)) fs.cpSync(src, join(target, name), { recursive: true });
      };
      for (const name of ["config.json", "projects.json", "schedules.json", "memory", "skills", "agents", "plugins", "attachments"]) {
        copyIfExists(name);
      }
      getStore().backupTo(join(target, "infu.db"));
      // 备份大小统计（递归）
      const walkSize = (d: string): number =>
        readdirSync(d, { withFileTypes: true }).reduce(
          (n, e) => n + (e.isDirectory() ? walkSize(join(d, e.name)) : statSync(join(d, e.name)).size),
          0
        );
      const size = walkSize(target);
      return c.json({ ok: true, path: target, size, ts });
    } catch (e) {
      return c.json({ ok: false, message: `备份失败：${(e as Error).message}` }, 500);
    }
  });

  // ── v2.10 批 7 附件文本提取（docx 零依赖：zip 条目 + XML 去标签）──

  /** 极简 zip 读取（docx 文本提取用）：返回指定条目解压后的内容 */
  function readZipEntry(buf: Buffer, target: string): Buffer | null {
    try {
      const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (eocd < 0) return null;
      const cdOffset = buf.readUInt32LE(eocd + 16);
      const cdCount = buf.readUInt16LE(eocd + 10);
      let p = cdOffset;
      for (let i = 0; i < cdCount; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break;
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const compMethod = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf-8");
        if (name === target) {
          const lNameLen = buf.readUInt16LE(localOffset + 26);
          const lExtraLen = buf.readUInt16LE(localOffset + 28);
          const data = buf.subarray(localOffset + 30 + lNameLen + lExtraLen, localOffset + 30 + lNameLen + lExtraLen + compSize);
          if (compMethod === 0) return data;
          if (compMethod === 8) return inflateRawSync(data);
          return null;
        }
        p += 46 + nameLen + extraLen + commentLen;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** docx → 纯文本（zip 读 word/document.xml，段落转行、去 XML 标签） */
  function extractDocxText(buf: Buffer): string | null {
    try {
      const xml = readZipEntry(buf, "word/document.xml");
      if (!xml) return null;
      const s = xml.toString("utf-8");
      const text = s
        .replace(/<w:tab[^>]*\/>/g, "\t")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return text && text.length > 20 ? text.slice(0, 200000) : null;
    } catch {
      return null;
    }
  }

  // ── v2.9 代码界面（项目代码浏览器：文件树 + 内容预览）──

  /** 文件树：git 仓库 = 已跟踪 + 未跟踪 + 改动统计；非 git = 递归扫描（跳过大目录） */
  app.get("/api/fs/tree", async (c) => {
    const root = authorizedRoot(String(c.req.query("root") ?? ""));
    if (!root) {
      return c.json({ ok: false, message: "root 无效" }, 400);
    }
    type F = { path: string; added: number; removed: number; untracked: boolean };
    const files: F[] = [];
    if (await isGitRepo(root)) {
      const tracked = await gitQuiet(root, ["ls-files"]);
      const stats = new Map<string, { added: number; removed: number }>();
      const numstat = await gitQuiet(root, ["diff", "--numstat", "HEAD"]);
      for (const line of numstat.split("\n")) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
        if (m && m[3] !== "-") stats.set(m[3], { added: m[1] === "-" ? 0 : +m[1], removed: m[2] === "-" ? 0 : +m[2] });
      }
      for (const p of tracked.split("\n").map((s) => s.trim()).filter(Boolean)) {
        const s = stats.get(p);
        files.push({ path: p, added: s?.added ?? 0, removed: s?.removed ?? 0, untracked: false });
      }
      const untracked = await gitQuiet(root, ["ls-files", "--others", "--exclude-standard"]);
      for (const p of untracked.split("\n").map((s) => s.trim()).filter(Boolean)) {
        files.push({ path: p, added: 0, removed: 0, untracked: true });
      }
    } else {
      // 非 git 仓库：递归扫描（跳过常见大目录/生成物）
      const SKIP = new Set(["node_modules", ".git", ".infu", "dist", "build", ".next", "coverage", "target"]);
      const walk = (dir: string, rel: string) => {
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }
        for (const e of entries) {
          if (e.isDirectory()) {
            if (!SKIP.has(e.name)) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
          } else if (e.isFile()) {
            files.push({ path: rel ? `${rel}/${e.name}` : e.name, added: 0, removed: 0, untracked: false });
          }
        }
      };
      walk(root, "");
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return c.json({ ok: true, files });
  });

  /** 文件内容（文本；超大/二进制提示；限 300KB 预览） */
  app.get("/api/fs/file", async (c) => {
    const root = authorizedRoot(String(c.req.query("root") ?? ""));
    const rel = String(c.req.query("path") ?? "");
    const abs = root ? path.resolve(root, rel) : "";
    if (!root || !isPathInside(root, abs) || isProtectedPath(abs)) {
      return c.json({ ok: false, message: "路径越界" }, 400);
    }
    try {
      if (!fs.statSync(abs).isFile()) return c.json({ ok: false, message: "不是文件" }, 400);
      const size = fs.statSync(abs).size;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) return c.json({ ok: true, content: "", binary: true, size });
      const MAX = 300 * 1024;
      const truncated = size > MAX;
      const content = buf.subarray(0, MAX).toString("utf-8");
      return c.json({ ok: true, content, binary: false, size, truncated });
    } catch {
      return c.json({ ok: false, message: "读取失败" }, 400);
    }
  });

  // ── v2.9 审查（审查式：文件列表 +N/-M → 点击查看行级 diff 着色）──

  /** git 命令静默执行（失败返回空；审查只读） */
  async function gitQuiet(root: string, args: string[]): Promise<string> {
    try {
      return await git(root, args);
    } catch {
      return "";
    }
  }

  // 审查文件列表：git diff --numstat（改动文件 + 增删行数）+ 未跟踪新文件（全新增）
  app.get("/api/review/files", async (c) => {
    const root = authorizedRoot(String(c.req.query("root") ?? ""));
    if (!root) {
      return c.json({ ok: false, message: "root 无效" }, 400);
    }
    if (!(await isGitRepo(root))) return c.json({ ok: true, files: [], git: false }); // 非 git 仓库无审查（v3.3 补 21：git 标志供前端提示）
    const files: Array<{ path: string; added: number; removed: number }> = [];
    const numstat = await gitQuiet(root, ["diff", "--numstat", "HEAD"]);
    for (const line of numstat.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (m && m[3] !== "-") {
        files.push({ path: m[3], added: m[1] === "-" ? 0 : +m[1], removed: m[2] === "-" ? 0 : +m[2] });
      }
    }
    // 未跟踪文件（新文件 → 全新增行）
    const untracked = await gitQuiet(root, ["ls-files", "--others", "--exclude-standard"]);
    for (const p of untracked.split("\n").map((s) => s.trim()).filter(Boolean)) {
      const abs = path.resolve(root, p);
      if (!isPathInside(root, abs)) continue;
      let added = 0;
      try {
        if (fs.statSync(abs).isFile()) added = fs.readFileSync(abs, "utf-8").split("\n").length - 1;
      } catch { /* 忽略读取失败 */ }
      if (added < 0) added = 0;
      files.push({ path: p, added, removed: 0 });
    }
    return c.json({ ok: true, files, git: true });
  });

  // 单文件 diff（unified 文本；前端行级着色）；未跟踪文件 = 全新增行
  app.get("/api/review/file", async (c) => {
    const root = authorizedRoot(String(c.req.query("root") ?? ""));
    const rel = String(c.req.query("path") ?? "");
    const abs = root ? path.resolve(root, rel) : "";
    if (!root || !isPathInside(root, abs) || isProtectedPath(abs)) {
      return c.json({ ok: false, message: "路径越界" }, 400);
    }
    // 未跟踪（新文件）
    const tracked = await gitQuiet(root, ["ls-files", "--error-unmatch", "--", rel]);
    let diff = "";
    if (!tracked) {
      try {
        const content = fs.readFileSync(abs, "utf-8");
        diff = content.split("\n").map((l) => `+${l}`).join("\n");
      } catch { /* 空 diff */ }
    } else {
      diff = await gitQuiet(root, ["diff", "HEAD", "--", rel]);
    }
    return c.json({ ok: true, diff });
  });

  // ── v2.7 浏览器状态（browser-use 插件：chromium 探测 + 插件状态）──
  app.get("/api/browser/status", async (c) => {
    const { resolveChromiumPath } = await import("./plugin/browser/runtime.js");
    const { isBuiltinPlugin } = await import("./plugin/marketplace.js");
    const cfg = readConfigRaw();
    const chromiumPath = resolveChromiumPath();
    // browser-use 是否被禁用（config.plugins[] 里 enabled:false 标记）
    const disabled = (cfg.plugins ?? []).some((p) => p.id === "browser-use" && p.enabled === false);
    return c.json({
      available: !!chromiumPath,
      chromiumPath,
      headless: cfg.browser?.headless !== false,
      executablePath: cfg.browser?.executablePath ?? "",
      pluginEnabled: isBuiltinPlugin("browser-use") && !disabled,
    });
  });

  // 清除浏览器数据（cache=保留 Cookie 与站点数据；all=全部清除，不可撤销）
  app.post("/api/browser/clear", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const scope = body.scope === "all" ? "all" : "cache";
    const { clearBrowserData } = await import("./plugin/browser/runtime.js");
    const msg = await clearBrowserData(scope);
    return c.json({ ok: true, scope, message: msg });
  });

  app.get("/api/browser/screenshots/file", (c) => {
    const root = authorizedRoot(String(c.req.query("root") ?? ""));
    const name = String(c.req.query("name") ?? "");
    const dir = root ? join(root, ".infu", "browser") : "";
    const file = dir ? join(dir, name) : "";
    if (!root || !name || !isPathInside(dir, file) || !existsSync(file) || !/\.png$/i.test(name)) return c.notFound();
    try { return c.body(readFileSync(file), 200, { "content-type": "image/png" }); } catch { return c.notFound(); }
  });

  // ── v3.0 computer-use：截图目录列表 + 文件（ComputerUsePane 实时扫描）──
  app.get("/api/screenshots", (c) => {
    const root = authorizedRoot(String(c.req.query("root") ?? ""));
    if (!root) return c.json([]);
    const dir = join(root, ".infu", "screenshots");
    if (!existsSync(dir)) return c.json([]);
    try {
      return c.json(readdirSync(dir).filter((f) => f.endsWith(".png")).sort().reverse());
    } catch {
      return c.json([]);
    }
  });
  app.get("/api/screenshots/file", (c) => {
    const root = authorizedRoot(String(c.req.query("root") ?? ""));
    const name = String(c.req.query("name") ?? "");
    const dir = root ? join(root, ".infu", "screenshots") : "";
    const file = dir ? join(dir, name) : "";
    if (!root || !name || !isPathInside(dir, file) || !existsSync(file)) return c.notFound();
    try {
      return c.body(readFileSync(file), 200, { "content-type": "image/png" });
    } catch {
      return c.notFound();
    }
  });

  // ── v3.0 批 11 定时任务 CRUD（Web UI；无人值守审批语义见 schedule.ts 注释）──
  app.get("/api/schedules", (c) => {
    const { listSchedules } = _require("./schedule.js");
    return c.json(listSchedules());
  });
  app.post("/api/schedules", async (c) => {
    const { addSchedule } = _require("./schedule.js");
    const body = await c.req.json().catch(() => ({}));
    const cron = String(body.cron ?? "");
    const prompt = String(body.prompt ?? "");
    const root = String(body.root ?? opts.defaultRoot ?? process.cwd());
    if (!cron.trim() || !prompt.trim()) return c.json({ ok: false, message: "cron 与任务描述必填" });
    const safeRoot = authorizedRoot(root);
    if (!safeRoot) return c.json({ ok: false, message: "root 未授权或位于受保护区域" }, 403);
    const r = addSchedule(cron.trim(), prompt.trim(), safeRoot);
    return c.json(r);
  });
  app.patch("/api/schedules/:id", async (c) => {
    const { setScheduleEnabled } = _require("./schedule.js");
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== "boolean") return c.json({ ok: false, message: "enabled 必填" });
    return c.json(setScheduleEnabled(c.req.param("id"), body.enabled));
  });
  app.delete("/api/schedules/:id", (c) => {
    const { removeSchedule } = _require("./schedule.js");
    return c.json(removeSchedule(c.req.param("id")));
  });

  // ── v2.7 记忆查看（四层记忆：指令 INFU.md / 全局 / 项目 / 历史）──
  app.get("/api/memory", (c) => {
    // v3.3 补 25：接受前端传的当前项目 root（原固定 defaultRoot/启动目录——
    // 项目记忆在 E:\InFu(test) 而界面查启动目录 → 显示空，与索引库面板同款错位）
    const requestedRoot = String(c.req.query("root") ?? "").trim() || (opts.defaultRoot && fs.existsSync(opts.defaultRoot) ? opts.defaultRoot : process.cwd());
    const root = authorizedRoot(requestedRoot);
    if (!root) return c.json({ ok: false, message: "root 未授权" }, 403);
    const global = _listTopics("global", root);
    const project = _listTopics("project", root);
    const instr = _findInstructionFile(root);
    return c.json({
      globalDir: _globalMemoryDir(),
      projectDir: _projectMemoryDir(root),
      global: global.map((t) => ({ ...t, content: _readMemory("global", t.name, root).text })),
      project: project.map((t) => ({ ...t, content: _readMemory("project", t.name, root).text })),
      instruction: instr ? { path: instr.path, content: instr.content.slice(0, 4000) } : null,
    });
  });

  // ── v2.7 使用统计（会话事件流聚合；days 默认 30）──
  app.get("/api/stats", (c) => {
    const days = Math.min(Math.max(parseInt(String(c.req.query("days") ?? "30"), 10) || 30, 7), 365);
    const store = getStore();
    try {
      return c.json(store.getStats(days));
    } catch (e) {
      return c.json({ ok: false, message: (e as Error).message }, 500);
    }
  });

  // ── v2.7 索引库（文件索引状态 + 重建）──
  app.get("/api/index/status", async (c) => {
    const { indexStatus } = await import("./index/index.js");
    // v2.14 批 18：root 参数（前端传当前项目；缺省回退启动目录）——修复面板与实际项目错位
    const root = authorizedRoot(String(c.req.query("root") ?? "") || (opts.defaultRoot && fs.existsSync(opts.defaultRoot) ? opts.defaultRoot : process.cwd()));
    if (!root) return c.json({ ok: false, message: "root 未授权" }, 403);
    return c.json(indexStatus(root));
  });
  app.post("/api/index/rebuild", async (c) => {
    const { buildIndex } = await import("./index/index.js");
    const body = await c.req.json().catch(() => ({}));
    const root = authorizedRoot(String(body.root ?? "") || (opts.defaultRoot && fs.existsSync(opts.defaultRoot) ? opts.defaultRoot : process.cwd()));
    if (!root) return c.json({ ok: false, message: "root 未授权" }, 403);
    try {
      const idx = buildIndex(root);
      return c.json({ ok: true, fileCount: idx.files.length, builtAt: idx.builtAt });
    } catch (e) {
      return c.json({ ok: false, message: (e as Error).message }, 500);
    }
  });

  // ── v2.4 批 2 Web 交互式终端（node-pty；高危命令审批 + 全量审计）──

  // 创建终端会话（cwd = 项目根；shell 可选 cmd/powershell/bash）
  app.post("/api/terminal", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ownerSessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const owner = ownerSessionId ? getStore().getSession(ownerSessionId) : null;
    if (!owner) return c.json({ ok: false, message: "终端必须关联一个已存在的会话" }, 400);
    if (!owner.root || !existsSync(owner.root) || !statSync(owner.root).isDirectory()) {
      return c.json({ ok: false, message: "所属会话没有有效的项目根目录" }, 400);
    }
    if (!authorizedRoot(owner.root)) return c.json({ ok: false, message: "所属会话根目录未授权或位于受保护区域" }, 403);
    // v3.0 批 12：显式 shell > config.general.terminalShell > auto
    // auto = 优先 Git Bash（探测存在即用），找不到回退 cmd.exe（同语义）
    let shell = typeof body.shell === "string" && body.shell ? body.shell : undefined;
    if (!shell) shell = loadConfig()?.general?.terminalShell;
    if (!shell || shell === "auto") {
      const { resolveShell } = await import("./terminal/session.js");
      const bash = resolveShell("bash");
      shell = bash !== "bash" ? "bash" : undefined; // resolveShell("bash") 找不到时返回 "bash"（PATH 兜底）
    }
    const session = createTerminalSession(ownerSessionId, owner.root, shell);
    return c.json({ ok: true, id: session.id, cwd: session.cwd, shell: session.shell, pid: session.pid });
  });

  // 写入输入。命令级高危审批协议：携带整命令（command 字段），命中高危且未 confirmed → 拦截返回
  // requireApproval（不写入），前端人工确认后带 confirmed:true 重发才执行；每条命令审计落盘。
  app.post("/api/terminal/:id/input", async (c) => {
    const session = getTerminalSession(c.req.param("id"));
    if (!session) return c.json({ ok: false, message: "终端会话不存在或已关闭" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (body.sessionId !== session.sessionId) return c.json({ ok: false, message: "终端不属于当前会话" }, 403);
    const data = typeof body.data === "string" ? body.data : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!data && !command) return c.json({ ok: true });
    // v3.5 审计修复：command 字段缺失时从 data 逐行推导完整命令行（防直连 API
    // 绕过高危审批与审计）——前端只在回车时发送 data（整行命令 + \r），逐行检测安全
    // v3.7 审计修复：command 与 data 并存时 data 段不再跳过检测/审计——此前
    // `{command:"echo ok", data:"rm -rf C:\r\n"}` 的 data 段可无审批无痕迹执行。
    const dataLines: string[] = data
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter(Boolean);
    const derivedDangerous = dataLines.find((l) => detectDangerousTerminalCommand(l));
    if (command && detectDangerousTerminalCommand(command) && body.confirmed !== true) {
      // 高危命令：拦截 + 要求人工确认（安全红线，与 run_command 一致）
      return c.json({ ok: false, requireApproval: true, risk: "high", description: `执行高风险命令：${command}` });
    }
    if (derivedDangerous && body.confirmed !== true) {
      return c.json({ ok: false, requireApproval: true, risk: "high", description: `执行高风险命令：${derivedDangerous}` });
    }
    if (session.exited) return c.json({ ok: false, message: "终端会话已退出" }, 400);
    writeInput(session, data);
    if (command) auditTerminalCommand(session.cwd, command);
    for (const l of dataLines) auditTerminalCommand(session.cwd, l);
    return c.json({ ok: true });
  });

  // PTY 尺寸同步（前端 xterm fit 后调用）
  app.post("/api/terminal/:id/resize", async (c) => {
    const session = getTerminalSession(c.req.param("id"));
    if (!session) return c.json({ ok: false, message: "终端会话不存在" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (body.sessionId !== session.sessionId) return c.json({ ok: false, message: "终端不属于当前会话" }, 403);
    resizeSession(session, Number(body.cols) || 0, Number(body.rows) || 0);
    return c.json({ ok: true });
  });

  // 输出流（SSE：output / exit / ping；新连接先重放会话缓冲）
  // 注意：hono streamSSE 在 callback resolve 后立即 close 流——回调必须保持 pending
  // 直到连接中断（abort 时释放），否则未 await 的 writeSSE 与 close 竞态丢数据。
  app.get("/api/terminal/:id/stream", (c) => {
    const session = getTerminalSession(c.req.param("id"));
    if (!session) return c.json({ ok: false, message: "终端会话不存在" }, 404);
    if (c.req.query("sessionId") !== session.sessionId) return c.json({ ok: false, message: "终端不属于当前会话" }, 403);
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
    const session = getTerminalSession(c.req.param("id"));
    if (!session) return c.json({ ok: false }, 404);
    if (c.req.query("sessionId") !== session.sessionId) return c.json({ ok: false, message: "终端不属于当前会话" }, 403);
    return c.json({ ok: killTerminalSession(session.id) });
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
      // v5.1 补 4：随请求携带的临时联网剩余分钟数（欢迎界面无会话时先选好时长，
      // 发送时对本会话立即生效——服务端与会话创建原子绑定，无竞态）
      const egressMinutes: number | undefined =
        typeof body.egressMinutes === "number" && body.egressMinutes >= 1 && body.egressMinutes <= 120
          ? Math.round(body.egressMinutes)
          : undefined;
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
      // v2.6 主流式流程：默认单一循环直接执行；orchestrate=true 显式启用分层编排
      // （计划确认默认只在编排模式开启；body.planApproval=false 可强制关闭）
      const orchestrate: boolean = body.orchestrate === true;
      const planApproval: boolean = orchestrate ? body.planApproval !== false : false;
      // v3.1 附件原始数据（文件内容在 sessionId 确定后写入暂存目录）
      const rawAttachments: Array<{ name?: string; path?: string; kind?: string; size?: number }> = Array.isArray(body.attachments)
        ? body.attachments
        : [];
      const rawFiles: Array<{ name?: string; rel?: string; data?: string }> = Array.isArray(body.files) ? body.files : [];
      // v3.0 批 12：桌面版附件「路径引用」——真实绝对路径（不复制内容）；Agent 直接读原文件
      const rawPaths: string[] = Array.isArray(body.paths)
        ? body.paths.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0)
        : [];
      const attachmentNamesByPath = new Map(
        rawAttachments
          .filter((item) => typeof item.path === "string" && typeof item.name === "string")
          .map((item) => [path.resolve(item.path!), item.name!] as const)
      );
      const attachmentImages: string[] = Array.isArray(body.images)
        ? body.images.filter((x: unknown): x is string => typeof x === "string" && x.startsWith("data:image/"))
        : [];
      const decodedBase64Bytes = (data: string) => Math.floor(data.length * 3 / 4);
      const uploadedBytes = rawFiles.reduce((n, f) => n + (typeof f.data === "string" ? decodedBase64Bytes(f.data) : 0), 0);
      const imageBytes = attachmentImages.reduce((n, data) => n + decodedBase64Bytes(data.slice(data.indexOf(",") + 1)), 0);
      if (uploadedBytes > MAX_ATTACHMENT_TOTAL_BYTES || imageBytes > MAX_ATTACHMENT_TOTAL_BYTES || uploadedBytes + imageBytes > MAX_ATTACHMENT_TOTAL_BYTES || rawFiles.some((f) => typeof f.data === "string" && decodedBase64Bytes(f.data) > MAX_ATTACHMENT_BYTES)) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "附件总大小超过 32MB，或单个文件超过 16MB" }) });
        stopHeartbeat();
        return;
      }

      // 停止支持：客户端断开连接时中止 Agent 循环
      const controller = new AbortController();
      stream.onAbort(() => {
        stopHeartbeat();
        controller.abort();
        // 中断/停止（用户停止/连接断流）：会话标记 stopped（正常收尾由 finally 处理，不覆盖）
        if (sessionId && store.getSession(sessionId)?.status === "running") {
          store.updateStatus(sessionId, "stopped");
          // v2.13：停止反馈落库（重放/刷新后仍能看到「已手动停止」——原来只在前端内存，
          // 收尾重放整体替换缓存时被抹掉）
          try {
            store.appendEvent(sessionId, { type: "error", message: "任务已手动停止" });
          } catch { /* 落库失败忽略 */ }
        }
      });

      if (!prompt) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "prompt 不能为空" }) });
        stopHeartbeat();
        return;
      }

      // ── v2.1 会话绑定（持久化落库）──
      const store = getStore();
      let sessionId: string | undefined =
        typeof body.sessionId === "string" && body.sessionId ? body.sessionId : undefined;
      // v2.9 修复：root = 会话归属目录（落库/项目匹配/记忆）；execRoot = 执行目录
      //（worktree 模式 = 临时工作树路径；Agent 实际操作边界）。此前 worktree 路径被落库为
      // 会话 root → 项目归属匹配失败 → 新建会话全部落入自由会话区。
      let root: string = body.root || opts.defaultRoot || process.cwd();
      // v3.0 UI 审查：落库 root 只用显式值（body.root，续跑沿用历史值）——
      // 隐式回退（defaultRoot/cwd）仅用于本次执行，不写回会话。前端 root 保持为空 →
      // 自由会话的「代码/审查」按钮禁用，不再显示无关目录的所有文件
      let persistRoot: string | undefined = body.root;
      let execRoot: string = body.execRoot || root;
      // v2.6.2 修复：root 必须为已存在目录——不存在/为空直接报错，避免 Agent 在错误目录静默空转
      if (!execRoot.trim()) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "请先在侧栏选择/创建项目（root 为空）" }) });
        stopHeartbeat();
        return;
      }
      if (!fs.existsSync(execRoot) || !fs.statSync(execRoot).isDirectory()) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: `项目根目录不存在：${execRoot}——请先在侧栏选择/创建项目` }) });
        stopHeartbeat();
        return;
      }
      // Explicitly selected folders are registered before use; every subsequent API/root path
      // is then subject to the same authorizedRoot boundary as file, review and screenshot APIs.
      if (body.root && !authorizedRoot(root)) {
        if (isProtectedPath(path.resolve(root))) {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "项目根目录位于受保护区域，拒绝使用" }) });
          stopHeartbeat();
          return;
        }
        const registered = createProject(root);
        if (!registered.ok && !findProjectByRoot(root)) {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ message: `项目根目录未授权：${registered.message}` }) });
          stopHeartbeat();
          return;
        }
      }
      const safeRoot = authorizedRoot(root);
      if (!safeRoot || isProtectedPath(path.resolve(execRoot)) || !isPathInside(safeRoot, execRoot)) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "项目根目录或执行目录未授权" }) });
        stopHeartbeat();
        return;
      }
      root = safeRoot;
      execRoot = path.resolve(execRoot);
      // v2.2 断点恢复：继续会话 = 从事件流重建完整 messages（工具结果直接来自 DB，不重放副作用）
      let initialMessages: ChatMessageLike[] | undefined;
      // v2.3 阶段级精确续跑：从事件流推断续跑起点（已确认计划 → 跳过规划阶段）
      let resumePoint: ReturnType<typeof inferResumePhase> = {};
      if (sessionId) {
        // 继续会话：校验存在 + 消息级重建 + 沿用历史 root/model
        const s = store.getSession(sessionId);
        if (!s) {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ message: `会话不存在: ${sessionId}` }) });
          stopHeartbeat();
          return;
        }
        // v3.1 多会话并行：仅禁止同一会话并发双流（不同会话可同时跑任务）；
        // 残留 running（服务重启）由启动时的 status 清理兜底
        if (s.status === "running") {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              message: `该会话的任务仍在运行中——请先停止它（或等任务结束后）再发送；如需并行任务请切换到其他会话`,
            }),
          });
          stopHeartbeat();
          return;
        }
        // v2.13：双发 TOCTOU 修复——检查通过后**立即**置 running（检查与置位之间隔着
        // loadMcpTools 等 await，两个并发请求会同时通过检查；同步置位后第二个请求
        // 看到 running 被拒）
        store.updateStatus(sessionId, "running");
        if (!body.root && s.root) {
          root = s.root;
          persistRoot = s.root;
        }
        initialMessages = rebuildMessages(store.getEvents(sessionId));
        resumePoint = inferResumePhase(store.getEvents(sessionId));
      } else {
        // 新会话：SSE 首帧回传会话 id（Web 绑定 activeSessionId）
        const title = prompt.slice(0, 40);
        sessionId = store.createSession({ title, root: persistRoot ?? "", modelId });
        await stream.writeSSE({ event: "session", data: JSON.stringify({ type: "session", id: sessionId }) });
      }
      // A new user task gets fresh desktop/browser evidence. This does not alter embedded
      // browser tabs, navigation state, cookies, or any other browser profile data.
      clearTaskVisualArtifacts(root);
      // 用户消息落库（检查点之一：Rewind 锚点）
      store.appendEvent(sessionId, { type: "user-message", text: prompt });
      // v5.1 补 4：随请求携带的临时联网 → 对本会话立即生效（新会话/续跑都适用；
      // 与既有 POST /api/egress/allow 同语义——过期自动失效，命令审计照常）
      if (egressMinutes) {
        setEgressAllow(sessionId, egressMinutes);
      }

      // ── v3.1 附件处理（sessionId 已定）：文件内容写入暂存目录 ~/.infu/attachments/<sid>/ ──
      // 浏览器 Web 安全限制拿不到文件绝对路径 → 内容上传，服务端暂存后给 Agent 绝对路径引用；
      // 图片 dataURL 直接走视觉（不落库字节）。暂存目录任务结束时统一清理。
      const attachmentItems: AttachmentMeta[] = [];
      const imagePreviewItems: Array<{ name: string; kind: "image"; preview?: string }> = [];
      const attachDir = join(resolveDataDir(), "attachments", sessionId);
      try {
        if (rawFiles.length) {
          fs.mkdirSync(attachDir, { recursive: true });
          for (const f of rawFiles) {
            const name = String(f.name ?? "file").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
            const rel = String(f.rel ?? name).replace(/[\\/]+/g, "/");
            // 防目录穿越：只保留文件名
            const safeRel = rel.split("/").pop() ?? name;
            const target = join(attachDir, safeRel);
            if (f.data) fs.writeFileSync(target, Buffer.from(f.data, "base64"));
            // v2.10 批 7：docx 附件自动提取文本（零依赖 zip 解析）→ Agent 直接 read_file 即可，
            // 不必跑 python-docx 命令（避免无谓的命令审批弹窗）；原文件保留可查
            let readablePath = target;
            if (/\.docx$/i.test(name) && f.data) {
              try {
                const text = extractDocxText(Buffer.from(f.data, "base64"));
                if (text) {
                  const txtPath = join(attachDir, `${safeRel}.txt`);
                  fs.writeFileSync(txtPath, text, "utf-8");
                  readablePath = txtPath;
                }
              } catch { /* 提取失败用原文件 */ }
            }
            const raw = f.data ? Buffer.from(f.data, "base64") : undefined;
            const contentPreview = raw && !raw.includes(0) ? raw.subarray(0, 64 * 1024).toString("utf-8") : undefined;
            attachmentItems.push({ name, path: readablePath, kind: "file", size: raw?.length, contentPreview });
          }
        }
        for (const a of rawAttachments) {
          const kind = a.kind === "dir" ? "dir" : "file";
          const name = String(a.name ?? "附件");
          if (kind === "dir") {
            // 文件夹：引用暂存目录下该文件夹（files 的 rel 若带目录结构，已含层级）
            attachmentItems.push({ name, path: join(attachDir, name), kind: "dir" });
          }
        }
      } catch (e) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: `附件暂存失败：${(e as Error).message}` }) });
        stopHeartbeat();
        return;
      }
      // 桌面版路径引用：普通文件仍只读引用；图片转换为 data URL 注入视觉队列，
      // 使「系统文件选择器选图」与 Web 上传图片得到同样的模型识别能力。
      for (const p of rawPaths) {
        try {
          if (isProtectedPath(p)) continue;
          const st = statSync(p);
          if (st.isDirectory()) {
            attachmentItems.push({ name: attachmentNamesByPath.get(path.resolve(p)) ?? p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p, kind: "dir" });
          } else if (st.isFile()) {
            const ext = path.extname(p).toLowerCase();
            const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
            if (mime[ext] && st.size <= MAX_ATTACHMENT_BYTES) {
              attachmentImages.push(`data:${mime[ext]};base64,${fs.readFileSync(p).toString("base64")}`);
              imagePreviewItems.push({ name: attachmentNamesByPath.get(path.resolve(p)) ?? p.split(/[\\/]/).filter(Boolean).pop() ?? `图片 ${imagePreviewItems.length + 1}`, kind: "image", preview: attachmentImages.at(-1)! });
            } else {
              const raw = st.size <= 64 * 1024 ? fs.readFileSync(p) : undefined;
              const contentPreview = raw && !raw.includes(0) ? raw.toString("utf-8") : undefined;
              attachmentItems.push({ name: attachmentNamesByPath.get(path.resolve(p)) ?? p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p, kind: "file", size: st.size, contentPreview });
            }
          }
        } catch { /* 路径不存在/不可读：跳过 */ }
      }
      // 图片：视觉队列使用原 data URL；会话事件只保存预览数据供消息流显示。
      for (const [index, img] of attachmentImages.entries()) {
        if (imagePreviewItems.some((item) => item.preview === img)) continue;
        const name = `图片 ${index + 1}`;
        imagePreviewItems.push({ name, kind: "image", preview: img });
      }
      // 只读白名单：暂存目录（上传）或原路径集合（桌面路径引用）；Agent 可读不可写
      const extraReadDirs = attachmentItems.some((a) => a.kind !== "image")
        ? [...new Set([attachDir, ...rawPaths.map((p) => (p.endsWith("/") || p.endsWith("\\") ? p : dirname(p)))])]
        : [];
      // 附件引用文本（注入所有阶段 prompt；图片在 Executor 阶段走视觉）
      const attachmentText = attachmentItems.length || imagePreviewItems.length
        ? `📎 用户已附加以下内容：\n` +
          [
            ...attachmentItems.map((a) => `- ${a.kind === "dir" ? "文件夹" : "文件"}：${a.name}${a.path ? `（${a.path}）` : ""}${a.kind === "dir" ? "；可读取其中的文件" : ""}`),
            ...imagePreviewItems.map((a) => `- 图片：${a.name}（已作为视觉输入提供）`),
          ].join("\n")
        : "";
      // 附件事件落库（重放展示；图片字节不落库）
      if (attachmentItems.length || imagePreviewItems.length) {
        store.appendEvent(sessionId, { type: "attachments", items: [...attachmentItems, ...imagePreviewItems] });
      }

      // 项目根目录校验：路径不存在/不是目录时直接报明确错误（避免 AI 根据工具报错瞎猜路径）
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        store.updateStatus(sessionId, "error");
        // v2.13：早退路径同样清理附件暂存（防 base64 内容残留）
        try {
          if (rawFiles.length) fs.rmSync(attachDir, { recursive: true, force: true });
        } catch { /* 清理失败忽略 */ }
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: `项目根目录不存在或不是目录: ${root}（请检查输入框里的路径是否正确，使用绝对路径）` }),
        });
        stopHeartbeat();
        return;
      }

      // v5.0（C2）：显式 root 自动注册项目——「打开文件夹即项目」心智：用户显式选择了
      // 一个存在的目录作为会话根但尚未注册项目时，自动注册（免去手动「创建项目」一步）；
      // defaultRoot（自由会话只读容器）不自动注册（注册会解锁写权限，语义必须保持）
      if (persistRoot && !findProjectByRoot(root)) {
        const cfg = loadConfig();
        if (root !== cfg?.general?.defaultRoot) {
          const reg = createProject(root);
          if (reg.ok) {
            try {
              store.appendEvent(sessionId, { type: "text", text: `（已自动注册为项目：${root}——侧栏项目区可见，代码/审查界面立即可用）` });
            } catch { /* 忽略 */ }
            await stream.writeSSE({
              event: "agent",
              data: JSON.stringify({ type: "text", text: `（已自动注册为项目：${root}——侧栏项目区可见，代码/审查界面立即可用）` }),
            }).catch(() => {});
          }
        }
      }

      const config = loadConfig();
      const models = config?.models ?? [];
      if (!models.length) {
        store.updateStatus(sessionId, "error");
        try {
          if (rawFiles.length) fs.rmSync(attachDir, { recursive: true, force: true });
        } catch { /* 清理失败忽略 */ }
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "未配置模型，请先配置 ~/.infu/config.json" }) });
        stopHeartbeat();
        return;
      }
      // v3.0 批 12 修复：v2 供应商凭据迁移后 `m.apiKey` 恒为 undefined（key 在 provider 层）
      // → 旧逻辑永远落 models[0]，无视 defaultModelId（Web 端「默认模型」死配置）。
      // 修正：显式 modelId → defaultModelId → 第一个有凭据的模型（providerId 查 providers[]）→ models[0]
      const modelCfg = (() => {
        const pick = (id?: string) => models.find((m) => m.id === id);
        const withKey = (m?: ModelConfig) => {
          if (!m) return undefined;
          const p = m.providerId ? config?.providers?.find((x) => x.id === m.providerId) : undefined;
          return (p?.apiKey ?? m.apiKey) ? m : undefined;
        };
        const explicit = modelId ? pick(modelId) : undefined;
        if (explicit) return explicit;
        // v5.0（B4）：快速回复模型路由——寒暄/极短非任务消息（无任务意图词）自动用
        // general.quickModelId（省钱提速，用户无感）；任务类消息走默认模型
        const quick = config?.general?.quickModelId ? pick(config.general.quickModelId) : undefined;
        if (quick && withKey(quick)) {
          const text = prompt.trim();
          if (text.length < 60 && !/实现|修复|重构|创建|新建|添加|增加|修改|优化|完成|解决|分析|检查|测试|开发|集成|部署|迁移|升级|调整|支持|调研|评审|审查|构建|初始化|报错|异常|问题|改成|编写|做一个|写一个/.test(text)) {
            return quick;
          }
        }
        const def = pick(config?.defaultModelId);
        if (withKey(def)) return def as ModelConfig;
        if (def) return def;
        return withKey(models[0]) ?? models[0] ?? (models as ModelConfig[])[0];
      })();
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
        // v3.5：事件钩子（桌面端任务完成通知/防休眠；失败静默）
        try { opts.onEvent?.(sessionId, e); } catch { /* 钩子失败不影响主流程 */ }
      };

      // 审批：推送 approval-required 事件 → 挂 pending → 等待 POST /api/approvals/:id 决策
      // 连接中断（停止）时自动拒绝并释放
      // v2.4 审批档位（config.approvalPolicy.mode）：auto 直接放行不发事件；confirm 全部人工；
      // requireExplicit（联网放行等安全线）auto/smart/confirm 都弹窗人工确认（guard 对内置工具
      // 已按档位拦截，此处兜底 MCP/插件/vision/delegate 直调路径）
      // v3.2 会话全权放行（sessionBypass）：此处统一检查——用户点「本会话全部放行」后，
      // MCP/vision/delegate 直调路径同样不再弹窗（此前只对走 guard() 的内置工具生效）
      // v3.5 full 档：shouldAutoApprove 返回 true（含红线）直接放行
      const requestApproval = async (description: string, risk: RiskLevel, requireExplicit?: boolean) => {
        if (
          shouldAutoApprove(resolveApprovalPolicy(loadConfig()), risk, requireExplicit) === true ||
          isSessionBypassed(sessionId)
        ) {
          return true;
        }
        const id = randomUUID();
        emit({ type: "approval-required", id, description, risk });
        return new Promise<boolean>((resolve) => {
          pendingApprovals.set(id, { sessionId, resolve });
          controller.signal.addEventListener(
            "abort",
            () => {
              if (pendingApprovals.delete(id)) resolve(false);
            },
            { once: true }
          );
        });
      };

      // v2.6 收尾：Agent 执行中提问（ask_user 工具）：emit ask-user 事件 → 挂 pending →
      // 等 POST /api/ask/:id 回答；连接中断（停止）时视为跳过（返回 null）
      // v2.10：选项结构化（label/desc/recommended）；description/multiSelect 透传事件
      // v3.4 审计修复：15 分钟超时兜底——用户不回答 + 任务不中止时 Promise 永久悬挂
      // （子 Agent 卡死等待、资源不释放）；超时返回 null（等价跳过）
      // v3.5：general.autoContinueQuestions 开启后自动继续。
      // 5 分钟未回答自动继续（resolve null = Agent 跳过继续）；关 → 一直等待用户回答
      // （仅任务中止可退出；用户显式选择的语义）
      const askUser = async (
        question: string,
        options?: Array<string | { label: string; desc?: string; recommended?: boolean }>
      ) => {
        // v3.9（2026-08-18 用户拍板「最大审批权限」）：full 档全自主——不挂起等用户，
        // 事件照常落库（审计可见），返回 null 让模型自行决策继续
        if (resolveApprovalPolicy(loadConfig()).mode === "full") {
          emit({ type: "ask-user", id: randomUUID(), question, options: options as Array<string | { label: string; desc?: string; recommended?: boolean }> | undefined, autoSkipped: true });
          return null;
        }
        const id = randomUUID();
        emit({ type: "ask-user", id, question, options: options as Array<string | { label: string; desc?: string; recommended?: boolean }> | undefined });
        return new Promise<string | null>((resolve) => {
          pendingQuestions.set(id, { sessionId, resolve });
          let timer: NodeJS.Timeout | undefined;
          if (loadConfig()?.general?.autoContinueQuestions === true) {
            timer = setTimeout(() => {
              if (pendingQuestions.delete(id)) resolve(null);
            }, 5 * 60 * 1000);
          }
          controller.signal.addEventListener(
            "abort",
            () => {
              if (timer) clearTimeout(timer);
              if (pendingQuestions.delete(id)) resolve(null);
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
        // v3.9（2026-08-18 用户拍板「最大审批权限」）：full 档全自主——计划自动批准
        // （事件已落库审计），不挂起等用户确认
        if (resolveApprovalPolicy(loadConfig()).mode === "full") {
          return { plan: undefined, feedback: "批准执行" };
        }
        return new Promise<{ plan?: string; feedback: string } | null>((resolve) => {
          pendingPlans.set(id, {
            sessionId,
            resolve: (d) => {
              if (d.cancelled) resolve(null);
              else resolve({ plan: d.plan, feedback: d.feedback ?? "批准执行" });
            },
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
        // v2.3 动态扩展：MCP 服务器 + JS 插件（连接/加载失败的跳过不阻塞任务）。任务结束后统一 close/释放。
        const mcp = await loadMcpTools(config?.mcpServers, emit, undefined, Object.keys(TOOLS));
        const plugin = await loadPlugins(config?.plugins, emit, { builtinNames: Object.keys(TOOLS) });
        // skill 发现层：可用技能 name+description 追加到 Executor system（progressive disclosure）
        const skillsPrompt = buildSkillsPrompt(listSkills(config, execRoot));
        // v2.5 子智能体发现层：可用 agent 角色 name+description（delegate_task 委派参考）
        const agentsPrompt = buildAgentsPrompt(listAgents(execRoot));
        // v2.6 记忆系统：项目指令（INFU.md 全量注入所有阶段）+ 记忆引导（Executor）+ 路径作用域
        const infuPrompt = buildInfuPrompt(execRoot);
        const memoryPrompt = buildMemoryPrompt();
        const scopeRules = parseScopeRules(findInstructionFile(execRoot)?.content ?? "");
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
            root: execRoot,
            projectRoot: root,
            emit,
            requestApproval,
            abortSignal: controller.signal,
            maxSteps,
            askUser,
          };
          // v3.1：任务启动置 running（新会话默认即 running；续跑会话恢复运行态，
          // 侧栏徽标 + 同会话双发保护）
          store.updateStatus(sessionId, "running");
          const final = await runOrchestratedTask({
            ...modelRun,
            planApproval,
            orchestrate,
            confirmPlan,
            templateId,
            // v2.3：MCP 工具 + 插件工具只进 Executor（Planner/Reviewer 架构级只读不暴露）；
            // 插件钩子随 Executor 生效；skill 描述注入 Executor system
            executorTools: [...(mcp?.tools ?? []), ...(plugin?.tools ?? [])],
            hooks: plugin?.hooks,
            skillsPrompt,
            agentsPrompt,
            // v2.6 记忆系统：指令注入 + 记忆引导 + 作用域（编排内部任务完成后自动沉淀）
            infuPrompt,
            memoryPrompt,
            scopeRules,
            // v3.1 附件：文件/文件夹引用文本（所有阶段）+ 图片视觉（Executor）+ 只读白名单
            attachmentText,
            attachmentImages,
            extraReadDirs,
            // v2.9：会话 id（per-session 子 Agent 上限计数）
            sessionId,
            // v6.0（S4）：任务级 Token 预算（读 config general.taskTokenBudget；0=不限制）
            taskTokenBudget: config?.general?.taskTokenBudget ?? 0,
            // 阶段级续跑：跳过已完成的规划阶段（计划沿用上次确认的）
            startPhase: resumePoint.startPhase,
            resumePlanText: resumePoint.planText,
          });
          await stream.writeSSE({ event: "done", data: JSON.stringify({ final: final.text }) });
          store.updateStatus(sessionId, "done");
          // v3 自动命名（fire-and-forget；模型生成简短标题，失败保留原文截断）
          autoNameSession(store, sessionId, prompt, final.text, modelCfg).catch(() => {});
        } finally {
          if (mcp) await mcp.close();
          // v3.1：任务结束清理附件暂存目录（会话重放只保留元数据）
          try {
            if (rawFiles.length) fs.rmSync(attachDir, { recursive: true, force: true });
          } catch {
            /* 清理失败忽略 */
          }
          // 子 Agent inherits the parent task lifecycle. Background commands are deliberately
          // retained: a dev server must remain available for user-driven browser validation.
          try { abortBackgroundAgentsByDepth(sessionId, -1); } catch { /* 忽略 */ }
          // v3.0 审计修复（S3）：任务结束关闭持久 shell 会话（此前永不清理，泄漏带凭据的常驻进程）
          try { closeShellSession(sessionId); } catch { /* 忽略 */ }
          // v3.4 审计修复（M4）：任务结束补三项会话级清理（此前只在删除会话时清，正常结束的任务
          // 在服务常驻期残留跨任务状态——文件观察记录、已批准记忆、全权放行开关全泄漏到下一任务）
          try { clearObservedFiles(sessionId); } catch { /* 忽略 */ }
          try { clearApprovalMemory(sessionId); } catch { /* 忽略 */ }
          // v3.6：todo 清单 / 插件技能目录会话级清理（并行会话串扰收敛 + 防内存累积）
          try { clearTodos(sessionId); } catch { /* 忽略 */ }
          try { clearPluginSkillDirs(); } catch { /* 忽略 */ }
          try { clearSessionBypass(sessionId); } catch { /* 忽略 */ }
          try { clearEgressAllow(sessionId); } catch { /* 忽略 */ }
          // v3.4 审计修复：任务结束清理挂起队列——用户不点按钮（确认框/提问/计划卡片）
          // 且任务正常结束时，pendingApprovals/pendingQuestions/pendingPlans 的 Promise
          // 永久悬挂（内存泄漏 + 拦截后续同名 id 响应）
          // v3.5 审计修复（H4）：只清理**本会话**的挂起项——其他会话的审批/提问/计划
          // 卡片不受影响（此前清全部：并行会话互相误杀挂起队列）
          for (const [pid, entry] of pendingApprovals) {
            if (entry.sessionId === sessionId) { pendingApprovals.delete(pid); entry.resolve(false); }
          }
          for (const [pid, entry] of pendingQuestions) {
            if (entry.sessionId === sessionId) { pendingQuestions.delete(pid); entry.resolve(null); }
          }
          for (const [pid, entry] of pendingPlans) {
            if (entry.sessionId === sessionId) { pendingPlans.delete(pid); entry.resolve({ cancelled: true }); }
          }
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
    const wtPath = path.join(root, ".infu", "worktrees", name);
    try {
      // v3.3 补 26：无基线仓库（git init 后从未提交）先自动建基线——
      // 否则 worktree add 从空 HEAD 检出，副本里没有项目文件（Agent 在空副本干活、
      // 代码界面只剩 .infu——用户实测）；git add -A 提交全部文件为基线
      const head = await gitQuiet(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "");
      if (!head.trim()) {
        await git(root, ["add", "-A"]);
        await git(root, ["commit", "-m", "init: InFu 自动建立 git 基线"]);
      }
      await git(root, ["worktree", "add", wtPath, "-b", name]);
      return c.json({ ok: true, name, path: wtPath, branch: name, baseline: !head.trim() });
    } catch (e) {
      return c.json({ ok: false, message: `创建工作树失败: ${(e as Error).message}` }, 500);
    }
  });

  // 合并任务分支回主分支并清理工作树
  app.post("/api/worktree/:name/merge", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => ({}));
    const root: string = body.root || opts.defaultRoot || process.cwd();
    if (!/^infu-task-[a-z0-9]+$/i.test(name)) return c.json({ ok: false, message: "非法工作树名称" }, 400);
    if (!authorizedRoot(root)) return c.json({ ok: false, message: "root 未授权" }, 403);
    const wtPath = path.join(root, ".infu", "worktrees", name);
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
    if (!/^infu-task-[a-z0-9]+$/i.test(name)) return c.json({ ok: false, message: "非法工作树名称" }, 400);
    if (!authorizedRoot(root)) return c.json({ ok: false, message: "root 未授权" }, 403);
    const wtPath = path.join(root, ".infu", "worktrees", name);
    try {
      await git(root, ["worktree", "remove", "--force", wtPath]);
      await git(root, ["branch", "-D", name]);
      return c.json({ ok: true, message: `已丢弃任务分支 ${name}` });
    } catch (e) {
      return c.json({ ok: false, message: `丢弃失败: ${(e as Error).message}` }, 500);
    }
  });

  // v3.2 会话级全权放行开关（审批弹窗「本会话全部放行」按钮）：
  // 开启后该会话内所有审批（含红线）自动放行，直到会话结束/删除（见 deleteSession 清理）。
  // v3.5 修复：必须注册在 /api/approvals/:id 之前——否则 "bypass" 会被 :id 路由吞掉
  // （返回「审批不存在或已过期」，按钮点了没反应）。
  app.post("/api/approvals/bypass", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sid = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;
    if (!sid) return c.json({ ok: false, message: "缺少 sessionId" });
    // v4.0 审计修复（H1 缓解）：① bypass 必须针对**已存在**会话（防任意会话预埋）；
    // ② 开启/关闭动作落库审计事件——本机任意进程（含沙箱内命令）拿到令牌即可调
    // 本端点，开启动作本身留痕，会话重放/审计可查
    const store = getStore();
    if (!store.getSession(sid)) return c.json({ ok: false, message: "会话不存在" }, 404);
    const enabled = body.enabled !== false;
    setSessionBypass(sid, enabled);
    try {
      store.appendEvent(sid, { type: "approval-bypass", enabled, at: Date.now() });
    } catch { /* 审计落库失败不影响开关 */ }
    return c.json({ ok: true, bypass: isSessionBypassed(sid) });
  });

  // v5.0（C1）：会话级临时联网开关（默认断网策略的轻量出口——npm install 等高频
  // 外传命令不再每次被拦；到期自动失效，命令审计照常落库）
  app.post("/api/egress/allow", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sid = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;
    if (!sid) return c.json({ ok: false, message: "缺少 sessionId" }, 400);
    if (!getStore().getSession(sid)) return c.json({ ok: false, message: "会话不存在" }, 404);
    const minutes = Number(body.minutes) || 10;
    setEgressAllow(sid, minutes);
    return c.json({ ok: true, remainingSec: egressAllowRemaining(sid) });
  });
  app.delete("/api/egress/allow", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sid = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;
    if (!sid) return c.json({ ok: false, message: "缺少 sessionId" }, 400);
    clearEgressAllow(sid);
    return c.json({ ok: true });
  });
  app.get("/api/egress/allow", (c) => {
    const sid = String(c.req.query("sessionId") ?? "");
    return c.json({ ok: true, allowed: isEgressAllowed(sid), remainingSec: egressAllowRemaining(sid) });
  });

  // 审批决策入口（Web UI 调用）
  app.post("/api/approvals/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const entry = pendingApprovals.get(id);
    if (!entry) return c.json({ ok: false, message: "审批不存在或已过期" });
    pendingApprovals.delete(id);
    entry.resolve(!!body.approved);
    return c.json({ ok: true });
  });

  // 计划确认入口（v2.3 计划卡片：提交 = {plan?, feedback}；取消 = {cancelled: true}）
  app.post("/api/plan/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const entry = pendingPlans.get(id);
    if (!entry) return c.json({ ok: false, message: "计划不存在或已过期" });
    pendingPlans.delete(id);
    if (body.cancelled === true) {
      entry.resolve({ cancelled: true });
    } else {
      entry.resolve({
        plan: typeof body.plan === "string" && body.plan.trim() ? body.plan : undefined,
        feedback: typeof body.feedback === "string" && body.feedback.trim() ? body.feedback.trim() : "批准执行",
      });
    }
    return c.json({ ok: true });
  });

  // v2.6 收尾：Agent 提问回答入口（ask_user 工具；answer 字符串；cancelled=true 视为跳过）
  app.post("/api/ask/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const entry = pendingQuestions.get(id);
    if (!entry) return c.json({ ok: false, message: "提问不存在或已过期" });
    pendingQuestions.delete(id);
    if (body.cancelled === true) {
      entry.resolve(null);
    } else {
      entry.resolve(typeof body.answer === "string" ? body.answer : "");
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
  // v3.4 审计修复：事件类型白名单——原实现任意事件都可注入（伪造 tool-result/plan/
  // approval/task-notification 等 → 重放界面显示伪造内容；继续会话时伪造事件进入
  // 模型上下文被投毒）。v1 迁移只产生这几类内容事件，其余一律拒绝。
  const MIGRATABLE_EVENTS = new Set([
    "user-message", "text", "reasoning", "assistant-message",
    "tool-start", "tool-result", "context-compressed", "error",
    "step-start", "report", "review", "done",
  ]);
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
      const type = (e as any).type as string;
      if (!MIGRATABLE_EVENTS.has(type)) {
        return c.json({ ok: false, message: `事件类型 "${type}" 不允许注入（仅 v1 迁移内容类事件可导入）` }, 400);
      }
      store.appendEvent(id, e as AgentEvent);
    }
    return c.json({ ok: true, count: events.length });
  });

  // 会话列表（多会话/历史浏览；v2.6.1 支持 archived 过滤）
  app.get("/api/sessions", (c) => {
    const limit = Math.min(parseInt(String(c.req.query("limit") ?? "50"), 10) || 50, 200);
    const archived = c.req.query("archived");
    const sessions = archived === "1" ? getStore().listSessions(limit, true) : getStore().listSessions(limit, false);
    return c.json({ sessions });
  });

  // 会话管理（v2.6.1：重命名 / 顶置 / 归档）
  app.patch("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const store = getStore();
    if (!store.getSession(id)) return c.json({ ok: false, message: "会话不存在" }, 404);
    if (typeof body.title === "string") {
      if (!store.renameSession(id, body.title)) return c.json({ ok: false, message: "标题不能为空" }, 400);
    }
    if (typeof body.pinned === "boolean") store.setPinned(id, body.pinned);
    if (typeof body.archived === "boolean") store.setArchived(id, body.archived);
    return c.json({ ok: true });
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
    const sess = store.getSession(id);
    if (!sess) return c.json({ ok: false, message: "会话不存在" }, 404);
    store.deleteSession(id);
    // v3.2：会话删除 → 清理运行时状态（read-before-edit 观察 / 已批准记忆 / 全权放行——防长驻服务内存增长）
    clearObservedFiles(id);
    clearApprovalMemory(id);
    clearSessionBypass(id);
    try { clearRecovery(id); } catch { /* 忽略 */ }
    try { clearEgressAllow(id); } catch { /* 忽略 */ }
    // v3.6：todo 清单随会话删除清理
    try { clearTodos(id); } catch { /* 忽略 */ }
    // v3.0 批 12：会话删除 → 清理该会话的 computer use 截图（.infu/screenshots/screen-<sid8>-*.png）
    // 项目文件夹整体删除时截图随文件夹消失；这里补「只删会话」场景的孤儿截图
    try {
      const sid8 = id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8);
      const shotsDir = join(sess.root, ".infu", "screenshots");
      if (sid8 && existsSync(shotsDir)) {
        for (const f of readdirSync(shotsDir)) {
          if (f.startsWith(`screen-${sid8}-`)) {
            try { fs.rmSync(join(shotsDir, f), { force: true }); } catch { /* 忽略单个失败 */ }
          }
        }
      }
    } catch { /* 清理失败不影响删除 */ }
    // v3.5 数据生命周期：会话删除联动清理该会话的磁盘产物——
    // ① run_command 大输出 .infu/outputs/<sid>-*.log（v3.5 起文件名带会话前缀）
    // ② 浏览器截图 .infu/browser/<sid>-*.png
    // ③ 附件暂存 ~/.infu/attachments/<sid>/（任务异常终止时的兜底——任务正常结束已清理）
    try {
      const sid8 = id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8);
      if (sid8) {
        for (const [dir, prefix] of [
          [join(sess.root, ".infu", "outputs"), `${sid8}-`],
          [join(sess.root, ".infu", "browser"), `${sid8}-`],
        ] as const) {
          if (!existsSync(dir)) continue;
          for (const f of readdirSync(dir)) {
            if (f.startsWith(prefix)) {
              try { fs.rmSync(join(dir, f), { force: true }); } catch { /* 忽略单个失败 */ }
            }
          }
        }
        const attachDir = join(resolveDataDir(), "attachments", id);
        if (existsSync(attachDir)) {
          try { fs.rmSync(attachDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
        }
      }
    } catch { /* 清理失败不影响删除 */ }
    return c.json({ ok: true });
  });

  // Rewind：回滚到检查点（seq 及之后的事件全部删除，会话回到"未完成"态）
  app.post("/api/sessions/:id/rewind", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const seq = parseInt(String(body.seq ?? ""), 10);
    if (!Number.isInteger(seq) || seq < 0) return c.json({ ok: false, message: "seq 必须是 >= 0 的整数" }, 400);
    // v3.7 审计修复：运行中回滚 → 拒绝——正在跑的任务继续 appendEvent（seq 从回滚点
    // 重新增长）会与截断后的事件流产生混合状态；且收尾 done 被 stopped 终态拒绝覆盖，
    // 会话显示 stopped 实际仍在执行。先停止任务再回滚。
    const sess = getStore().getSession(id);
    if (sess?.status === "running") {
      return c.json({ ok: false, message: "会话正在运行，请先停止任务再回滚" }, 400);
    }
    // v2.14 批 10：marker=false = 编辑截断（不落回滚标记，AI 无需感知）；默认 true = 回滚（AI 感知）
    if (!getStore().rewind(id, seq, { marker: body.marker !== false })) return c.json({ ok: false, message: "会话不存在" }, 404);
    return c.json({ ok: true });
  });

  // ── v2.6.1 项目注册表（~/.infu/projects.json：会话按 root 命中判断隶属；移除只删注册）──

  // 项目列表（注册表 + 各项目会话统计）
  app.get("/api/projects", (c) => {
    const sessions = getStore().listSessions(200, false);
    const projects = listProjects().map((p) => {
      const ps = sessions.filter((s) => {
        const norm = (x: string) => x.replace(/[\\/]+$/, "").toLowerCase();
        return norm(s.root) === norm(p.root);
      });
      return {
        id: p.id,
        name: p.name,
        root: p.root,
        createdAt: p.createdAt,
        sessionCount: ps.length,
        recentSessions: ps.slice(0, 50),
      };
    });
    return c.json({ projects });
  });

  // 创建项目（注册文件夹为项目）
  app.post("/api/projects", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const root = String(body.root ?? "").trim();
    const r = createProject(root, typeof body.name === "string" ? body.name : undefined);
    return r.ok ? c.json({ ok: true, project: r.project, message: r.message }) : c.json({ ok: false, message: r.message }, 400);
  });

  // 浏览文件夹降级：按目录名解析候选路径（浏览器拿不到所选文件夹绝对路径 → 服务端扫描常见位置一层匹配）
  app.get("/api/projects/resolve", (c) => {
    const name = String(c.req.query("name") ?? "").trim();
    return c.json({ candidates: resolveProjectByName(name) });
  });

  // v3.3：一键初始化 git 仓库（审查界面非 git 提示按钮）。
  app.post("/api/git-init", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const root = String(body.root ?? "").trim();
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return c.json({ ok: false, message: "root 无效" }, 400);
    }
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore", windowsHide: true });
      return c.json({ ok: true, message: "已初始化 git 仓库——代码改动与审查立即可用" });
    } catch (e) {
      return c.json({ ok: false, message: `git init 失败：${(e as Error).message.slice(0, 120)}` }, 500);
    }
  });

  // 移除项目（只删注册；会话保留为自由会话，文件夹不删）
  app.delete("/api/projects/:id", (c) => {
    const r = removeProject(c.req.param("id"));
    return r.ok ? c.json({ ok: true, message: r.message }) : c.json({ ok: false, message: r.message }, 404);
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
      try { s.url = (await validateHttpMcpUrl(String(body.url))).toString(); }
      catch (e) { return c.json({ ok: false, message: (e as Error).message }, 400); }
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
    if (typeof body.url === "string") {
      if (!body.url) s.url = undefined;
      else {
        try { s.url = (await validateHttpMcpUrl(body.url)).toString(); }
        catch (e) { return c.json({ ok: false, message: (e as Error).message }, 400); }
      }
    }
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
          setTimeout(() => reject(new Error("连接超时（15s）")), 15000).unref()
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
    // v2.7：内置官方插件（默认启用，可禁用）+ 用户插件合并视图
    const user = (cfg.plugins ?? []).filter((p) => p.source !== "builtin");
    const disabledBuiltin = new Set(
      (cfg.plugins ?? []).filter((p) => p.source === "builtin" && p.enabled === false).map((p) => p.id)
    );
    const builtin = listBuiltinPlugins().map((b) => ({
      id: b.id,
      name: b.name,
      path: b.path,
      version: b.version,
      source: b.source,
      builtin: true,
      enabled: !disabledBuiltin.has(b.id),
    }));
    return c.json({ plugins: [...builtin, ...user] });
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
    // Generated code is always kept in the protected data directory. Accepting an arbitrary
    // body.path here made this authenticated API a filesystem write primitive.
    const pluginDir = join(resolveDataDir(), "plugins");
    const file = join(pluginDir, `${id}.mjs`);
    try {
      mkdirSync(pluginDir, { recursive: true });
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
    if (isBuiltinPlugin(id)) {
      // 内置插件：只能启用/禁用（写 config 标记），不可改 path
      if (typeof body.enabled === "boolean") {
        const rest = (cfg.plugins ?? []).filter((x) => x.id !== id);
        if (body.enabled === false) {
          const bp = listBuiltinPlugins().find((b) => b.id === id)!;
          cfg.plugins = [...rest, { id, path: bp.path, source: "builtin", version: bp.version, enabled: false }];
        } else {
          cfg.plugins = rest; // 移除禁用标记 = 恢复默认启用
        }
        saveConfig(cfg);
        return c.json({ ok: true });
      }
      return c.json({ ok: false, message: "内置插件只能启用/禁用，不可改 path" }, 400);
    }
    const p = (cfg.plugins ?? []).find((x) => x.id === id);
    if (!p) return c.json({ ok: false, message: "插件不存在" }, 404);
    if (typeof body.path === "string" && body.path.trim()) p.path = body.path.trim();
    if (typeof body.enabled === "boolean") p.enabled = body.enabled;
    saveConfig(cfg);
    return c.json({ ok: true });
  });

  // 删除插件（内置插件 = 禁用，保留默认启用能力）
  app.delete("/api/plugins/:id", (c) => {
    const id = c.req.param("id");
    const cfg = readConfigRaw();
    if (isBuiltinPlugin(id)) {
      const rest = (cfg.plugins ?? []).filter((x) => x.id !== id);
      const bp = listBuiltinPlugins().find((b) => b.id === id)!;
      cfg.plugins = [...rest, { id, path: bp.path, source: "builtin", version: bp.version, enabled: false }];
      saveConfig(cfg);
      return c.json({ ok: true, disabled: true });
    }
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
    let p = (cfg.plugins ?? []).find((x) => x.id === id);
    if (!p && isBuiltinPlugin(id)) p = listBuiltinPlugins().find((b) => b.id === id)!;
    if (!p) return c.json({ ok: false, message: "插件不存在" }, 404);
    try {
      const { loadPlugins } = await import("./plugin/index.js");
      const r = await loadPlugins([p], () => {}, { mergeBuiltin: false });
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
  app.get("/api/skills", async (c) => {
    const cfg = readConfigRaw();
    const root = opts.defaultRoot || process.cwd();
    // v3.0 批 12：确保内置插件技能已注册（新用户未跑过任务时 pluginSkillDirs 为空
    // → 设置界面看不到自带技能；这里先加载内置插件再列技能）
    try {
      const { loadPlugins } = _require("./plugin/index.js");
      await loadPlugins(cfg?.plugins ?? [], () => {}, { mergeBuiltin: true }).catch(() => {});
    } catch { /* 加载失败不影响列表 */ }
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

  // 子 Agent 可选工具目录：从当前注册表生成，自动覆盖内置与启用插件工具；架构级禁用项不暴露。
  app.get("/api/agents/tools", (c) => {
    const tools = Object.entries(TOOLS)
      .filter(([name]) => !SUBAGENT_FORBIDDEN_TOOLS.has(name))
      .map(([name, tool]) => ({ name, description: tool.description, risk: tool.risk }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ tools });
  });

  // 追踪胶囊可中断本会话的后台 run_command；仅命中当前 session 的 job 注册表。
  app.post("/api/jobs/:id/kill", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId || !getStore().getSession(sessionId)) return c.json({ ok: false, message: "会话不存在或 sessionId 缺失" }, 404);
    const message = killJob(sessionId, c.req.param("id"));
    return c.json({ ok: !message.startsWith("错误："), message });
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

  // ── 静态托管（桌面端同端口托管 web dist：前端相对路径 fetch 零改动）──
  if (opts.staticDir) {
    const MIME: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".ttf": "font/ttf",
      ".map": "application/json; charset=utf-8",
    };
      // v3.1：令牌注入（index.html 唯一载体）——前端 apiFetch 读取 window.__INFU_TOKEN__
      // v4.0 补 1（CSP 回归修复）：CSP `script-src 'self'` 会拦截**内联脚本**——令牌注入
      // 脚本本身就是内联的（v4.0 审计批加 CSP 头后，生产页面重启即全部 API 401「缺少
      // 本地令牌」）。修复：每次响应生成随机 nonce——CSP 头带 `'nonce-<n>'`、注入脚本带
      // `nonce="<n>"`，强策略与令牌注入共存（主题恢复脚本已外置 /theme-init.js 走 'self'）
      const injectToken = (html: string, nonce: string): string => {
        if (!localToken) return html;
        const script = `<script nonce="${nonce}">window.__INFU_TOKEN__="${localToken}";</script>`;
        return html.includes("</head>") ? html.replace("</head>", script + "</head>") : script + html;
      };
      /** CSP（index.html 带响应级 nonce 放行令牌脚本；其余资源无内联脚本，严格策略） */
      const buildCsp = (withNonce: boolean, nonce = "") =>
        `default-src 'self'; script-src 'self'${withNonce ? ` 'nonce-${nonce}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
    app.get("*", async (c) => {
      const url = new URL(c.req.url);
      if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.notFound();
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";
      const filePath = path.normalize(join(opts.staticDir!, pathname));
      // 防路径穿越（.. 逃出静态目录）；isPathInside(root, abs) —— root 在前
      if (!isPathInside(opts.staticDir!, filePath)) return c.notFound();
      try {
        const stat = statSync(filePath);
        if (stat.isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const body = readFileSync(filePath);
          // vite 产物带内容 hash → 长缓存；index.html 不缓存（SPA 更新即时生效）
          const cacheable = /^\/assets\//.test(pathname);
          // v3.5 审计修复：令牌只注入 index.html（注释声称"唯一载体"但实现注入所有
          // .html——未来任何多页 .html 都会带上可读令牌；窄化注入面）
          const isIndexHtml = ext === ".html" && path.basename(filePath) === "index.html";
          const nonce = randomUUID().replace(/-/g, "");
          const injected = isIndexHtml ? Buffer.from(injectToken(body.toString("utf-8"), nonce), "utf-8") : body;
          return c.body(injected, 200, {
            "content-type": MIME[ext] ?? "application/octet-stream",
            "cache-control": cacheable ? "public, max-age=31536000, immutable" : "no-cache",
            // v4.0 审计修复（M12）：安全响应头——X-Frame-Options 防 iframe 点击劫持
            // （webview 内恶意页 iframe 嵌入 InFu UI 的路径）、CSP frame-ancestors 同防、
            // nosniff 防 MIME 嗅探、no-referrer 防 URL 泄漏（token 在 query 的场景）
            // v4.0 补 1：index.html 的 CSP 带响应级 nonce（放行令牌注入脚本）
            "x-frame-options": "DENY",
            "content-security-policy": buildCsp(isIndexHtml, nonce),
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          });
        }
      } catch { /* 文件不存在 → SPA fallback */ }
      // SPA fallback：非文件请求回 index.html（仅 HTML 请求；资源请求 404 防误回）
      if (!pathname.includes(".")) {
        try {
          const html = readFileSync(join(opts.staticDir!, "index.html"));
          const nonce = randomUUID().replace(/-/g, "");
          return c.html(injectToken(html.toString("utf-8"), nonce), 200, {
            "cache-control": "no-cache",
            "x-frame-options": "DENY",
            "content-security-policy": buildCsp(true, nonce),
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          });
        } catch { /* 无 index.html → 404 */ }
      }
      return c.notFound();
    });
  }

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
    console.log(`[infu-agent]    或编辑 ${configPath()} 填入 apiKey（或用环境变量 INFU_<供应商>_API_KEY）`);
  }
  if (!withBaseURL.length) {
    console.log(`[infu-agent] ⚠️ 自定义端点模型缺少 baseURL`);
  }
}

/** 启动服务（端口被占用时自动递增重试） */
export function startServer(opts: ServerOptions = {}) {
  // 审计修复：进程级异常兜底——此前全库无 uncaughtException/unhandledRejection
  // 处理：lsp.ts 的 stdin EPIPE（tsserver 崩溃）等事件型错误会一击杀死整个服务进程
  // （Node 24 下 unhandledRejection 默认抛异常退出）。挂兜底记录日志不退出——
  // 业务错误各调用方均有 try/catch，此处仅拦截漏网的非致命异常（EPIPE/偶发 rejection）。
  const crashLog = (type: string, err: unknown) => {
    try {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.error(`[infu-agent] ${type}（已捕获，服务继续运行）: ${msg}`);
    } catch { /* 兜底自身失败忽略 */ }
  };
  process.on("uncaughtException", (err) => crashLog("uncaughtException", err));
  process.on("unhandledRejection", (reason) => crashLog("unhandledRejection", reason));
  const host = opts.host ?? "127.0.0.1";
  const basePort = opts.port ?? 4317;
  const localToken = opts.localToken ?? process.env.INFU_LOCAL_TOKEN ?? randomUUID().replace(/-/g, "");
  const app = createApp({ ...opts, localToken });
  let httpServer: ReturnType<typeof createServer> | null = null;
  // v3.1：启动时清理上次残留的 running 会话（服务重启后旧任务已死，防续跑被误拦）
  try {
    getStore().resetStaleRunning();
  } catch {
    /* DB 未就绪忽略 */
  }
  try { cleanupRecovery(); } catch { /* recovery 目录未就绪忽略 */ }
  // v3.5 常规设置：自动归档旧会话（general.autoArchive + archiveRetentionDays，默认关/7 天）
  // 启动时执行一次——超期未活动的非归档会话移入归档（不删除，侧栏「归档」可恢复）
  try {
    const g = loadConfig()?.general;
    if (g?.autoArchive === true) {
      const days = Math.max(1, Math.min(365, g.archiveRetentionDays ?? 7));
      const cutoff = Date.now() - days * 24 * 3600 * 1000;
      const store = getStore();
      for (const s of store.listSessions(1000, false)) {
        if (!s.updatedAt || s.updatedAt < cutoff) {
          try { store.setArchived(s.id, true); } catch { /* 单个失败跳过 */ }
        }
      }
    }
    // v5.0（A4）：归档事件压缩（显式选项，默认关）——超期归档会话的事件压缩为
    // 「摘要 + 最近 200 条」，控制会话库长期膨胀；开启即接受「继续被压缩会话时
    // 早期历史为摘要」的语义（rebuild 兼容）
    if (g?.compressArchivedEvents === true) {
      const days = Math.max(7, Math.min(365, g.compressArchivedAfterDays ?? 30));
      const cutoff = Date.now() - days * 24 * 3600 * 1000;
      const store = getStore();
      let compressed = 0;
      for (const s of store.listSessions(1000, true)) {
        if (!s.updatedAt || s.updatedAt >= cutoff) continue;
        try {
          const r = store.compressSessionEvents(s.id, 200);
          if (r) compressed++;
        } catch { /* 单个失败跳过 */ }
      }
      if (compressed > 0) console.log(`[infu-agent] 归档事件压缩：${compressed} 个会话已压缩（general.compressArchivedEvents）`);
    }
  } catch {
    /* 归档/压缩失败不影响启动 */
  }

  const tryListen = (port: number, attemptsLeft: number) => {
    const server = createServer((incoming, outgoing) => void handleNodeRequest(app, incoming, outgoing));
    // v5.0：记录 server 供调用方关闭（E2E 测试用；startServer 返回 httpServer）
    httpServer = server;
    server.listen(port, host, () => {
      const address = server.address();
      const listeningPort = typeof address === "object" && address ? address.port : port;
      console.log(`[infu-agent] 服务已启动: http://${host}:${listeningPort}`);
      console.log(`[infu-agent] 工具数: ${Object.keys(TOOLS).length}`);
      checkConfigHealth();
      opts.onListening?.(listeningPort, localToken);
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

  // ── v3.0 批 11 定时任务调度器（无人值守 = 等价 CLI -y：low/medium 自动批准，
  //    requireExplicit 安全红线（联网/自注册）一律拒绝，绝不自动放行）──
  try {
    const { startScheduler } = _require("./schedule.js");
    const { runScheduledTask } = _require("./scheduler-runner.js");
    startScheduler(runScheduledTask);
    console.log("[infu-agent] 定时任务调度器已启动（infu schedule add 添加）");
  } catch (e) {
    console.log(`[infu-agent] 定时任务调度器启动跳过: ${(e as Error).message}`);
  }

  // v5.0：返回 HTTP server（调用方 close() 用——E2E 测试/桌面宿主可精确控制生命周期）
  return httpServer;
}

// 直接运行时入口：tsx src/server.ts / node dist/server.js
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer();
}
