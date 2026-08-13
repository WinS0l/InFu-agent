#!/usr/bin/env node
/**
 * InFu Agent CLI — 端到端演示与调试入口
 *
 * 用法：
 *   infu "任务描述" [--root <项目路径>] [--model <模型id>] [-y]
 *   infu config     交互式配置模型与 API Key（推荐小白使用）
 *   infu --setup    生成模型配置模板（JSON）
 *
 * 模型配置：~/.infu/config.json（见 README）
 */

import { resolve, dirname } from "node:path";
import { writeFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, InfuConfig, ModelConfig, ProviderKind } from "@infu/shared";
import { loadConfig, saveConfig, resolveModel, resolveFallbackModels, resolveRoleModel, toRuntimeModel, CONFIG_PATH } from "./providers/registry.js";
import { TOOLS } from "./tools/index.js";
import { runAgent, makeApprovalHandler, DEFAULT_SYSTEM_PROMPT } from "./agent/loop.js";
import { sanitizeEnv } from "./sandbox/index.js";
import { runOrchestratedTask } from "./agent/orchestrator.js";
import { runBestOfN, formatComparison } from "./best-of-n.js";
import { findTemplate, renderTemplate } from "./templates.js";
import { getStore } from "./db/store.js";
import { rebuildMessages } from "./db/rebuild.js";
import { inferResumePhase } from "./agent/resume.js";
import { resolveApprovalPolicy, shouldAutoApprove } from "./approval/policy.js";
import { loadMcpTools, withMcpTools } from "./mcp/index.js";
import { mcpCli } from "./mcp/cli.js";
import { loadPlugins, withPlugins } from "./plugin/index.js";
import { listSkills, buildSkillsPrompt } from "./plugin/skills.js";
import { pluginCli, skillCli } from "./plugin/cli.js";
import type { ChatMessageLike } from "./providers/chat.js";

const require = createRequire(import.meta.url);

// ── 终端着色 ──
const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

function printEvent(e: AgentEvent, prefix = "") {
  const P = prefix ? `${prefix} ` : "";
  switch (e.type) {
    case "phase-start":
      console.error(C.green(`\n${P}◆ 阶段：${e.label}（${e.phase}）${e.model ? C.dim(`模型=${e.model}`) : ""}`));
      break;
    case "tool-start":
      console.error(C.cyan(`\n${P}⚙ [${e.tool}]`) + C.dim(` risk=${e.risk} args=${JSON.stringify(e.args).slice(0, 120)}`));
      break;
    case "tool-result":
      console.error(C.dim(`   ${P}↳ ${e.ok ? "✓" : "✗"} ${e.summary.replace(/\n/g, " ").slice(0, 150)}`));
      break;
    case "approval-required":
      console.error(C.yellow(`\n${P}🔒 审批请求 [${e.risk}]：${e.description}`));
      break;
    case "approval-result":
      console.error(C.dim(`   ${P}↳ 审批结果：${e.approved ? "已批准" : "已拒绝"}`));
      break;
    case "review":
      console.error(C.green(`\n${P}◆ 审查意见：\n${e.content}`));
      break;
    case "model-fallback":
      console.error(C.yellow(`\n${P}⚠ 模型降级：${e.from} → ${e.to}（${e.reason}）`));
      break;
    case "context-compressed":
      console.error(C.dim(`\n${P}↻ 上下文压缩：${e.before} → ${e.after} tokens（历史已摘要，原内容在会话记录中）`));
      break;
    case "error":
      console.error(C.red(`\n${P}✗ ${e.message}`));
      break;
  }
}

/** 默认审批：CLI 交互（-y 自动批准；v2.4 档位 config.approvalPolicy.mode；联网放行等 requireExplicit 场景 -y 也不自动放行，一律拒绝）
 *  统一走 getLines() 单一 readline——避免与 ask() 双实例抢 stdin（v2.3 附加指示被吞的根因） */
