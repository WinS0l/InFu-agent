/**
 * skill 加载（v2.3 批 2）— SKILL.md 社区标准兼容（agentskills.io 规范）
 *
 * progressive disclosure 三级：
 *  1. 发现层：启动/任务开始时只注入全部 skill 的 name+description（约 100 token/个）
 *  2. 激活层：模型判断任务匹配 → 调用 use_skill 工具读 SKILL.md 全文
 *  3. 执行层：按需 read_file references/ / scripts/（相对路径提示由 use_skill 给出）
 *
 * 目录约定（生态标准）：SKILL.md 必须大写、位于 skill 目录根、name 必须与目录名一致。
 * 发现顺序：config skills[] 显式引用 > ~/.infu/skills/（用户级）> <root>/.infu/skills/（项目级）；
 * 同名 skill 高优先级胜出（首个发现者生效）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { InfuConfig, SkillMeta } from "@infu/shared";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  [k: string]: unknown;
}

/** 解析 SKILL.md frontmatter（--- 包裹的 YAML 子集：key: value / 引号包裹）；解析失败返回 null */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm: SkillFrontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val: string = kv[2].trim();
    // 引号包裹去除（单/双引号）
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return fm;
}

/** 读取某 skill 目录的元信息；不合法（无 SKILL.md/缺 name/目录名不一致）返回 null */
export function readSkillMeta(dir: string, level: SkillMeta["level"]): SkillMeta | null {
  const skillFile = join(dir, "SKILL.md");
  if (!existsSync(skillFile) || !statSync(skillFile).isFile()) return null;
  const content = readFileSync(skillFile, "utf-8");
  const fm = parseSkillFrontmatter(content);
  const name = fm?.name?.trim();
  const description = fm?.description?.trim();
  if (!name || !description) return null;
  // 标准要求 name 与目录名一致（不一致时以目录名为准，防误用）
  const dirName = dir.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (name !== dirName) {
    // 宽容处理：仍加载但以目录名为准（报告原 name 供参考）
    return { name: dirName, description: `${description}`, path: skillFile, level };
  }
  return { name, description, path: skillFile, level };
}

/** 收集一个目录下的全部 skill（一层深：<dir>/<name>/SKILL.md） */
function collectDir(dir: string, level: SkillMeta["level"], out: Map<string, SkillMeta>): void {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const meta = readSkillMeta(join(dir, ent.name), level);
    if (meta && !out.has(meta.name)) out.set(meta.name, meta); // 高优先级先入 map
  }
}

/** 列出全部可用 skill（用户级 > 项目级 > config 显式；同名首个胜出） */
export function listSkills(cfg: InfuConfig | null, root: string): SkillMeta[] {
  const out = new Map<string, SkillMeta>();
  // 1. 用户级 ~/.infu/skills/
  collectDir(join(homedir(), ".infu", "skills"), "user", out);
  // 2. 项目级 <root>/.infu/skills/
  collectDir(join(root, ".infu", "skills"), "project", out);
  // 3. config 显式引用（path 指向 skill 目录；缺省按 name 查找）
  for (const s of cfg?.skills ?? []) {
    const dir = s.path ? resolve(s.path) : findSkillDir(s.name, root);
    if (!dir) continue;
    const meta = readSkillMeta(dir, "config");
    if (meta && !out.has(meta.name)) out.set(meta.name, meta);
  }
  return [...out.values()];
}

/** 按 name 在用户级/项目级目录查找 skill 目录（config 无 path 时） */
function findSkillDir(name: string, root: string): string | null {
  const user = join(homedir(), ".infu", "skills", name);
  if (existsSync(join(user, "SKILL.md"))) return user;
  const proj = join(root, ".infu", "skills", name);
  if (existsSync(join(proj, "SKILL.md"))) return proj;
  return null;
}

/** 发现层：所有 skill 的 name+description 摘要（注入 system prompt 的追加段） */
export function buildSkillsPrompt(skills: SkillMeta[]): string {
  if (!skills.length) return "";
  return (
    "\n\n【可用技能】（任务与某技能描述匹配时，调用 use_skill 工具读取该技能完整说明再执行）：\n" +
    skills.map((s) => `- ${s.name}：${s.description.slice(0, 200)}`).join("\n")
  );
}

/** 激活层：读 SKILL.md 全文（use_skill 工具使用；附 references/scripts 提示） */
export function readSkillContent(meta: SkillMeta): string {
  const content = readFileSync(meta.path, "utf-8");
  const dir = meta.path.replace(/[\\/]SKILL\.md$/, "");
  const refs = ["references", "scripts", "assets"]
    .filter((d) => existsSync(join(dir, d)))
    .map((d) => d);
  const hint =
    refs.length > 0
      ? `\n\n（该技能附带目录：${refs.join("/")}，位于 ${dir} 下，可按需用 read_file 读取相关文件）`
      : "";
  return content + hint;
}
