import { loadPlugins } from "../packages/agent/dist/plugin/index.js";
import { readFileSync, existsSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.env.USERPROFILE + "/.infu/config.json", "utf8"));
const r = await loadPlugins(cfg.plugins ?? [], () => {}, { mergeBuiltin: true });
console.log("插件加载:", r.perPlugin?.map((p) => p.id).join(", "));
console.log("技能目录:");
for (const d of r.skillDirs ?? []) {
  const name = d.split(/[\/]/).pop();
  console.log(`  ${name}: SKILL.md ${existsSync(d + "/SKILL.md") ? "OK" : "MISSING"}`);
}
