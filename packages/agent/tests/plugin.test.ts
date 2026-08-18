/**
 * 插件系统 v1 自测（v2.3 批 2：插件加载器 / 函数式钩子 / skill 加载 / config schema /
 * API CRUD+probe / plugin_add & use_skill 工具层）
 * 运行：npx tsx packages/agent/tests/plugin.test.ts
 *
 * 覆盖：
 *  - loadPlugins：正常加载（工具/钩子/技能）、坏导出跳过、enabled=false、重名前缀、risk 默认 medium
 *  - applyPreToolUseHooks / applyPostToolUseHooks：allow 放行 / block 拦截 / 改 args / 改 result / 抛错放行
 *  - skills：frontmatter 解析（正常/缺失/目录名不一致）、listSkills 层级（项目级 + config 显式）、buildSkillsPrompt
 *  - infuConfigSchema：plugins/skills 节 + passthrough
 *  - API：/api/plugins CRUD + probe、/api/skills（数据目录重定向隔离）
 *  - 工具层：plugin_add（high + requireExplicit 审批/白名单）、use_skill（读取/未找到）
 */
import { createApp } from "../src/server.js";
import { loadPlugins } from "../src/plugin/index.js";
import {
  parseSkillFrontmatter, readSkillMeta, listSkills, buildSkillsPrompt,
} from "../src/plugin/skills.js";
import { applyPreToolUseHooks, applyPostToolUseHooks } from "../src/agent/loop.js";
import { isProtectedPath } from "../src/sandbox/index.js";
import { TOOLS } from "../src/tools/index.js";
import { parseInfuConfig } from "@infu/shared";
import type { AgentEvent, PluginConfig } from "@infu/shared";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 插件系统 v1 自测 ===\n");

// v3.6：数据目录重定向到临时目录（原备份/恢复真实 ~/.infu/config.json 崩溃即污染用户数据）
const tmpData = mkdtempSync(join(tmpdir(), "infu-test-"));
setDataDirForTest(tmpData);

// ── 0. 测试夹具：临时项目 + 插件文件 + skill 目录 ──
const proj = mkdtempSync(join(tmpdir(), "infu-plugin-test-"));
const skillDir = join(proj, ".infu", "skills");
mkdirSync(join(skillDir, "good-skill"), { recursive: true });
writeFileSync(join(skillDir, "good-skill", "SKILL.md"), [
  "---",
  "name: good-skill",
  'description: "一个测试技能，用于验证 SKILL.md 加载"',
  "---",
  "# Good Skill",
  "按以下步骤执行：",
  "1. 步骤一",
].join("\n"));
// 坏 skill：缺 description
mkdirSync(join(skillDir, "bad-skill"), { recursive: true });
writeFileSync(join(skillDir, "bad-skill", "SKILL.md"), "---\nname: bad-skill\n---\n无描述\n");
// 目录名与 name 不一致
mkdirSync(join(skillDir, "dir-mismatch"), { recursive: true });
writeFileSync(join(skillDir, "dir-mismatch", "SKILL.md"), "---\nname: other-name\ndescription: 不一致\n---\n内容\n");
// 仅 config 显式引用（不在项目级扫描目录内；目录名与 frontmatter name 一致）
const configSkillDir = join(proj, "config-only");
mkdirSync(configSkillDir, { recursive: true });
writeFileSync(join(configSkillDir, "SKILL.md"), "---\nname: config-only\ndescription: 仅显式引用\n---\n内容\n");

// 正常插件（.mjs；skills 路径直接内联，避免插件内 import）
const goodPlugin = join(proj, "good-plugin.mjs");
writeFileSync(goodPlugin, `
export default {
  id: "good-plugin", name: "好插件", description: "测试插件",
  tools: () => [
    { name: "hello", description: "打招呼", schema: { safeParse: () => ({ success: true }) }, risk: "low",
      execute: async () => "hello from plugin" },
    { name: "no_risk", description: "未声明风险", schema: { safeParse: () => ({ success: true }) },
      execute: async () => "ok" },
  ],
  hooks: {
    preToolUse: async () => ({ decision: "allow" }),
    postToolUse: async () => ({ result: "POST:改写" }),
  },
  skills: [${JSON.stringify(join(skillDir, "good-skill"))}],
};
`);
// 坏导出插件（无 default）
const badPlugin = join(proj, "bad-plugin.mjs");
writeFileSync(badPlugin, `export const notAPlugin = 1;\n`);
// 抛错插件（import 时抛错）
const throwPlugin = join(proj, "throw-plugin.mjs");
writeFileSync(throwPlugin, `throw new Error("导入即失败");\n`);

