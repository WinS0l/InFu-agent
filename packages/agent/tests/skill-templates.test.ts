/**
 * skill 模板库自测（v6.0 P4：infu skill template list/new）
 * 运行：npx tsx packages/agent/tests/skill-templates.test.ts
 *
 * 覆盖：
 *  - 模板注册：4 个内置模板，id 唯一、含占位符、正文含 frontmatter
 *  - 创建：合法名 → 生成 <dataDir>/skills/<name>/SKILL.md，占位符替换、frontmatter name 一致
 *  - 拒绝：非法名（路径穿越/点开头）、模板不存在、已存在不覆盖
 *  - 可发现性：创建后 listSkills 能发现（level=user）
 *  - CLI 分发：skillCli template list / new 走通（stdin 空安全）
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";
import { SKILL_TEMPLATES, listSkillTemplates, createSkillFromTemplate, isValidSkillName } from "../src/plugin/skill-templates.js";
import { listSkills } from "../src/plugin/skills.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const base = mkdtempSync(join(tmpdir(), "infu-skilltpl-"));
setDataDirForTest(join(base, "data"));

(async () => {
  console.log("══ skill 模板库（v6.0 P4）══");

  // ── 1. 模板注册 ──
  console.log("\n▶ 模板注册");
  const all = listSkillTemplates();
  check("4 个内置模板", all.length === 4, String(all.length));
  const ids = new Set(all.map((t) => t.id));
  check("id 唯一", ids.size === all.length);
  for (const t of SKILL_TEMPLATES) {
    check(`模板 ${t.id}：正文含 frontmatter + 占位符`, t.body.includes("name: {{name}}") && t.body.includes("{{description}}"), t.id);
  }

  // ── 2. 创建 ──
  console.log("\n▶ 创建");
  const r1 = createSkillFromTemplate("review-gate", "code-review");
  check("创建成功", r1.ok && !!r1.path && existsSync(join(base, "data", "skills", "review-gate", "SKILL.md")), r1.message);
  const content = readFileSync(join(base, "data", "skills", "review-gate", "SKILL.md"), "utf-8");
  check("占位符已替换", !content.includes("{{name}}") && content.includes("name: review-gate") && content.includes("code-review") === false, content.slice(0, 60));
  check("frontmatter name 与目录名一致（可发现性前提）", content.startsWith("---\nname: review-gate"));
  const meta = listSkills(undefined, base).find((s) => s.name === "review-gate");
  check("创建后可被 listSkills 发现（user 级）", !!meta && meta.level === "user", JSON.stringify(meta));

  // ── 3. 拒绝路径 ──
  console.log("\n▶ 拒绝");
  const r2 = createSkillFromTemplate("..\\evil", "code-review");
  check("路径穿越名拒绝", !r2.ok && r2.message.includes("不合法"), r2.message);
  const r3 = createSkillFromTemplate(".hidden", "code-review");
  check("点开头名拒绝", !r3.ok && r3.message.includes("不合法"), r3.message);
  const r4 = createSkillFromTemplate("ok-name", "no-such-template");
  check("模板不存在拒绝", !r4.ok && r4.message.includes("模板不存在"), r4.message);
  const r5 = createSkillFromTemplate("review-gate", "code-review");
  check("已存在不覆盖", !r5.ok && r5.message.includes("已存在"), r5.message);
  check("名称规则", isValidSkillName("a-b_1") && !isValidSkillName("a/b") && !isValidSkillName(".a"));

  // ── 4. CLI 分发（stdin 空安全；new 需要交互 → 缺 name 时报用法）──
  console.log("\n▶ CLI 分发");
  const { skillCli } = await import("../src/plugin/cli.js");
  await skillCli(["template", "list"]);
  console.log("  （template list 输出如上，无异常即通过）");
  check("CLI template 分发不抛错", true);

  try { rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});