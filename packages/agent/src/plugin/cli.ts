/**
 * CLI 子命令：infu plugin add/list/remove/status + infu skill add/list/remove（v2.3 批 2）
 *
 * 分发由 cli.ts main() 完成（args[0] === "plugin"/"skill"）；本模块为业务逻辑。
 * 行迭代器为模块级单例（与 mcp/cli.ts 同构；同一进程同一时刻只有一个向导）。
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InfuConfig } from "@infu/shared";
import { loadConfig, saveConfig } from "../providers/registry.js";
import { resolveDataDir } from "../data-dir.js";
import { loadPlugins } from "./index.js";
import { listSkills, readSkillMeta } from "./skills.js";
import { listMarketplacePlugins, findMarketplacePlugin } from "./marketplace.js";
import { listSkillTemplates, createSkillFromTemplate } from "./skill-templates.js";

// ── 终端着色（与 cli.ts 一致）──
const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

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

// v4.0 审计修复（M2）：删除本地直写 saveConfig（无原子写/无 0600 chmod，与常驻 server
// 并发写可截断半写）——统一走 registry.saveConfig（tmp + rename 原子写 + chmod 0600）

export async function pluginCli(args: string[]): Promise<void> {
  const cmd = args[0];
  if (cmd === "add") return pluginAdd(args.slice(1));
  if (cmd === "install") return pluginInstall(args[1]);
  if (cmd === "marketplace") return pluginMarketplace();
  if (cmd === "list") return pluginList();
  if (cmd === "remove") return pluginRemove(args[1]);
  if (cmd === "status") return pluginStatus(args[1]);
  console.log(`InFu 插件管理（v2.3 批 2：JS 模块插件 = 工具/钩子/技能）

用法：
  infu plugin marketplace                     列出官方市场可安装插件
  infu plugin install <id>                    从市场一键安装（如 infu plugin install browser-use）
  infu plugin add <id> [--path <模块路径>]   手动添加插件（默认导出 PluginDef；交互向导）
  infu plugin list                            列出已配置的插件
  infu plugin remove <id>                     删除插件
  infu plugin status [id]                     探测加载，列出工具/钩子数

插件模块示例（.ts/.mjs，默认导出）：
  export default {
    id: "my-tools", name: "我的工具", description: "...",
    tools: [{ name: "hello", description: "...", schema: ..., risk: "low",
              execute: async (args, ctx) => "hi" }],
    hooks: { preToolUse: async ({tool}) => ({ decision: "allow" }) },
  };
⚠ 插件代码在 Agent 进程内运行，配置即信任。`);
}

function argValue(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

async function pluginAdd(args: string[]): Promise<void> {
  const idArg = args[0];
  const id = (idArg ?? (await ask("插件标识（英文，如 my-tools）"))).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) {
    console.error(C.red("id 不能为空"));
    return;
  }
  const cfg = loadConfig() ?? { models: [], providers: [] };
  if ((cfg.plugins ?? []).some((p) => p.id === id)) {
    console.error(C.red(`插件 "${id}" 已存在（infu plugin list 查看）`));
    return;
  }
  const path = argValue(args, "--path") ?? (await ask("插件模块绝对路径（.ts/.mjs/.js）"));
  if (!path) {
    console.error(C.red("path 不能为空"));
    return;
  }
  cfg.plugins = [...(cfg.plugins ?? []), { id, path: resolve(path) }];
  saveConfig(cfg);
  console.log(C.green(`✅ 已添加插件 ${id}（${resolve(path)}）`));
  console.log(C.dim(`   可用 infu plugin status ${id} 探测加载；下一任务执行阶段自动加载其工具/钩子`));
}

/** 从官方市场安装插件（写 config.plugins[] + source/version 元数据） */
async function pluginInstall(id?: string): Promise<void> {
  if (!id) {
    pluginMarketplace();
    console.log(C.dim("\n用法：infu plugin install <id>"));
    return;
  }
  const mp = findMarketplacePlugin(id);
  if (!mp) {
    console.error(C.red(`市场无插件 "${id}"（infu plugin marketplace 查看可安装插件）`));
    return;
  }
  const cfg = loadConfig() ?? { models: [], providers: [] };
  if ((cfg.plugins ?? []).some((p) => p.id === mp.id)) {
    console.error(C.red(`插件 "${mp.id}" 已安装（infu plugin list 查看）`));
    return;
  }
  cfg.plugins = [...(cfg.plugins ?? []), { id: mp.id, path: mp.path, source: mp.source, version: mp.version }];
  saveConfig(cfg);
  console.log(C.green(`✅ 已从市场安装插件 ${mp.id} v${mp.version}`));
  console.log(C.dim(`   ${mp.description.slice(0, 80)}`));
  console.log(C.dim(`   下一任务执行阶段自动加载其工具/钩子/技能（infu plugin status ${mp.id} 探测）`));
}