const emit = (e: AgentEvent) => { /* 静默收集 */ };

// ── 1. 插件加载器 ──
console.log("▶ loadPlugins");
{
  const plugins: PluginConfig[] = [
    { id: "good", path: goodPlugin },
    { id: "bad", path: badPlugin },
    { id: "throw", path: throwPlugin },
    { id: "off", path: goodPlugin, enabled: false },
  ];
  const events: AgentEvent[] = [];
  const r = await loadPlugins(plugins, (e) => events.push(e));
  // 注：loadPlugins 现在会合并内置官方插件（browser-use 7 工具），断言只看用户插件的工具
  check("正常插件工具加载", r.tools.some((t) => t.name === "hello") && r.tools.some((t) => t.name === "no_risk"), r.tools.map((t) => t.name).join(","));
  check("工具名透传", r.tools.some((t) => t.name === "hello"));
  check("risk 缺省默认 medium", r.tools.find((t) => t.name === "no_risk")?.risk === "medium");
  check("声明 risk 保留", r.tools.find((t) => t.name === "hello")?.risk === "low");
  check("钩子挂载（pre+post）", r.hooks.preToolUse.length === 1 && r.hooks.postToolUse.length === 1);
  check("坏导出跳过并记录", r.failures.some((f) => f.id === "bad" && f.message.includes("default")));
  check("导入抛错跳过并记录", r.failures.some((f) => f.id === "throw"));
  check("enabled=false 不加载（2 失败）", r.failures.length === 2);
  check("内置插件默认加载（browser_navigate）", r.tools.some((t) => t.name === "browser_navigate"));
  // v3：成功加载不再 emit text（避免对话流环境噪音；工具/技能描述已注入 system）
  check("失败事件提示", events.some((e) => e.type === "text" && e.text.includes("加载失败")));
  // 重名加前缀
  const r2 = await loadPlugins([
    { id: "a", path: goodPlugin },
    { id: "b", path: goodPlugin },
  ], emit);
  check("跨插件重名加前缀", r2.tools.some((t) => t.name === "b_hello"), r2.tools.map((t) => t.name).join(","));
  // 无用户插件 → 仍有内置插件，但无失败
  const r3 = await loadPlugins(undefined, emit);
  check("无用户插件 → 内置插件加载且无失败", r3.failures.length === 0 && r3.tools.some((t) => t.name === "browser_navigate"));
}

// ── 2. 函数式钩子 ──
console.log("\n▶ 钩子链");
{
  const input = { tool: "read_file", args: { path: "a" }, callId: "c1", risk: "low" as const };
  const noop = () => {};

  // allow 放行
  const r1 = await applyPreToolUseHooks([async () => ({ decision: "allow" })], input, noop);
  check("allow 放行", r1.blocked === null && r1.args.path === "a");

  // block 拦截（带 reason）
  const r2 = await applyPreToolUseHooks([async () => ({ decision: "block", reason: "策略禁止" })], input, noop);
  check("block 拦截（reason 透传）", r2.blocked === "策略禁止");

  // 改 args
  const r3 = await applyPreToolUseHooks([async () => ({ decision: "allow", args: { path: "b" } })], input, noop);
  check("允许并改写 args", r3.args.path === "b");

  // 钩子抛错 → 放行 + emit 错误
  const errEvents: AgentEvent[] = [];
  const r4 = await applyPreToolUseHooks([async () => { throw new Error("hook boom"); }], input, (e) => errEvents.push(e));
  check("pre 钩子抛错放行", r4.blocked === null && r4.args.path === "a");
  check("pre 钩子抛错 emit 错误事件", errEvents.some((e) => e.type === "error"));

  // 链式：先改 args 后 block
  const r5 = await applyPreToolUseHooks([
    async () => ({ decision: "allow", args: { path: "c" } }),
    async () => ({ decision: "block", reason: "第二道拦" }),
  ], input, noop);
  check("链式改参后拦截", r5.args.path === "c" && r5.blocked === "第二道拦");

  // postToolUse：改写结果
  const r6 = await applyPostToolUseHooks([async () => ({ result: "改写后" })], input, "原始", noop);
  check("post 改写结果", r6 === "改写后");
  // post 不改写
  const r7 = await applyPostToolUseHooks([async () => ({ decision: "block" })], input, "原始", noop);
  check("post 无 result 原样返回", r7 === "原始");
  // post 抛错放行
  const r8 = await applyPostToolUseHooks([async () => { throw new Error("x"); }], input, "原始", noop);
  check("post 抛错放行（原结果）", r8 === "原始");
  // 空钩子
  const r9 = await applyPreToolUseHooks(undefined, input, noop);
  check("无钩子直接放行", r9.blocked === null);
}