function makeDecider(autoApprove: boolean) {
  // v2.4 审批档位（guard 层对内置工具已按档位拦截，此处兜底 MCP/插件工具直调 requestApproval 的路径）
  const policy = resolveApprovalPolicy(loadConfig());
  return async (
    description: string,
    risk: "low" | "medium" | "high",
    requireExplicit?: boolean
  ) => {
    if (requireExplicit) {
      if (autoApprove) return false; // 联网必须人工确认，自动批准模式不适用
    } else if (autoApprove || shouldAutoApprove(policy, risk) === true) {
      return true;
    }
    process.stderr.write(C.yellow(`  是否允许（y/n，默认 n）？`));
    const ans = await getLines().next().then((r) => r.value ?? "");
    return /^y/i.test(ans.trim());
  };
}

const TEMPLATE = `{
  "defaultModelId": "deepseek-v4-flash",
  "models": [
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "provider": "deepseek",
      "model": "deepseek-v4-flash"
    },
    {
      "id": "gpt-5.6-luna",
      "name": "GPT-5.6 Luna",
      "provider": "openai",
      "model": "gpt-5.6-luna"
    },
    {
      "id": "claude-sonnet-5",
      "name": "Claude Sonnet 5",
      "provider": "anthropic",
      "model": "claude-sonnet-5"
    },
    {
      "id": "gemini-3.6-flash",
      "name": "Gemini 3.6 Flash",
      "provider": "google",
      "model": "gemini-3.6-flash"
    },
    {
      "id": "glm-5.2",
      "name": "智谱 GLM-5.2",
      "provider": "zhipu",
      "model": "glm-5.2"
    },
    {
      "id": "qwen3-coder",
      "name": "通义 Qwen3-Coder",
      "provider": "qwen",
      "model": "qwen3-coder"
    },
    {
      "id": "kimi-k3",
      "name": "Kimi K3",
      "provider": "custom",
      "model": "kimi-k3",
      "baseURL": "https://api.moonshot.cn/v1"
    },
    {
      "id": "local-qwen",
      "name": "本地模型（Ollama）",
      "provider": "ollama",
      "model": "qwen3:8b"
    }
  ]
}
`;

// ── 交互式配置向导 ──
const PROVIDER_MENU: Array<{ kind: ProviderKind; label: string; hint: string; defaultModel?: string; defaultBaseURL?: string }> = [
  { kind: "deepseek", label: "DeepSeek（推荐，便宜好用）", hint: "模型如 deepseek-v4-flash", defaultModel: "deepseek-v4-flash" },
  { kind: "openai", label: "OpenAI（GPT-5.6 系列）", hint: "模型如 gpt-5.6-luna / gpt-5.6-sol", defaultModel: "gpt-5.6-luna" },
  { kind: "anthropic", label: "Anthropic（Claude 5）", hint: "模型如 claude-sonnet-5 / claude-opus-5", defaultModel: "claude-sonnet-5" },
  { kind: "google", label: "Google（Gemini 3.6）", hint: "模型如 gemini-3.6-flash", defaultModel: "gemini-3.6-flash" },
  { kind: "zhipu", label: "智谱 GLM（国产）", hint: "模型如 glm-5.2", defaultModel: "glm-5.2", defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4" },
  { kind: "qwen", label: "通义千问（阿里）", hint: "模型如 qwen3-coder / qwen3.8-max", defaultModel: "qwen3-coder", defaultBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { kind: "ollama", label: "本地模型（Ollama，免费）", hint: "需先安装 Ollama，模型如 qwen3:8b", defaultModel: "qwen3:8b", defaultBaseURL: "http://localhost:11434/v1" },
  { kind: "custom", label: "自定义端点（任意 OpenAI 兼容服务）", hint: "如 Kimi / MiniMax / One API / vLLM", defaultBaseURL: "" },
];

// 行迭代器（async generator：对 TTY 与管道输入都健壮）
let linesGen: AsyncGenerator<string> | null = null;
function getLines(): AsyncGenerator<string> {
  if (!linesGen) {
    linesGen = (async function* () {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin });
      for await (const line of rl) yield line;
      rl.close();
    })();
  }
  return linesGen;
}
function ask(question: string, def?: string): Promise<string> {
  process.stderr.write(def ? `${question}（默认 ${def}）: ` : `${question}: `);
  return getLines()
    .next()
    .then((r) => r.value?.trim() || def || "");
}