/** 列出官方市场插件 */
function pluginMarketplace(): void {
  const plugins = listMarketplacePlugins();
  if (!plugins.length) {
    console.log("官方市场暂无插件");
    return;
  }
  console.log(C.cyan(`\n═══ InFu 官方插件市场（${plugins.length}）═══`));
  plugins.forEach((p, i) => {
    console.log(` ${String(i + 1).padStart(2)}. ${p.name} v${p.version}  [${p.id}]`);
    console.log(C.dim(`     ${p.description}`));
  });
  console.log(C.dim(`\n安装：infu plugin install <id>`));
}

function pluginList(): void {
  const cfg = loadConfig();
  const plugins = cfg?.plugins ?? [];
  if (!plugins.length) {
    console.log("暂无插件（infu plugin add <id> --path <模块路径> 添加）");
    return;
  }
  console.log(C.cyan(`\n═══ 插件（${plugins.length}）═══`));
  plugins.forEach((p, i) => {
    const st = p.enabled === false ? C.yellow("禁用") : C.green("启用");
    console.log(` ${String(i + 1).padStart(2)}. ${p.id} ${st}`);
    console.log(C.dim(`     ${p.path}`));
  });
  console.log(C.dim(`\n详情：infu plugin status [id]；删除：infu plugin remove <id>`));
}

async function pluginRemove(id?: string): Promise<void> {
  if (!id) {
    console.log("用法：infu plugin remove <id>（infu plugin list 查看）");
    return;
  }
  const cfg = loadConfig();
  const p = (cfg?.plugins ?? []).find((x) => x.id === id);
  if (!p) {
    console.error(C.red(`插件 "${id}" 不存在`));
    return;
  }
  const ok = await ask(`确认删除插件 "${id}"（${p.path}）？(y/N)`, "n");
  if (!/^y/i.test(ok)) {
    console.log("已取消");
    return;
  }
  cfg!.plugins = (cfg!.plugins ?? []).filter((x) => x.id !== id);
  saveConfig(cfg!);
  console.log(C.green(`✅ 已删除插件 ${id}`));
}

async function pluginStatus(id?: string): Promise<void> {
  const cfg = loadConfig();
  const plugins = id ? (cfg?.plugins ?? []).filter((p) => p.id === id) : (cfg?.plugins ?? []);
  if (!plugins.length) {
    console.log(id ? `插件 "${id}" 不存在（infu plugin list 查看）` : "暂无插件");
    return;
  }
  const events: unknown[] = [];
  const r = await loadPlugins(plugins, (e) => events.push(e));
  for (const p of plugins) {
    console.log(C.cyan(`\n${p.id}（${p.path}${p.enabled === false ? " · 已禁用" : ""}）`));
    if (p.enabled === false) {
      console.log(C.dim("  已禁用，跳过加载"));
      continue;
    }
    if (r.failures.some((f) => f.id === p.id)) {
      console.error(C.red(`  ✗ 加载失败：${r.failures.find((f) => f.id === p.id)?.message.slice(0, 160)}`));
      continue;
    }
    const info = r.perPlugin.find((x) => x.id === p.id);
    const toolNames = info?.toolNames ?? [];
    console.log(C.green(`  ✅ 已加载：${toolNames.length} 个工具、钩子 ${info?.hookCount ?? 0} 个`));
    for (const t of r.tools.filter((x) => toolNames.includes(x.name))) {
      const riskColor = t.risk === "low" ? C.green : t.risk === "high" ? C.red : C.yellow;
      console.log(`   · ${t.name} ${riskColor(`[${t.risk}]`)}${t.description ? C.dim(" " + t.description.slice(0, 70)) : ""}`);
    }
  }
}

// ── skill 管理（SKILL.md 社区标准）──