// ── 3. skill 加载 ──
console.log("\n▶ skill 加载");
{
  // frontmatter 解析
  const fm1 = parseSkillFrontmatter("---\nname: demo\ndescription: \"带引号\"\n---\n正文");
  check("frontmatter 解析（引号去除）", fm1?.name === "demo" && fm1?.description === "带引号");
  check("无 frontmatter → null", parseSkillFrontmatter("# 无 frontmatter") === null);
  const fm2 = parseSkillFrontmatter("---\nname: x\ndescription: y\nlicense: MIT\n---\n");
  check("可选字段保留", fm2?.license === "MIT");
  const fmBom = parseSkillFrontmatter("\uFEFF---\nname: bom\ndescription: d\n---\n");
  check("容忍 BOM 前缀", fmBom?.name === "bom");

  // readSkillMeta：合法/缺描述/目录名不一致
  const good = readSkillMeta(join(skillDir, "good-skill"), "project");
  check("合法 skill 解析", good?.name === "good-skill" && good.description.includes("测试技能"));
  const bad = readSkillMeta(join(skillDir, "bad-skill"), "project");
  check("缺 description → null", bad === null);
  const mm = readSkillMeta(join(skillDir, "dir-mismatch"), "project");
  check("目录名与 name 不一致 → 以目录名为准", mm?.name === "dir-mismatch");

  // listSkills：项目级发现 + 坏 skill 过滤
  const cfg0 = { models: [] };
  const skills = listSkills(cfg0, proj);
  const projectSkills = skills.filter((s) => s.level === "project");
  check("项目级发现（坏 skill 过滤后 2 个）", projectSkills.length === 2, projectSkills.map((s) => s.name).join(","));
  check("来源层级 project", projectSkills.every((s) => s.level === "project"));

  // config 显式引用（path 指向 skill 目录；同名去重——项目级已发现则引用不重复）
  const cfg1 = { models: [], skills: [{ name: "good-skill", path: join(skillDir, "good-skill") }] };
  const skills2 = listSkills(cfg1, proj);
  check("config 显式引用同名校验不重复", !skills2.some((s) => s.level === "config"));
  // 不同名（项目级不存在）→ config 级加入
  const cfg2 = { models: [], skills: [{ name: "config-only", path: configSkillDir }] };
  const skills3 = listSkills(cfg2, proj);
  check("config 显式引用（新名）加入", skills3.some((s) => s.name === "config-only" && s.level === "config"));
  // YAML 折叠块（>）description 解析（Anthropic document-skills 写法）
  const fmFold = parseSkillFrontmatter("---\nname: pdf\ndescription: >\n  第一行\n  第二行\nlicense: MIT\n---\n");
  check("折叠块 description 拼接", fmFold?.description === "第一行 第二行", JSON.stringify(fmFold));

  // buildSkillsPrompt
  const prompt = buildSkillsPrompt([{ name: "demo", description: "描述", path: "x", level: "user" }]);
  check("描述注入 system 段", prompt.includes("demo") && prompt.includes("use_skill"));
  check("无技能 → 空串", buildSkillsPrompt([]) === "");
}

// ── 4. config schema ──
console.log("\n▶ config schema（plugins/skills 节）");
{
  const r = parseInfuConfig({
    version: 2,
    models: [],
    plugins: [{ id: "p1", path: "C:/x/p1.mjs" }, { id: "p2", path: "D:/y/p2.ts", enabled: false }],
    skills: [{ name: "s1", path: "C:/skills/s1" }],
    someFuture: { keep: 1 },
  });
  check("解析成功", r.ok);
  if (r.ok) {
    check("plugins 节解析", r.config.plugins?.length === 2 && r.config.plugins?.[1].enabled === false);
    check("skills 节解析", r.config.skills?.[0].name === "s1");
    check("未知字段保留", (r.config as any).someFuture.keep === 1);
  }
  const r2 = parseInfuConfig({ version: 2, models: [] });
  check("旧配置无插件节兼容", r2.ok && r2.config.plugins === undefined);
}

