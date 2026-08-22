/** Audit the unpacked 1.0.1 desktop payload without reading user data. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const resources = resolve("packages", "desktop", "release", "win-unpacked", "resources");
const asar = join(resources, "app.asar");
const asarCli = resolve("node_modules", "@electron", "asar", "bin", "asar.js");
if (!existsSync(asar) || !existsSync(asarCli)) {
  console.error("桌面包审计失败：app.asar 或本地 asar CLI 不存在，请先运行 desktop pack");
  process.exit(1);
}

const entries = execFileSync(process.execPath, [asarCli, "list", asar], { encoding: "utf8" })
  .split(/\r?\n/)
  .map((entry) => entry.replaceAll("\\", "/"));
const required = [
  "/node_modules/@infu/agent/dist/plugin/browser/skills/control-browser/SKILL.md",
  "/node_modules/@infu/agent/dist/plugin/browser/skills/web-gui-tester/SKILL.md",
  "/node_modules/@infu/agent/dist/skills/skill-creator/SKILL.md",
];
const missing = required.filter((entry) => !entries.includes(entry));
if (!existsSync(join(resources, "web", "dist", "index.html"))) missing.push("/web/dist/index.html (extraResources)");

const forbidden = entries.filter((entry) =>
  /(?:^|\/)(?:\.infu|config\.json|sessions?\.db|attachments?|logs?|screenshots?)(?:\/|$)/i.test(entry),
);
if (missing.length || forbidden.length) {
  if (missing.length) console.error(`桌面包缺少发布资源：\n${missing.join("\n")}`);
  if (forbidden.length) console.error(`桌面包包含本地/敏感数据路径：\n${forbidden.slice(0, 50).join("\n")}`);
  process.exit(1);
}
console.log(`✓ 桌面包内容审计通过（${entries.length} 个 ASAR 条目，技能与 Web 资源齐全，无本地数据路径）`);