export async function skillCli(args: string[]): Promise<void> {
  const cmd = args[0];
  if (cmd === "add") return skillAdd(args.slice(1));
  if (cmd === "list") return skillList();
  if (cmd === "remove") return skillRemove(args[1]);
  if (cmd === "export") return skillExport(args.slice(1));
  if (cmd === "import") return skillImport(args[1]);
  if (cmd === "template") return skillTemplate(args.slice(1));
  console.log(`InFu 技能管理（v2.3 批 2：SKILL.md 社区标准，progressive disclosure）

用法：
  infu skill add <name> [--path <skill目录>]   添加技能引用（缺省按 name 在 ~/.infu/skills 或项目 .infu/skills 查找）
  infu skill list                               列出可用技能（用户级/项目级/显式引用/内置）
  infu skill remove <name>                      移除显式引用（不删除文件）
  infu skill export <name> [--to <目录>]        导出技能目录（复制 SKILL.md + references/scripts/assets）
  infu skill import <技能目录路径>               导入技能到 ~/.infu/skills/<name>/（校验 SKILL.md 合法）
  infu skill template list                      列出内置技能模板（v6.0 P4）
  infu skill template new <name> --template <id> 从模板生成技能到 ~/.infu/skills/<name>/

SKILL.md 标准：技能目录下必须有 SKILL.md（frontmatter：name=目录名 + description），
可选 references/ scripts/ assets/ 子目录。任务匹配描述时 Agent 会调用 use_skill 读取全文。`);
}

/** v6.0（P4）：skill 模板库——list / new <name> --template <id> */
async function skillTemplate(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "list") {
    const templates = listSkillTemplates();
    console.log(C.cyan(`\n═══ 内置技能模板（${templates.length}）═══`));
    templates.forEach((t, i) => {
      console.log(` ${String(i + 1).padStart(2)}. ${C.green(t.id)} — ${t.title}`);
      console.log(C.dim(`     ${t.description}`));
    });
    console.log(C.dim(`\n生成技能：infu skill template new <name> --template <id>`));
    return;
  }
  if (sub === "new") {
    const name = args[1];
    const templateId = argValue(args, "--template") ?? (await ask("模板 id（infu skill template list 查看）"));
    if (!name || !templateId) {
      console.error(C.red("用法：infu skill template new <name> --template <id>"));
      return;
    }
    const r = createSkillFromTemplate(name, templateId);
    if (!r.ok) {
      console.error(C.red(r.message));
      return;
    }
    console.log(C.green(`✅ ${r.message}`));
    console.log(C.dim("   下一任务自动发现（描述注入 system，use_skill 读取全文）；infu skill list 可查看"));
    return;
  }
  console.log(`InFu 技能模板库（v6.0 P4）

用法：
  infu skill template list                       列出内置模板
  infu skill template new <name> --template <id> 从模板生成技能到 ~/.infu/skills/<name>/

模板：code-review（代码审查）/ test-runner（测试运行与修复）/ docs-writer（文档编写）/ refactor（重构）`);
}

async function skillAdd(args: string[]): Promise<void> {
  const name = args[0] ?? (await ask("技能名（与 SKILL.md frontmatter name 一致）"));
  if (!name) {
    console.error(C.red("name 不能为空"));
    return;
  }
  const cfg = loadConfig() ?? { models: [], providers: [] };
  if ((cfg.skills ?? []).some((s) => s.name === name)) {
    console.error(C.red(`技能 "${name}" 已在显式引用中`));
    return;
  }
  const pathArg = argValue(args, "--path");
  let path: string | undefined;
  if (pathArg) {
    const dir = resolve(pathArg);
    const meta = readSkillMeta(dir, "config");
    if (!meta) {
      console.error(C.red(`路径 "${dir}" 下未找到合法的 SKILL.md（需 frontmatter name/description，目录名与 name 一致）`));
      return;
    }
    path = dir;
  } else {
    // 缺省：按 name 在用户级/项目级查找（listSkills 的 config 缺省逻辑）
    const meta = listSkills(loadConfig(), process.cwd()).find((s) => s.name === name);
    if (meta) {
      console.log(C.dim(`已在 ${meta.level} 级发现技能 "${name}"（${meta.path}），无需显式引用`));
      return;
    }
    console.error(C.red(`未找到技能 "${name}"（请用 --path 指定技能目录，或放到 ~/.infu/skills/${name}/ 或项目 .infu/skills/${name}/）`));
    return;
  }
  cfg.skills = [...(cfg.skills ?? []), { name, path }];
  saveConfig(cfg);
  console.log(C.green(`✅ 已添加技能引用 ${name}（${path}）——任务中可用 use_skill 读取`));
}