// ── 4.5 写保护精确化（v2.3 批 2：项目内 .infu/skills 放开，数据目录仍保护）──
console.log("\n▶ 写保护：数据目录仍拦，项目级 .infu/skills 放开");
{
  // v3.6：数据目录已重定向到临时目录——「InFu 配置目录」规则跟随 dataDir，
  // 断言改对重定向目录验证（原针对真实 ~/.infu，重定向后不再是数据目录）
  const homeInfu = join(tmpData, "config.json");
  check("数据目录 config.json 仍受保护", isProtectedPath(homeInfu) === "InFu 配置目录");
  check("数据目录本身受保护", isProtectedPath(tmpData) === "InFu 配置目录");
  check("项目内 .infu/skills 放开", isProtectedPath(join(proj, ".infu", "skills", "x", "SKILL.md")) === null);
  check("项目内 .infu 目录放开", isProtectedPath(join(proj, ".infu")) === null);
  // 其他敏感目录不受影响（模式匹配，与数据目录无关）
  check(".ssh 仍受保护", isProtectedPath(join(proj, ".ssh", "id_rsa")) === "SSH 密钥目录");
  check(".aws 仍受保护", isProtectedPath(join(proj, ".aws", "credentials")) === "AWS 凭据目录");
}

// ── 5. API：/api/plugins + /api/skills ──
console.log("\n▶ /api/plugins + /api/skills API");
{
  // v3.6：config 已重定向到临时数据目录（无需备份/恢复真实 ~/.infu/config.json）
  const CONFIG = join(tmpData, "config.json");
  const saveTestConfig = (cfg: unknown) => writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), "utf-8");

  const app = createApp({ defaultRoot: proj });
  const call = (url: string, init?: RequestInit) => app.request(url, init);
  try {
    saveTestConfig({ version: 2, models: [], providers: [] });

    // 添加插件
    let r = await call("/api/plugins", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "good", path: goodPlugin }),
    });
    let j = (await r.json()) as any;
    check("添加插件成功", r.status === 200 && j.ok, JSON.stringify(j));
    // 重复 409
    r = await call("/api/plugins", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "good", path: "x" }),
    });
    j = await r.json();
    check("重复 id → 409", r.status === 409);
    // 缺 path 400
    r = await call("/api/plugins", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x" }),
    });
    check("缺 path → 400", r.status === 400);
    // 列表（v2.7：内置官方插件默认显示 + 用户插件）
    r = await call("/api/plugins");
    j = await r.json();
    const listIds = (j.plugins ?? []).map((x: any) => x.id);
    check("列表含用户插件 good", listIds.includes("good"));
    check("列表含 3 个内置官方插件", ["browser-use", "document-skills", "skill-creator"].every((id) => listIds.includes(id)), JSON.stringify(listIds));
    check("内置插件带 builtin 标记", (j.plugins ?? []).filter((x: any) => x.builtin).length === 3);
    // probe：正常插件（2 工具 + 钩子；不合并内置插件）
    r = await call("/api/plugins/good/probe", { method: "POST" });
    j = await r.json();
    check("probe 成功（2 工具 + pre/post 钩子）",
      j.ok && j.tools.length === 2 && j.hooks.preToolUse === 1 && j.hooks.postToolUse === 1, JSON.stringify(j));
    // probe：坏插件 → 502
    await call("/api/plugins", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad", path: badPlugin }),
    });
    r = await call("/api/plugins/bad/probe", { method: "POST" });
    j = await r.json();
    check("probe 坏插件 → 502", r.status === 502 && j.ok === false);
    // probe 不存在 → 404
    r = await call("/api/plugins/nope/probe", { method: "POST" });
    check("probe 不存在 → 404", r.status === 404);
    // 启停切换
    r = await call("/api/plugins/good", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    j = await r.json();
    check("更新（禁用）成功", r.status === 200 && j.ok);
    // 删除
    r = await call("/api/plugins/bad", { method: "DELETE" });
    j = await r.json();
    check("删除成功", r.status === 200 && j.ok);
    r = await call("/api/plugins/bad", { method: "DELETE" });
    check("删除不存在 → 404", r.status === 404);

    // ── v2.4 生成带钩子的插件（设置界面「新建钩子」）──
    console.log("  ▶ 生成钩子插件（/api/plugins/generate）");
    const genCode = `export default {
  id: "gen-hooks",
  name: "生成钩子",
  description: "测试生成",
  hooks: {
    preToolUse: async (input) => ({ decision: "allow" }),
    postToolUse: async () => ({}),
  },
};`;
    // 成功生成（默认目录 ~/.infu/plugins/）
    r = await call("/api/plugins/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gen-hooks", code: genCode }),
    });
    j = await r.json();
    check("生成成功", r.status === 200 && j.ok && j.plugin === "gen-hooks", JSON.stringify(j));
    check("文件路径含 plugins 目录", String(j.path ?? "").includes("plugins"), j.path);
    check("文件已落盘", j.path && existsSync(j.path));
    // 生成后可 probe（钩子生效）
    r = await call("/api/plugins/gen-hooks/probe", { method: "POST" });
    j = await r.json();
    check("生成的插件可加载（pre/post 钩子各 1）",
      j.ok && j.hooks.preToolUse === 1 && j.hooks.postToolUse === 1, JSON.stringify(j));
    // 重名 → 409
    r = await call("/api/plugins/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gen-hooks", code: genCode }),
    });
    check("重名 → 409", r.status === 409);
    // 缺 code → 400
    r = await call("/api/plugins/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gen-hooks-2" }),
    });
    check("缺 code → 400", r.status === 400);
    // 指定 path 生成
    r = await call("/api/plugins/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gen-hooks-3", code: genCode, path: join(proj, "custom-hooks.mjs") }),
    });
    j = await r.json();
    check("指定 path 生成", r.status === 200 && String(j.path ?? "").includes("custom-hooks.mjs"), j.path);
    // 清理生成的插件（删除注册 + 默认目录文件 + 自定义路径文件）
    await call("/api/plugins/gen-hooks", { method: "DELETE" });
    await call("/api/plugins/gen-hooks-3", { method: "DELETE" });
    // v3.6：生成默认目录跟随重定向数据目录（原为真实 ~/.infu/plugins/）
    const genDefaultFile = join(tmpData, "plugins", "gen-hooks.mjs");
    if (existsSync(genDefaultFile)) rmSync(genDefaultFile, { force: true });
    if (j.path && existsSync(j.path)) rmSync(j.path, { force: true });

    // skills：列表（项目级 2 个）
    r = await call("/api/skills");
    j = await r.json();
    const apiProject = (j.skills ?? []).filter((s: any) => s.level === "project");
    check("技能列表（项目级 2 个）", apiProject.length === 2, JSON.stringify(j.skills?.map((s: any) => s.name)));
    check("列表含来源层级 project", apiProject.every((s: any) => s.level === "project"));
    // 添加显式引用（path）
    r = await call("/api/skills", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "good-skill", path: join(skillDir, "good-skill") }),
    });
    j = await r.json();
    check("添加显式引用成功", r.status === 200 && j.ok, JSON.stringify(j));
    // 非法 path → 400
    r = await call("/api/skills", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nope", path: join(proj, "nonexistent") }),
    });
    check("非法 SKILL.md 路径 → 400", r.status === 400);
    // 移除显式引用
    r = await call("/api/skills/good-skill", { method: "DELETE" });
    j = await r.json();
    check("移除显式引用成功", r.status === 200 && j.ok);
    r = await call("/api/skills/good-skill", { method: "DELETE" });
    check("移除不存在 → 404", r.status === 404);
  } finally {
    // v3.6：无需恢复——config 已重定向到临时数据目录，随 tmpData 一并清理
  }
}