async function configWizard() {
  const cfg = loadConfig() ?? { models: [], providers: [] };
  let exit = false;

  while (!exit) {
    console.log(C.cyan(`\n═══ InFu 模型配置（v2：供应商凭据 + 模型）═══`));
    const providers = cfg.providers ?? [];
    if (providers.length) {
      console.log(C.dim("  供应商："));
      providers.forEach((p, i) => {
        console.log(C.dim(`  ${i + 1}.`), `${p.name}（${p.kind}${p.baseURL ? " · " + p.baseURL : ""}）${p.apiKey ? C.green(" 已配Key") : C.yellow(" 无Key")}`);
      });
    } else {
      console.log(C.dim("  暂无供应商（先 [p] 添加供应商）"));
    }
    if (cfg.models.length) {
      console.log(C.dim("  模型："));
      cfg.models.forEach((m, i) => {
        const isDefault = m.id === cfg.defaultModelId ? C.green(" ★默认") : "";
        console.log(C.dim(`  · ${i + 1}.`), `${m.name}（${m.model} → ${m.providerId ?? m.provider ?? "?"}）${isDefault}`);
      });
    }
    console.log(C.dim("\n  [p] 添加供应商   [a] 添加模型   [s] 设置默认   [d] 删除   [k] 修改 API Key   [q] 退出"));
    const choice = (await ask("请选择")).toLowerCase();

    if (choice === "q") { exit = true; break; }

    if (choice === "p") {
      console.log(C.dim("\n  选择供应商类型："));
      PROVIDER_MENU.forEach((p, i) => console.log(C.dim(`  ${i + 1}.`), p.label));
      const pi = parseInt(await ask("供应商编号"), 10) - 1;
      const p = PROVIDER_MENU[pi];
      if (!p) { console.log(C.red("  无效编号")); continue; }

      const name = await ask("显示名称", p.label.split("（")[0]);
      let baseURL = p.defaultBaseURL ?? "";
      if (p.kind === "custom" || !baseURL) {
        baseURL = await ask("API 地址（baseURL，OpenAI 兼容端点，通常以 /v1 结尾）", baseURL);
        if (baseURL && !/\/v\d+$/.test(baseURL)) {
          const fixed = (baseURL.endsWith("/") ? baseURL : baseURL + "/") + "v1";
          const ok = await ask(`地址未以 /v1 结尾，自动补全为 "${fixed}"？`, "y");
          if (!/^n/i.test(ok)) baseURL = fixed;
        }
      }
      const apiKey = await ask("API Key（没有可留空，用环境变量）");
      const pid = (await ask("供应商标识（英文，如 deepseek）", p.kind)).replace(/\s+/g, "-");
      if (providers.some((x) => x.id === pid)) { console.log(C.red(`  供应商 "${pid}" 已存在`)); continue; }
      providers.push({ id: pid, name, kind: p.kind, ...(baseURL ? { baseURL } : {}), ...(apiKey ? { apiKey } : {}) });
      cfg.providers = providers;
      saveConfig(cfg);
      console.log(C.green(`  ✅ 已添加供应商 ${name}（${pid}）`));
    } else if (choice === "a") {
      if (!providers.length) { console.log(C.red("  请先 [p] 添加供应商")); continue; }
      console.log(C.dim("\n  选择供应商："));
      providers.forEach((p, i) => console.log(C.dim(`  ${i + 1}.`), `${p.name}（${p.id}）`));
      const pi = parseInt(await ask("供应商编号"), 10) - 1;
      const p = providers[pi];
      if (!p) { console.log(C.red("  无效编号")); continue; }

      const name = await ask("显示名称");
      const model = await ask("模型 ID（上游模型名，如 deepseek-v4-flash）");
      const id = (await ask("模型标识（英文，用于 --model 指定）", model.split(":")[0])).replace(/\s+/g, "-");
      if (cfg.models.some((x) => x.id === id)) { console.log(C.red(`  模型 "${id}" 已存在`)); continue; }

      const m: ModelConfig = { id, name, providerId: p.id, model };
      cfg.models.push(m);
      if (!cfg.defaultModelId) cfg.defaultModelId = m.id;
      saveConfig(cfg);
      console.log(C.green(`  ✅ 已添加模型 ${name}（${model} → ${p.id}）`));
    } else if (choice === "s") {
      if (!cfg.models.length) { console.log(C.red("  请先添加模型")); continue; }
      cfg.models.forEach((m, i) => console.log(C.dim(`  ${i + 1}.`), `${m.name}（${m.id}）`));
      const si = parseInt(await ask("设为默认的编号"), 10) - 1;
      const m = cfg.models[si];
      if (!m) { console.log(C.red("  无效编号")); continue; }
      cfg.defaultModelId = m.id;
      saveConfig(cfg);
      console.log(C.green(`  ✅ 默认模型已设为 ${m.name}`));
    } else if (choice === "d") {
      if (!cfg.models.length) { console.log(C.red("  没有可删除的模型")); continue; }
      cfg.models.forEach((m, i) => console.log(C.dim(`  ${i + 1}.`), `${m.name}（${m.id}）`));
      const di = parseInt(await ask("删除的编号（0 取消）"), 10) - 1;
      if (di < 0) continue;
      const m = cfg.models[di];
      if (!m) { console.log(C.red("  无效编号")); continue; }
      cfg.models = cfg.models.filter((x) => x.id !== m.id);
      if (cfg.defaultModelId === m.id) cfg.defaultModelId = cfg.models[0]?.id;
      saveConfig(cfg);
      console.log(C.green(`  ✅ 已删除 ${m.name}`));
    } else if (choice === "k") {
      const providers = cfg.providers ?? [];
      if (!providers.length) { console.log(C.red("  请先添加供应商")); continue; }
      providers.forEach((p, i) => console.log(C.dim(`  ${i + 1}.`), `${p.name}（${p.id}）${p.apiKey ? " 已配Key" : " 无Key"}`));
      const ki = parseInt(await ask("要修改 Key 的供应商编号"), 10) - 1;
      const p = providers[ki];
      if (!p) { console.log(C.red("  无效编号")); continue; }
      const key = await ask(`输入 ${p.name} 的新 API Key`);
      if (key) { p.apiKey = key; cfg.providers = providers; saveConfig(cfg); console.log(C.green("  ✅ API Key 已更新")); }
      else console.log(C.red("  Key 不能为空"));
    } else {
      console.log(C.red("  无效输入"));
    }
  }
  console.log(C.dim(`\n配置保存在：${CONFIG_PATH}`));
}
async function main() {
  const args = process.argv.slice(2);


  if (args[0] === "mcp") {
    mcpCli(args.slice(1)).catch((e) => console.error(C.red(`\n✗ mcp: ${e.message}`)));
    return;
  }

  if (args[0] === "plugin") {
    pluginCli(args.slice(1)).catch((e) => console.error(C.red(`\n✗ plugin: ${e.message}`)));
    return;
  }

  if (args[0] === "skill") {
    skillCli(args.slice(1)).catch((e) => console.error(C.red(`\n✗ skill: ${e.message}`)));
    return;
  }

  if (args[0] === "config") {
    configWizard().catch((e) => console.error(C.red(`\n✗ 配置失败: ${e.message}`)));
    return;
  }

  if (args.includes("--setup")) {
    mkdirSync(join(homedir(), ".infu"), { recursive: true });
    if (!existsSync(CONFIG_PATH)) {
      writeFileSync(CONFIG_PATH, TEMPLATE, "utf-8");
      console.log(`已生成模型配置模板：${CONFIG_PATH}`);
      console.log("请填入你的 API Key（apiKey 字段，或设置环境变量 INFU_<PROVIDER>_API_KEY）");
    } else {
      console.log(`配置已存在：${CONFIG_PATH}`);
    }
    return;
  }

  // 会话历史（v2.1 持久化）
  if (args[0] === "sessions") {
    const list = getStore().listSessions(50);
    if (!list.length) {
      console.log("暂无会话历史（运行 infu \"任务描述\" 开始第一个任务）");
      return;
    }
    console.log(C.cyan(`\n═══ InFu 会话历史（${list.length}）═══`));
    list.forEach((s, i) => {
      const st =
        s.status === "done" ? C.green("done") : s.status === "error" ? C.red("error") : C.yellow(s.status);
      const t = new Date(s.updatedAt).toLocaleString("zh-CN", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      });
      console.log(` ${String(i + 1).padStart(2)}. ${s.title}`);
      console.log(`     ${st} · ${t} · ${s.promptCount} 轮 ${s.toolCount} 工具 · ${s.root}`);
      console.log(C.dim(`     id: ${s.id}`));
    });
    console.log(C.dim(`\n继续会话：infu --session <id> "你的指令"`));
    return;
  }

  const getArg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // --fallback-model 可重复指定（主模型失败时依次切换）
  const getRepeatedArgs = (name: string): string[] =>
    args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
  // 任务 prompt 提取：跳过全部参数（带值参数连同其值，开关单独跳过）——顺带修复参数值混入 prompt 的既有问题
  const VALUE_ARGS = new Set(["--root", "--model", "--fallback-model", "--max-steps", "--template", "--best-of-n", "--session", "--thinking",
    "--planner-model", "--executor-model", "--reviewer-model"]);
  const FLAG_ONLY = new Set(["-y", "--yes", "--suggest", "--no-orchestrate", "--no-plan-approval"]);
  let prompt = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_ARGS.has(a)) { i++; continue; }
    if (a.startsWith("--") || FLAG_ONLY.has(a)) continue;
    prompt += (prompt ? " " : "") + a;
  }
  const rootArg = getArg("--root");
  let root = resolve(rootArg || process.cwd());
  const modelId = getArg("--model");
  const fallbackModelIds = getRepeatedArgs("--fallback-model");
  // v2.2 轻量模型选择：按角色指定模型（--planner-model / --executor-model / --reviewer-model）
  const roleModelIds = {
    planner: getArg("--planner-model"),
    executor: getArg("--executor-model"),
    reviewer: getArg("--reviewer-model"),
  };
  const maxSteps = parseInt(getArg("--max-steps") || "", 10) || undefined;
  const thinkingLevel = parseInt(getArg("--thinking") || "", 10) || undefined;
  const autoApprove = args.includes("-y") || args.includes("--yes");
  const suggestOnly = args.includes("--suggest");
  const orchestrate = args.includes("--no-orchestrate") ? "off" : "full";
  const planApproval = !args.includes("--no-plan-approval");
  const templateId = getArg("--template");
  const bestOfN = parseInt(getArg("--best-of-n") || "", 10) || 0;

  // 模板任务：--template <id> 用模板 prompt 代替手动输入（字段用默认值）
  if (templateId) {
    const tpl = findTemplate(templateId);
    if (!tpl) {
      console.error(C.red(`未知模板：${templateId}（可用：init-project / fix-tests / analyze / add-feature）`));
      process.exit(1);
    }
    prompt = renderTemplate(tpl, {});
    console.error(C.dim(`模板任务：${tpl.name} — ${tpl.description}`));
  }

  if (!prompt) {
    console.log(`InFu Agent CLI v0.1

用法：
  infu config   ★ 交互式配置模型与 API Key（推荐）
  infu "任务描述" [--root <项目路径>] [--model <模型id>] [-y]
  infu sessions 会话历史（每次任务自动保存，可继续）
  infu mcp add/list/remove/status   MCP 服务器管理（v2.3：工具动态注入执行阶段）
  infu plugin add/list/remove/status   插件管理（v2.3 批 2：JS 模块 = 工具/钩子/技能）
  infu skill add/list/remove       技能管理（SKILL.md 社区标准）
  infu --session <id> "继续的指令"   继续之前的会话（消息级重建：完整恢复历史与进度）
  infu --setup   生成模型配置模板（JSON）
  infu --suggest 建议模式（模型只出方案，不执行工具）

模型可靠性（v2.2）：
  infu "任务" --fallback-model <id> [--fallback-model <id>...]  备用模型降级链（主模型失败自动切换）
  infu "任务" --planner-model <id> --executor-model <id> --reviewer-model <id>  按角色指定模型（规划/执行/审查）
  infu "任务" --thinking <1-4>  思考级别（按模型实际级别数自动映射；1 快速 ~ 4 极限）

分层编排（M4，默认开启 Planner→Executor→Reviewer）：
  infu --template init-project  模板任务：初始化新项目
  infu --template fix-tests     模板任务：修复测试失败
  infu --template analyze       模板任务：分析项目
  infu --template add-feature   模板任务：添加新功能
  infu "任务" --no-orchestrate  关闭分层编排（单 Agent 直跑）
  infu "任务" --no-plan-approval 不要求确认计划，直接执行

示例：
  infu config
  infu "分析这个项目的技术栈和结构" --root .
  infu "修复 README 里的拼写错误" --root . -y
  infu --template fix-tests --root . -y`);
    return;
  }

  const config = loadConfig();
  const modelCfg = resolveModel(config, modelId);
  // v2.2 降级链：显式 --fallback-model 优先，否则用模型自身 fallbackModelIds（未知 id 警告）
  const fallbackModels = resolveFallbackModels(config, modelCfg, fallbackModelIds);
  for (const id of fallbackModelIds) {
    if (!fallbackModels.some((m) => m.id === id)) {
      console.error(C.yellow(`⚠ 备用模型 "${id}" 未找到或无效（忽略），可用: ${config?.models.map((m) => m.id).join(", ")}`));
    }
  }
  // v2.2 角色路由：各角色独立模型 + 各自降级链（未指定角色 → 默认模型）
  const roleModelConfigs = {} as Record<string, { modelConfig: ReturnType<typeof toRuntimeModel>; fallbackModelConfigs: ReturnType<typeof toRuntimeModel>[] }>;
  for (const phase of ["planner", "executor", "reviewer"] as const) {
    const explicitId = roleModelIds[phase];
    const rm = resolveRoleModel(config, modelCfg, phase, explicitId);
    if (explicitId && rm.id !== explicitId) {
      console.error(C.yellow(`⚠ 角色模型 "${explicitId}"（${phase}）未找到，回退默认模型`));
    }
    roleModelConfigs[phase] = {
      modelConfig: toRuntimeModel(config, rm),
      fallbackModelConfigs: resolveFallbackModels(config, rm).map((m) => toRuntimeModel(config, m)),
    };
  }
  const decide = makeDecider(autoApprove);

  // ── v2.1 会话（自动落库；--session 继续会话）──
  const store = getStore();
  let sessionId: string | undefined;
  // v2.2 断点恢复：继续会话 = 从事件流重建完整 messages（工具结果直接来自 DB，不重放副作用）
  let initialMessages: ChatMessageLike[] | undefined;
  // v2.3 阶段级精确续跑：已确认过计划的会话 → 跳过规划阶段（executor 起点）
  let resumePoint: ReturnType<typeof inferResumePhase> = {};
  let effectivePrompt = prompt;
  if (bestOfN) {
    console.error(C.dim("（/best-of-n 并行模式不写入会话历史）"));
  } else {
    const sessionArg = getArg("--session");
    if (sessionArg) {
      const s = store.getSession(sessionArg);
      if (!s) {
        console.error(C.red(`会话不存在：${sessionArg}（可用 infu sessions 查看）`));
        process.exit(1);
      }
      sessionId = sessionArg;
      if (!rootArg) root = s.root; // 继续会话：沿用历史项目目录
      initialMessages = rebuildMessages(store.getEvents(sessionId));
      resumePoint = inferResumePhase(store.getEvents(sessionId));
      console.error(C.dim(`继续会话（消息级重建）：${s.title}（上次状态 ${s.status}，历史已完整恢复）`));
    } else {
      sessionId = store.createSession({
        title: prompt.slice(0, 40),
        root,
        modelId,
        mode: suggestOnly ? "ask" : orchestrate === "off" ? "direct" : "orchestrate",
      });
    }
    store.appendEvent(sessionId, { type: "user-message", text: prompt });
  }

  const emit = (e: AgentEvent) => {
    printEvent(e);
    if (sessionId) store.appendEvent(sessionId, e);
  };

  // v2.3 MCP 动态注入：仅非建议模式/非 best-of-n 加载（suggestOnly 不注入外部工具；
  // best-of-n 并行 worktree 场景不注入，保持 v1 简单）；任务结束后统一 close（防残留子进程）
  const mcp = suggestOnly || bestOfN ? null : await loadMcpTools(config?.mcpServers, emit);
  if (mcp) {
    if (mcp.tools.length) console.error(C.green(`MCP 工具已注入：${mcp.tools.length} 个（仅执行阶段可用，默认 medium 审批）`));
    for (const f of mcp.failures) console.error(C.yellow(`⚠ MCP 服务器连接失败（已跳过）：${f.message.slice(0, 120)}`));
  }
  // v2.3 批 2 插件（JS 模块：工具/钩子/技能）+ skill 发现层描述注入
  const plugin = suggestOnly || bestOfN ? null : await loadPlugins(config?.plugins, emit);
  if (plugin) {
    if (plugin.tools.length) console.error(C.green(`插件工具已注入：${plugin.tools.length} 个（仅执行阶段可用）`));
    if (plugin.hooks.preToolUse.length || plugin.hooks.postToolUse.length) {
      console.error(C.dim(`插件钩子已挂载：pre=${plugin.hooks.preToolUse.length} post=${plugin.hooks.postToolUse.length}`));
    }
    for (const f of plugin.failures) console.error(C.yellow(`⚠ 插件加载失败（已跳过）：${f.message.slice(0, 120)}`));
  }
  const skillsPrompt = buildSkillsPrompt(listSkills(config, root));
  if (resumePoint.startPhase) {
    console.error(C.dim("↻ 阶段级续跑：历史中已有确认过的计划，跳过规划阶段，直接从执行阶段继续"));
  }

  // Ctrl+C：中止 Agent 并将会话标记 stopped（进度保留，可继续）
  const abortController = new AbortController();
  process.once("SIGINT", () => {
    abortController.abort();
    if (sessionId && store.getSession(sessionId)?.status === "running") {
      store.updateStatus(sessionId, "stopped");
      console.error(C.yellow("\n（已停止任务，进度已保存，可用 infu --session 继续）"));
    }
  });

  /** 任务收尾：标记状态 + 打印会话 ID */
  const finishSession = (status: "done" | "error") => {
    if (!sessionId) return;
    store.updateStatus(sessionId, status);
    console.error(C.dim(`\n会话已保存：${sessionId}（查看/继续：infu sessions / infu --session ${sessionId} "指令"）`));
  };

  console.error(C.dim(`模型: ${modelCfg.name} (${modelCfg.provider}/${modelCfg.model})`));
  // v2.2 角色路由：任一角色与默认模型不同时提示
  const roleHints = (["planner", "executor", "reviewer"] as const)
    .filter((p) => roleModelConfigs[p].modelConfig.model !== toRuntimeModel(config, modelCfg).model)
    .map((p) => `${p}=${roleModelConfigs[p].modelConfig.model}`);
  if (roleHints.length) console.error(C.dim(`角色模型: ${roleHints.join(" · ")}`));
  console.error(C.dim(`项目: ${root}`));
  console.error(C.dim(`审批: ${autoApprove ? "自动批准" : "交互确认"}${suggestOnly ? " | 建议模式" : ""}${orchestrate === "off" ? "" : " | 分层编排 " + (orchestrate === "full" ? "(Planner→Executor→Reviewer)" : "(Planner→Executor)")}${orchestrate === "off" || suggestOnly ? "" : planApproval ? " | 计划需确认" : " | 计划不确认"}${bestOfN ? ` | /best-of-n ×${bestOfN}` : ""}${sessionId ? " | 会话已记录" : ""}`));
  console.error(C.dim(`工具: ${Object.keys(TOOLS).length} 个\n`));

  const common = {
    modelConfig: toRuntimeModel(config, modelCfg),
    fallbackModelConfigs: fallbackModels.map((m) => toRuntimeModel(config, m)),
    roleModelConfigs,
    initialMessages,
    thinkingLevel,
    prompt: effectivePrompt,
    root,
    emit,
    requestApproval: makeApprovalHandler(emit, decide),
    maxSteps,
  };

  // /best-of-n 并行尝试：N 路独立 worktree + 评分择优（计划确认自动关闭）
  if (bestOfN) {
    if (suggestOnly || orchestrate === "off") {
      console.error(C.red("--best-of-n 与 --suggest/--no-orchestrate 不能同时使用（并行的是完整编排）"));
      process.exit(1);
    }
    if (!autoApprove) {
      console.error(C.yellow("提示：/best-of-n 并行模式下计划确认已关闭；建议加 -y 自动批准（否则审批将逐条询问）"));
    }
    console.error(C.yellow(`⚠  /best-of-n 将消耗 ${bestOfN} 倍 token`));
    runBestOfN({ n: bestOfN, ...common, abortSignal: abortController.signal })
      .then((r) => {
        process.stdout.write(formatComparison(r) + "\n");
      })
      .catch((e) => {
        console.error(C.red(`\n✗ /best-of-n 运行失败: ${e.message}`));
        process.exit(1);
      });
    return;
  }

  // 建议模式 / 关闭编排：直跑单 Agent（保持一期行为；suggestOnly 不注入 MCP/插件工具）
  if (suggestOnly || orchestrate === "off") {
    runAgent({
      ...common,
      system: DEFAULT_SYSTEM_PROMPT + skillsPrompt,
      tools: mcp || plugin ? withPlugins(withMcpTools(TOOLS, mcp?.tools ?? []), plugin?.tools ?? []) : TOOLS,
      hooks: plugin?.hooks,
      suggestOnly,
      abortSignal: abortController.signal,
    })
      .then((r) => {
        process.stdout.write("\n" + r.text + "\n");
        finishSession("done");
      })
      .catch((e) => {
        finishSession("error");
        console.error(C.red(`\n✗ Agent 运行失败: ${e.message}`));
        process.exit(1);
      })
      .finally(() => mcp?.close());
    return;
  }

  // v2.3 计划确认：交互输入回复文本（直接回车 = 批准执行；输入内容由 AI 判断 execute/revise/abort）
  // -y 自动批准时直接通过；要取消输入"取消/先不做"（判为 abort）
  const cliConfirmPlan = async (planText: string) => {
    if (autoApprove) return { plan: undefined, feedback: "批准执行" };
    console.error(C.cyan("\n【执行计划】请确认："));
    console.error(planText.slice(0, 2000));
    const feedback = await ask("你的回复（直接回车=批准执行；或输入意见/先不做/修改计划…）");
    return { plan: undefined, feedback: feedback.trim() || "批准执行" };
  };

  runOrchestratedTask({
    ...common,
    orchestrate,
    planApproval,
    templateId,
    confirmPlan: cliConfirmPlan,
    abortSignal: abortController.signal,
    // v2.3：MCP 工具 + 插件工具只进 Executor（Planner/Reviewer 架构级只读不暴露）；
    // 插件钩子随 Executor 生效；skill 描述注入 Executor system；
    // 阶段级续跑：跳过已完成的规划阶段（计划沿用上次确认的）
    executorTools: [...(mcp?.tools ?? []), ...(plugin?.tools ?? [])],
    hooks: plugin?.hooks,
    skillsPrompt,
    startPhase: resumePoint.startPhase,
    resumePlanText: resumePoint.planText,
  })
    .then((r) => {
      process.stdout.write("\n" + r.text + "\n");
      finishSession("done");
    })
    .catch((e) => {
      finishSession("error");
      console.error(C.red(`\n✗ Agent 运行失败: ${e.message}`));
      process.exit(1);
    })
    .finally(() => mcp?.close());
}

main().catch((e) => {
  console.error(C.red(`\n✗ 运行失败: ${e.message}`));
  process.exit(1);
});