function skillList(): void {
  const cfg = loadConfig();
  const root = process.cwd();
  const skills = listSkills(cfg, root);
  if (!skills.length) {
    console.log("暂无可用技能（把 SKILL.md 放到 ~/.infu/skills/<name>/ 或项目 .infu/skills/<name>/）");
    return;
  }
  console.log(C.cyan(`\n═══ 可用技能（${skills.length}）═══`));
  skills.forEach((s, i) => {
    const level = s.level === "user" ? C.dim("用户级") : s.level === "project" ? C.dim("项目级") : C.yellow("显式引用");
    console.log(` ${String(i + 1).padStart(2)}. ${C.green(s.name)} ${level}`);
    console.log(C.dim(`     ${s.description.slice(0, 100)}`));
    console.log(C.dim(`     ${s.path}`));
  });
  console.log(C.dim(`\n移除显式引用：infu skill remove <name>`));
}

/** v2.7：导出技能——复制技能目录（含 SKILL.md + references/scripts/assets）到指定位置 */
async function skillExport(args: string[]): Promise<void> {
  const name = args[0] ?? (await ask("技能名（infu skill list 查看）"));
  if (!name) return;
  const meta = listSkills(loadConfig(), process.cwd()).find((s) => s.name === name);
  if (!meta) {
    console.error(C.red(`未找到技能 "${name}"（infu skill list 查看可用技能）`));
    return;
  }
  const srcDir = meta.path.replace(/[\\/]SKILL\.md$/, "");
  const toArg = argValue(args, "--to");
  const to = resolve(toArg ?? (await ask("导出目录（默认当前目录）", ".")));
  const dest = join(to, `${name}-skill`);
  if (existsSync(dest)) {
    const ok = await ask(`目标 ${dest} 已存在，覆盖？(y/N)`, "n");
    if (!/^y/i.test(ok)) { console.log("已取消"); return; }
    rmSync(dest, { recursive: true, force: true });
  }
  try {
    cpSync(srcDir, dest, { recursive: true });
    console.log(C.green(`✅ 已导出技能 "${name}" 到 ${dest}`));
    console.log(C.dim(`   （含 SKILL.md + references/scripts/assets；分享整个目录，对方 infu skill import ${dest} 即可）`));
  } catch (e) {
    console.error(C.red(`导出失败：${(e as Error).message}`));
  }
}

/** v2.7：导入技能——从目录复制到 ~/.infu/skills/<name>/（校验 SKILL.md 合法） */
async function skillImport(pathArg?: string): Promise<void> {
  const src = pathArg ?? (await ask("技能目录路径（含 SKILL.md）"));
  if (!src) return;
  const dir = resolve(src);
  const meta = readSkillMeta(dir, "user");
  if (!meta) {
    console.error(C.red(`"${dir}" 下未找到合法 SKILL.md（需 frontmatter name=目录名 + description）`));
    return;
  }
  const dest = join(resolveDataDir(), "skills", meta.name);
  if (existsSync(dest)) {
    const ok = await ask(`~/.infu/skills/${meta.name} 已存在，覆盖？(y/N)`, "n");
    if (!/^y/i.test(ok)) { console.log("已取消"); return; }
    rmSync(dest, { recursive: true, force: true });
  }
  try {
    cpSync(dir, dest, { recursive: true });
    console.log(C.green(`✅ 已导入技能 "${meta.name}" 到 ${dest}`));
    console.log(C.dim("   下一任务自动发现（描述注入 system，use_skill 读取全文）"));
  } catch (e) {
    console.error(C.red(`导入失败：${(e as Error).message}`));
  }
}

async function skillRemove(name?: string): Promise<void> {
  if (!name) {
    console.log("用法：infu skill remove <name>（只移除显式引用，不删除文件）");
    return;
  }
  const cfg = loadConfig();
  if (!(cfg?.skills ?? []).some((s) => s.name === name)) {
    console.error(C.red(`技能 "${name}" 不在显式引用中（infu skill list 查看）`));
    return;
  }
  cfg!.skills = (cfg!.skills ?? []).filter((s) => s.name !== name);
  saveConfig(cfg!);
  console.log(C.green(`✅ 已移除技能引用 ${name}`));
}