// ── 6. 工具层：plugin_add / use_skill ──
console.log("\n▶ plugin_add / use_skill 工具层");
{
  // v3.9：默认档位已改 full——本段验证 plugin_add 审批触发（high + requireExplicit），
  // 必须显式固定 confirm 档（low 也弹窗，requireExplicit 必然弹窗）
  writeFileSync(join(tmpData, "config.json"), JSON.stringify({ version: 2, models: [], providers: [], approvalPolicy: { mode: "confirm" } }, null, 2), "utf-8");
  // plugin_add：审批触发（high + requireExplicit）
  const approvals: Array<{ desc: string; risk: string; exp: boolean }> = [];
  const ctx = {
    root: proj, cwd: proj,
    requestApproval: async (desc: string, risk: "low" | "medium" | "high", requireExplicit?: boolean) => {
      approvals.push({ desc, risk, exp: requireExplicit === true });
      return false;
    },
    emit: () => {},
  } as any;
  const t = TOOLS["plugin_add"];
  check("plugin_add 已注册且 high", !!t && t.risk === "high");
  const out = await t.execute({ id: "x-plugin", path: goodPlugin }, ctx);
  check("审批触发（high + requireExplicit）", approvals.length === 1 && approvals[0].risk === "high" && approvals[0].exp);
  check("拒绝返回提示", out.includes("拒绝"));

  // use_skill：读取 + 未找到
  const t2 = TOOLS["use_skill"];
  check("use_skill 已注册且 low", !!t2 && t2.risk === "low");
  const out2 = await t2.execute({ name: "good-skill" }, ctx);
  check("use_skill 读取全文", out2.includes("按以下步骤执行"));
  const out3 = await t2.execute({ name: "no-such" }, ctx);
  check("未找到技能 → 提示可用列表", out3.includes("未找到技能") && out3.includes("good-skill"));
}

// 清理临时数据目录（v3.6：只删测试自己的临时目录，绝不动用户 ~/.infu）
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
