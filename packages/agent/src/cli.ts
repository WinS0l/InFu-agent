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
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, InfuConfig, ModelConfig, ProviderKind } from "@infu/shared";
import { loadConfig, resolveModel, resolveApiKey, CONFIG_PATH } from "./providers/registry.js";
import { TOOLS } from "./tools/index.js";
import { runAgent, makeApprovalHandler, DEFAULT_SYSTEM_PROMPT } from "./agent/loop.js";
import { runOrchestratedTask } from "./agent/orchestrator.js";
import { runBestOfN, formatComparison } from "./best-of-n.js";
import { findTemplate, renderTemplate } from "./templates.js";

const require = createRequire(import.meta.url);
import {
  netStatus, netSetup, netRemove, netGrant, netIsElevated, installHelperTask, removeHelperTask,
  grantCurrentUserRights,
} from "./sandbox/sandbox-net.js";

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
      console.error(C.green(`\n${P}◆ 阶段：${e.label}（${e.phase}）`));
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
    case "error":
      console.error(C.red(`\n${P}✗ ${e.message}`));
      break;
  }
}

/** 默认审批：CLI 交互（-y 自动批准；联网放行等 requireExplicit 场景 -y 也不自动放行，一律拒绝） */
function makeDecider(autoApprove: boolean) {
  return async (
    description: string,
    risk: "low" | "medium" | "high",
    requireExplicit?: boolean
  ) => {
    if (requireExplicit) {
      if (autoApprove) return false; // 联网必须人工确认，自动批准模式不适用
    } else if (autoApprove) {
      return true;
    }
    const rl = await import("node:readline").then((m) =>
      m.createInterface({ input: process.stdin, output: process.stderr })
    );
    return new Promise<boolean>((resolve_) => {
      rl.question(C.yellow(`  是否允许（y/n，默认 n）？`), (ans) => {
        rl.close();
        resolve_(/^y/i.test(ans.trim()));
      });
    });
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

function saveConfig(cfg: InfuConfig) {
  mkdirSync(join(homedir(), ".infu"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

async function configWizard() {
  const cfg = loadConfig() ?? { models: [] };
  let exit = false;

  while (!exit) {
    console.log(C.cyan(`\n═══ InFu 模型配置 ═══`));
    if (!cfg.models.length) {
      console.log(C.dim("  当前没有配置任何模型"));
    } else {
      cfg.models.forEach((m, i) => {
        const isDefault = m.id === cfg.defaultModelId ? C.green(" ★默认") : "";
        console.log(C.dim(`  ${i + 1}.`), `${m.name}（${m.provider}/${m.model}）${isDefault}`);
      });
    }
    console.log(C.dim("\n  [a] 添加模型   [s] 设置默认   [d] 删除模型   [k] 修改 API Key   [q] 退出"));
    const choice = (await ask("请选择")).toLowerCase();

    if (choice === "q") { exit = true; break; }

    if (choice === "a") {
      console.log(C.dim("\n  选择供应商："));
      PROVIDER_MENU.forEach((p, i) => console.log(C.dim(`  ${i + 1}.`), p.label));
      const pi = parseInt(await ask("供应商编号"), 10) - 1;
      const p = PROVIDER_MENU[pi];
      if (!p) { console.log(C.red("  无效编号")); continue; }

      const name = await ask("显示名称", p.label.split("（")[0]);
      const model = await ask("模型 ID", p.defaultModel);
      let baseURL = p.defaultBaseURL ?? "";
      if (p.kind === "custom" || !baseURL) {
        baseURL = await ask("API 地址（baseURL，OpenAI 兼容端点，通常以 /v1 结尾）", baseURL);
        // 自动补全 /v1：没以 /v1 或 /v\d+ 结尾时询问是否补全
        if (baseURL && !/\/v\d+$/.test(baseURL)) {
          const fixed = (baseURL.endsWith("/") ? baseURL : baseURL + "/") + "v1";
          const ok = await ask(`地址未以 /v1 结尾，自动补全为 "${fixed}"？`, "y");
          if (!/^n/i.test(ok)) baseURL = fixed;
        }
      }
      const apiKey = await ask("API Key（没有可留空，用环境变量）");
      const id = (await ask("模型标识（英文，用于 --model 指定）", model.split(":")[0])).replace(/\s+/g, "-");

      const m: ModelConfig = { id, name, provider: p.kind, model, ...(baseURL ? { baseURL } : {}), ...(apiKey ? { apiKey } : {}) };
      cfg.models.push(m);
      if (!cfg.defaultModelId) cfg.defaultModelId = m.id;
      saveConfig(cfg);
      console.log(C.green(`  ✅ 已添加 ${name}，并设为默认`));
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
      if (!cfg.models.length) { console.log(C.red("  请先添加模型")); continue; }
      cfg.models.forEach((m, i) => console.log(C.dim(`  ${i + 1}.`), `${m.name}（${m.id}）`));
      const ki = parseInt(await ask("要修改 Key 的编号"), 10) - 1;
      const m = cfg.models[ki];
      if (!m) { console.log(C.red("  无效编号")); continue; }
      const key = await ask(`输入 ${m.name} 的新 API Key`);
      if (key) { m.apiKey = key; saveConfig(cfg); console.log(C.green("  ✅ API Key 已更新")); }
      else console.log(C.red("  Key 不能为空"));
    } else {
      console.log(C.red("  无效输入"));
    }
  }
  console.log(C.dim(`\n配置保存在：${CONFIG_PATH}`));
}

// ─────────────────────── sandbox-net 子命令（M6 网络出站控制）───────────────────────

/** 写入配置的 sandboxNet 开关（不触碰 models 等其它字段） */
function setSandboxNetConfig(enabled: boolean) {
  const cfg = loadConfig();
  if (!cfg) return;
  cfg.sandboxNet = { enabled };
  saveConfig(cfg);
}

/**
 * 自我提权重启（UAC）：node <tsx入口> <cli入口> sandbox-net <sub> --elevated，等待结束后返回。
 * 实现：临时 .ps1（UTF-8 BOM）+ `powershell -File`——不走 -Command 命令行，
 * 避免全角路径（如 E:\InFu（Agent））在 GBK 代码页下被 -Command 参数解析损坏。
 * 提权子进程无可见控制台：输出重定向到临时文件，由本进程打印（成功/失败都可见）。
 * 返回 false 表示用户取消 UAC 或 PowerShell 启动失败。
 */
function relaunchElevated(subArgs: string[]): boolean {
  // tsx 包装时 argv=[node, tsx/cli.mjs, src/cli.ts, ...]；直跑时 argv[1] 即入口
  const entry =
    process.argv[2] && /\.(ts|js|mjs)$/.test(process.argv[2]) && existsSync(resolve(process.argv[2]))
      ? resolve(process.argv[2])
      : resolve(process.argv[1]);
  const outFile = join(tmpdir(), `infu-elevate-out-${process.pid}.txt`);
  const errFile = join(tmpdir(), `infu-elevate-err-${process.pid}.txt`);
  const q = (a: string) => `"${a.replace(/"/g, '""')}"`;
  // 命令 = node <tsx CLI 中间层> <cli 入口> sandbox-net <sub> --elevated
  // 必须显式经 tsx：Node 原生 TS 不做 .js→.ts 导入重写（ERR_MODULE_NOT_FOUND）；
  // 外层不加引号包裹（cmd /c 遇到首字符引号会剥离外层引号破坏路径）
  // tsx 包目录 = require.resolve("tsx") 的 dist 上级（exports 屏蔽了 dist/cli.mjs 直取）
  const tsxCli = join(dirname(require.resolve("tsx")), "cli.mjs");
  const cmdParts = [tsxCli, entry, "sandbox-net", ...subArgs, "--elevated"];
  // cmd /c "node ... > out 2> err"（-Verb RunAs 与 -RedirectStandardOutput 不兼容，只能 cmd 内重定向）
  const cmdLine = `node ${cmdParts.map(q).join(" ")} > ${q(outFile)} 2> ${q(errFile)}`;
  const ps = [
    `$cmd = '${cmdLine.replace(/'/g, "''")}'`,
    `Start-Process -FilePath "$env:ComSpec" -ArgumentList "/c", $cmd -Verb RunAs -Wait -WorkingDirectory '${process.cwd().replace(/'/g, "''")}'`,
  ].join("\n");
  const psPath = join(tmpdir(), `infu-elevate-${process.pid}.ps1`);
  if (process.env.INFU_DEBUG_ELEVATE) {
    console.error("[debug] argv:", JSON.stringify(process.argv));
    console.error("[debug] entry:", entry, "\n[debug] tsxCli:", tsxCli, "\n[debug] ps1:", psPath, "\n---\n", ps, "\n---");
  }
  try {
    // \uFEFF = UTF-8 BOM：PowerShell 5.1 据此按 UTF-8 解析脚本内容（全角路径不损坏）
    writeFileSync(psPath, "\uFEFF" + ps + "\n", "utf-8");
    const res = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath], { stdio: "inherit" });
    // 打印提权子进程的输出（安装成功/失败的明细）
    for (const f of [outFile, errFile]) {
      if (existsSync(f)) {
        const text = readFileSync(f, "utf-8").trim();
        if (text) process.stdout.write(text + "\n");
      }
    }
    return res.status === 0;
  } catch {
    return false;
  } finally {
    for (const f of [psPath, outFile, errFile]) {
      try { rmSync(f, { force: true }); } catch { /* 清理失败不影响主流程 */ }
    }
  }
}

/** `infu sandbox-net setup|status|remove|grant <dir>` */
function sandboxNetCommand(sub: string, rest: string[]): Promise<void> {
  return (async () => {
    const elevated = netIsElevated();
    const isElevatedRun = process.argv.includes("--elevated") || elevated;

    if (sub === "setup") {
      if (!isElevatedRun) {
        console.log(C.yellow("需要管理员权限安装防火墙规则——即将弹出 UAC 确认（仅此一次）…"));
        if (!relaunchElevated(["setup"])) {
          console.error(C.red("✗ 提权未完成（已取消或失败，见上方输出）"));
          process.exit(1);
        }
      } else {
        try {
          const r = netSetup();
          grantCurrentUserRights(); // 当前用户特权（S4U 任务令牌按新策略带权）
          installHelperTask(); // 提权辅助计划任务（沙箱命令执行通道）
          setSandboxNetConfig(true);
          console.log(C.green(`✓ 网络出站控制已安装（${r.createdAt}）`));
          console.log(`  断网账号: ${r.offlineUser}（SID ${r.offlineSid}，AppContainer 无网络能力 = 出站全断）`);
          console.log(`  联网账号: ${r.onlineUser}`);
          console.log(`  已授权工具目录（Read+Execute）: ${r.toolDirs.length} 个`);
          console.log(`  凭据已 DPAPI 加密存入 ~/.infu/sandbox-net.json（明文不入库）`);
        } catch (e) {
          console.error(C.red(`✗ 安装失败: ${(e as Error).message}`));
          process.exit(1);
        }
      }
      // 提权重启后父进程也回来走到这里 → 打印状态收尾
      if (!isElevatedRun) await printNetStatus();
      return;
    }

    if (sub === "remove") {
      if (!isElevatedRun) {
        console.log(C.yellow("需要管理员权限删除防火墙规则与账号——即将弹出 UAC 确认…"));
        if (!relaunchElevated(["remove"])) {
          console.error(C.red("✗ 提权未完成（已取消或失败，见上方输出）"));
          process.exit(1);
        }
      } else {
        try {
          removeHelperTask();
          const msg = netRemove();
          setSandboxNetConfig(false);
          console.log(C.green(`✓ ${msg}`));
        } catch (e) {
          console.error(C.red(`✗ 移除失败: ${(e as Error).message}`));
          process.exit(1);
        }
      }
      if (!isElevatedRun) await printNetStatus();
      return;
    }

    if (sub === "grant") {
      const dir = resolve(rest[0] ?? process.cwd());
      try {
        const granted = netGrant(dir);
        console.log(C.green(`✓ 已授权沙箱账号访问 ${dir}`));
        for (const g of granted) console.log(C.dim(`  · ${g}`));
      } catch (e) {
        console.error(C.red(`✗ 授权失败: ${(e as Error).message}`));
        process.exit(1);
      }
      return;
    }

    if (sub === "status" || sub === undefined) {
      await printNetStatus();
      return;
    }

    console.error(C.red(`未知子命令: sandbox-net ${sub}（可用: setup / status / remove / grant <dir>）`));
    process.exit(1);
  })();
}

async function printNetStatus() {
  const st = netStatus();
  if (!st) {
    console.log(C.yellow("网络出站控制不可用（非 Windows 或原生模块未构建）"));
    return;
  }
  console.log(`\n网络出站控制（M6）状态：`);
  console.log(`  状态文件: ${st.configured ? C.green("已配置") : C.yellow("未配置")}`);
  console.log(`  提权: ${st.elevated ? "是" : "否"}`);
  if (st.configured) {
    console.log(`  断网账号（infu-sandbox-offline）: ${st.offlineOk ? C.green("可登录") : C.red("不可用")}`);
    console.log(`  联网账号（infu-sandbox-online）: ${st.onlineOk ? C.green("可登录") : C.red("不可用")}`);
    console.log(`  AppContainer 断网档案: ${st.rulesOk ? C.green("已就绪（无网络能力=出站全断）") : C.red("缺失")}`);
    if (st.error) console.log(C.yellow(`  ${st.error}`));
    console.log(C.dim("  沙箱命令默认以断网账号运行；联网需在审批中确认（🌐）"));
  } else {
    console.log(C.yellow("  运行 `infu sandbox-net setup` 一次性安装（UAC 提权，仅需一次）"));
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === "sandbox-net") {
    sandboxNetCommand(args[1] ?? "status", args.slice(2)).catch((e) => {
      console.error(C.red(`\n✗ sandbox-net 失败: ${e.message}`));
      process.exit(1);
    });
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

  const getArg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let prompt = args.filter((a) => !a.startsWith("--")).join(" ") || "";
  const root = resolve(getArg("--root") || process.cwd());
  const modelId = getArg("--model");
  const maxSteps = parseInt(getArg("--max-steps") || "", 10) || undefined;
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
  infu --setup   生成模型配置模板（JSON）
  infu --suggest 建议模式（模型只出方案，不执行工具）

网络出站控制（M6，Windows——沙箱命令默认断网，联网需审批）：
  infu sandbox-net setup    一次性安装（UAC 提权：WFP 拦截 + 沙箱专用账号）
  infu sandbox-net status   查看状态
  infu sandbox-net remove   移除（删规则 + 删账号）
  infu sandbox-net grant <dir>  授权沙箱账号访问目录（新项目根时自动执行）

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
  const decide = makeDecider(autoApprove);
  const emit = (e: AgentEvent) => printEvent(e);

  console.error(C.dim(`模型: ${modelCfg.name} (${modelCfg.provider}/${modelCfg.model})`));
  console.error(C.dim(`项目: ${root}`));
  console.error(C.dim(`审批: ${autoApprove ? "自动批准" : "交互确认"}${suggestOnly ? " | 建议模式" : ""}${orchestrate === "off" ? "" : " | 分层编排 " + (orchestrate === "full" ? "(Planner→Executor→Reviewer)" : "(Planner→Executor)")}${orchestrate === "off" || suggestOnly ? "" : planApproval ? " | 计划需确认" : " | 计划不确认"}${bestOfN ? ` | /best-of-n ×${bestOfN}` : ""}`));
  console.error(C.dim(`工具: ${Object.keys(TOOLS).length} 个\n`));

  const common = {
    modelConfig: {
      provider: modelCfg.provider,
      model: modelCfg.model,
      baseURL: modelCfg.baseURL,
      apiKey: resolveApiKey(modelCfg),
    },
    prompt,
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
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    runBestOfN({ n: bestOfN, ...common, abortSignal: controller.signal })
      .then((r) => {
        process.stdout.write(formatComparison(r) + "\n");
      })
      .catch((e) => {
        console.error(C.red(`\n✗ /best-of-n 运行失败: ${e.message}`));
        process.exit(1);
      });
    return;
  }

  // 建议模式 / 关闭编排：直跑单 Agent（保持一期行为）
  if (suggestOnly || orchestrate === "off") {
    runAgent({
      ...common,
      system: DEFAULT_SYSTEM_PROMPT,
      tools: TOOLS,
      suggestOnly,
    })
      .then((r) => {
        process.stdout.write("\n" + r.text + "\n");
      })
      .catch((e) => {
        console.error(C.red(`\n✗ Agent 运行失败: ${e.message}`));
        process.exit(1);
      });
    return;
  }

  runOrchestratedTask({ ...common, orchestrate, planApproval })
    .then((r) => {
      process.stdout.write("\n" + r.text + "\n");
    })
    .catch((e) => {
      console.error(C.red(`\n✗ Agent 运行失败: ${e.message}`));
      process.exit(1);
    });
}

main();
