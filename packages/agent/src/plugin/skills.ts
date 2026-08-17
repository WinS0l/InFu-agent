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
import { join, resolve } from "node:path";
import type { InfuConfig, SkillMeta } from "@infu/shared";
import { resolveDataDir } from "../data-dir.js";

/** 插件自带技能目录（v2.7：loadPlugins 注册，listSkills/use_skill 统一读取；全局配置级，模块级即可） */
let pluginSkillDirs: string[] = [];
export function registerPluginSkillDirs(dirs: string[]): void {
  pluginSkillDirs = dirs.filter((d) => typeof d === "string" && d);
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  [k: string]: unknown;
}

/** 解析 SKILL.md frontmatter（--- 包裹的 YAML 子集：key: value / 引号包裹 / 折叠块 > / 字面块 |）；解析失败返回 null */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  // 容忍 BOM（部分编辑器/工具写 UTF-8 带 BOM，导致 ^--- 失配）
  const m = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const fm: SkillFrontmatter = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val: string = kv[2].trim();
    // YAML 块标量（> 折叠 / | 字面）：后续缩进行拼入（Anthropic 官方 document-skills 等用此写法）
    if (val === ">" || val === "|") {
      const parts: string[] = [];
      i++;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        parts.push(lines[i].trim());
        i++;
      }
      i--; // 回退，外层 i++ 指向下一个未消费行
      val = parts.join(" ");
    }
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

/** 列出全部可用 skill（用户级 > 项目级 > config 显式 > 插件自带 > 内置；同名首个胜出） */
export function listSkills(cfg: InfuConfig | null, root: string): SkillMeta[] {
  const out = new Map<string, SkillMeta>();
  // 1. 用户级 <dataDir>/skills/
  collectDir(join(resolveDataDir(), "skills"), "user", out);
  // 2. 项目级 <root>/.infu/skills/
  collectDir(join(root, ".infu", "skills"), "project", out);
  // 3. config 显式引用（path 指向 skill 目录；缺省按 name 查找）
  for (const s of cfg?.skills ?? []) {
    const dir = s.path ? resolve(s.path) : findSkillDir(s.name, root);
    if (!dir) continue;
    const meta = readSkillMeta(dir, "config");
    if (meta && !out.has(meta.name)) out.set(meta.name, meta);
  }
  // 4. 插件自带技能（v2.7：def.skills 目录；level=plugin；官方 docx/pdf/pptx/skill-creator/control-browser/web-gui-tester 均由此挂载）
  for (const sd of pluginSkillDirs ?? []) {
    const meta = readSkillMeta(sd, "plugin");
    if (meta && !out.has(meta.name)) out.set(meta.name, meta);
  }
  return [...out.values()];
}

/** 按 name 在用户级/项目级目录查找 skill 目录（config 无 path 时） */
function findSkillDir(name: string, root: string): string | null {
  const user = join(resolveDataDir(), "skills", name);
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
