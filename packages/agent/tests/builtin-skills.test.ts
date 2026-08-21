/**
 * v2.7 批 1 官方插件 + 插件技能挂载自测
 * 运行：npx tsx packages/agent/tests/builtin-skills.test.ts
 */
import { listSkills, registerPluginSkillDirs, parseSkillFrontmatter } from "../src/plugin/skills.js";
import { loadPlugins, mergeBuiltinPlugins } from "../src/plugin/index.js";
import { listBuiltinPlugins, isBuiltinPlugin } from "../src/plugin/marketplace.js";
import { existsSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 内置插件与技能挂载自测 ===\n");

// 1. 官方插件注册表
console.log("▶ 官方插件注册表");
const builtin = listBuiltinPlugins();
check("2 个官方插件", ["browser-use", "skill-creator"].every((id) => builtin.some((b) => b.id === id)) && !builtin.some((b) => b.id === "document-skills"), builtin.map((b) => b.id).join(","));
check("模块路径存在", builtin.every((b) => existsSync(b.path)), builtin.map((b) => b.id + ":" + existsSync(b.path)).join(";"));
check("isBuiltinPlugin 判断", isBuiltinPlugin("browser-use") && !isBuiltinPlugin("my-plugin"));

// 2. mergeBuiltinPlugins：默认启用 + 禁用标记
console.log("\n▶ 内置插件合并");
const merged = mergeBuiltinPlugins([]);
check("空配置 → 2 个内置插件", merged.length === 2, JSON.stringify(merged.map((m) => m.id)));
const disabled = mergeBuiltinPlugins([{ id: "browser-use", path: "x", source: "builtin", enabled: false }]);
check("禁用标记生效（browser-use 不加载）", !disabled.some((m) => m.id === "browser-use") && disabled.some((m) => m.id === "skill-creator"), JSON.stringify(disabled.map((m) => m.id)));

// 3. loadPlugins 挂载内置插件技能
console.log("\n▶ 插件技能挂载");
const events: unknown[] = [];
const r = await loadPlugins([], (e) => events.push(e));
check("无失败插件", r.failures.length === 0, JSON.stringify(r.failures));
// v3.0 批 5：+browser_tabs/browser_tab_new/browser_tab_select/browser_viewport → 12 工具
check("browser-use 12 工具", r.tools.length === 12 && r.tools.some((t) => t.name === "browser_tab_select") && r.tools.some((t) => t.name === "browser_viewport"), JSON.stringify(r.tools.map((t) => t.name)));
check("插件技能目录 3 个", r.skillDirs.length === 3, JSON.stringify(r.skillDirs.map((d) => d.split(/[\\/]/).pop())));
registerPluginSkillDirs(r.skillDirs);
const skills = listSkills({ models: [] }, "E:/nonexistent-root");
check("skill-creator 以 plugin 级挂载", skills.some((s) => s.name === "skill-creator" && s.level === "plugin"), skills.map((s) => s.name + ":" + s.level).join(","));
check("control-browser/web-gui-tester 以 plugin 级挂载", ["control-browser", "web-gui-tester"].every((n) => skills.some((s) => s.name === n)), skills.map((s) => s.name).join(","));

// 4. YAML 折叠块解析
console.log("\n▶ YAML 折叠块");
const fm = parseSkillFrontmatter("---\nname: pdf\ndescription: >\n  第一行\n  第二行\nlicense: MIT\n---\n");
check("折叠块 description 拼接", fm?.description === "第一行 第二行", JSON.stringify(fm));

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
