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
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelConfig, AgentEvent, RiskLevel, InfuConfig, OrchestrateMode } from "@infu/shared";
import { loadConfig, resolveApiKey, CONFIG_PATH } from "./providers/registry.js";
import { TOOLS } from "./tools/index.js";
import { runAgent, DEFAULT_SYSTEM_PROMPT } from "./agent/loop.js";
import { runOrchestratedTask } from "./agent/orchestrator.js";
import { TASK_TEMPLATES } from "./templates.js";

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

/** 模型配置持久化（安全写入） */
function saveConfig(cfg: InfuConfig) {
  mkdirSync(join(homedir(), ".infu"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}
function readConfigRaw(): InfuConfig {
  if (!existsSync(CONFIG_PATH)) return { models: [] };
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as InfuConfig;
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

/** API Key 脱敏 */
function maskSecret(s: string): string {
  if (s.length <= 8) return "****";
  return s.slice(0, 4) + "****" + s.slice(-4);
}

export function createApp(opts: ServerOptions = {}) {
  const app = new Hono();
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  // 计划确认挂起队列（M4 计划卡片：POST /api/plan/:id 决策）
  const pendingPlans = new Map<string, (d: { approved: boolean; plan?: string }) => void>();

  // 模型列表（脱敏）
  app.get("/api/models", (c) => {
    const cfg = loadConfig();
    const models = (cfg?.models ?? []).map((m: ModelConfig) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      model: m.model,
      baseURL: m.baseURL,
      hasKey: !!(m.apiKey || process.env[`INFU_${m.provider.toUpperCase()}_API_KEY`]),
      isDefault: m.id === cfg?.defaultModelId,
    }));
    return c.json({ models, configPath: CONFIG_PATH });
  });

  // 新增模型
  app.post("/api/models", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = readConfigRaw();
    const m: ModelConfig = {
      id: String(body.id || "").trim(),
      name: String(body.name || "").trim(),
      provider: String(body.provider || "custom") as ModelConfig["provider"],
      model: String(body.model || "").trim(),
    };
    if (!m.id || !m.name || !m.model) return c.json({ ok: false, message: "id/name/model 不能为空" }, 400);
    if (cfg.models.some((x) => x.id === m.id)) return c.json({ ok: false, message: `模型 id "${m.id}" 已存在` }, 409);
    if (body.baseURL) m.baseURL = String(body.baseURL);
    if (body.apiKey) m.apiKey = String(body.apiKey);
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
    if (typeof body.baseURL === "string") m.baseURL = body.baseURL || undefined;
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
      const root: string = body.root || opts.defaultRoot || process.cwd();
      const modelId: string | undefined = body.modelId;
      const maxSteps: number | undefined = typeof body.maxSteps === "number" ? body.maxSteps : undefined;
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
      });

      if (!prompt) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "prompt 不能为空" }) });
        return;
      }

      // 项目根目录校验：路径不存在/不是目录时直接报明确错误（避免 AI 根据工具报错瞎猜路径）
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: `项目根目录不存在或不是目录: ${root}（请检查输入框里的路径是否正确，使用绝对路径）` }),
        });
        return;
      }

      const config = loadConfig();
      const models = config?.models ?? [];
      if (!models.length) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "未配置模型，请先配置 ~/.infu/config.json" }) });
        return;
      }
      const modelCfg =
        (modelId ? models.find((m) => m.id === modelId && m.apiKey) ?? models.find((m) => m.id === modelId) : undefined) ||
        models.find((m) => m.apiKey) ||
        models[0];

      const emit = (e: AgentEvent) => {
        logEvent(e); // 后台日志（窗口 + 文件）
        stream.writeSSE({ event: "agent", data: JSON.stringify(e) }).catch(() => {});
      };

      // 审批：推送 approval-required 事件 → 挂 pending → 等待 POST /api/approvals/:id 决策
      // 连接中断（停止）时自动拒绝并释放
      const requestApproval = async (description: string, risk: RiskLevel, _requireExplicit?: boolean) => {
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

      // 计划确认（Web 计划卡片）：emit plan 事件 → 挂 pending → 等 POST /api/plan/:id
      // 连接中断（停止）时自动视为拒绝并释放
      const confirmPlan = async (planText: string) => {
        const id = randomUUID();
        emit({ type: "plan", id, content: planText });
        return new Promise<{ approved: boolean; editedPlan?: string }>((resolve) => {
          pendingPlans.set(id, (d) => resolve({ approved: d.approved, editedPlan: d.plan }));
          controller.signal.addEventListener(
            "abort",
            () => {
              if (pendingPlans.delete(id)) resolve({ approved: false });
            },
            { once: true }
          );
        });
      };

      try {
        const modelRun = {
          modelConfig: {
            provider: modelCfg.provider,
            model: modelCfg.model,
            baseURL: modelCfg.baseURL,
            apiKey: resolveApiKey(modelCfg),
          },
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
            });
        await stream.writeSSE({ event: "done", data: JSON.stringify({ final: final.text }) });
      } catch (e) {
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

  // 计划确认入口（Web 计划卡片：批准/拒绝，plan 为编辑后的计划文本）
  app.post("/api/plan/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const resolve = pendingPlans.get(id);
    if (!resolve) return c.json({ ok: false, message: "计划不存在或已过期" });
    pendingPlans.delete(id);
    resolve({
      approved: !!body.approved,
      plan: typeof body.plan === "string" ? body.plan : undefined,
    });
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
  const withKey = models.filter(
    (m) => m.apiKey || process.env[`INFU_${m.provider.toUpperCase()}_API_KEY`]
  );
  const withBaseURL = models.filter((m) => m.baseURL || m.provider !== "custom");
  const usable = withKey.filter((m) => m.baseURL || m.provider !== "custom");
  if (usable.length) {
    console.log(`[infu-agent] ✅ 模型就绪：${usable.map((m) => `${m.name}（${m.provider}/${m.model}）`).join("、")}`);
  } else {
    console.log(`[infu-agent] ⚠️ 已配置 ${models.length} 个模型，但均未设置 API Key！`);
    console.log(`[infu-agent]    配置方法：npm run config → 选 [k] 修改 API Key`);
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
    const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      console.log(`[infu-agent] 服务已启动: http://${host}:${info.port}`);
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
}

// 直接运行时入口：tsx src/server.ts / node dist/server.js
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer();
}
