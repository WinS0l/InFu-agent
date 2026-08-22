import { loadPlugins } from "../packages/agent/dist/plugin/index.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// 发布检查必须可复现，绝不读取开发者 ~/.infu/config.json。
const result = await loadPlugins([], () => {}, { mergeBuiltin: true });
const pluginIds = new Set(result.perPlugin?.map((plugin) => plugin.id) ?? []);
const requiredPlugins = ["browser-use", "skill-creator"];
const requiredSkills = [
  resolve("packages/agent/dist/plugin/browser/skills/control-browser/SKILL.md"),
  resolve("packages/agent/dist/plugin/browser/skills/web-gui-tester/SKILL.md"),
  resolve("packages/agent/dist/skills/skill-creator/SKILL.md"),
];

const failures = [];
for (const id of requiredPlugins) {
  const ok = pluginIds.has(id);
  console.log(`插件 ${id}: ${ok ? "OK" : "MISSING"}`);
  if (!ok) failures.push(`插件 ${id} 未加载`);
}
for (const file of requiredSkills) {
  const ok = existsSync(file);
  console.log(`技能 ${file}: ${ok ? "OK" : "MISSING"}`);
  if (!ok) failures.push(`技能文件缺失：${file}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
