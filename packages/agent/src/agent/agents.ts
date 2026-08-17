/**
 * agent 文件化定义（v2.5 批 1）— 子智能体角色 = markdown 文件（frontmatter 定义角色/工具/模型）
 *
 * 文件系统即注册：`<root>/.infu/agents/<name>.md`（项目级）与 `~/.infu/agents/<name>.md`（用户级），
 * 写入即自动发现（与 skill 同模式，无需注册工具/配置）。
 * 发现顺序：用户级 > 项目级（同名高优先级胜出）。
 *
 * progressive disclosure：
 *  1. 发现层：全部 agent 的 name+description 摘要常驻 Executor system（buildAgentsPrompt）
 *  2. 激活层：delegate_task 按 agent 名读全文执行（角色 system prompt = frontmatter 后的正文）
 *
 * frontmatter 格式（--- 包裹，YAML 子集，复用 skill 解析器）：
 *   name: <可选，缺省以文件名（去 .md）为准>
 *   description: <必填，发现层摘要>
 *   tools: <可选，工具白名单（逗号/空格分隔）；缺省 = 只读 + run_test>
 *   model: <可选，子模型 id（config models 引用）>
 *   maxSteps: <可选，子循环步数上限，缺省 12>
 *   thinkingLevel: <可选，1-4，覆盖全局/父级>
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSkillFrontmatter } from "../plugin/skills.js";

/** agent 文件元信息（发现层展示 + 委派加载） */
export interface AgentMeta {
  /** 角色名（= 文件名去 .md；delegate_task agent 参数引用） */
  name: string;
  description: string;
  /** 工具白名单（未声明 = 全部内置工具，通用子智能体） */
  tools?: string[];
  /** 子模型 id（config models 引用；可选） */
  model?: string;
  maxSteps?: number;
  thinkingLevel?: number;
  /**
   * 内部工具权限（v2.5 返工：对齐 主流 permission 语义）：
   *  allow = 父批准委派后内部工具继承授权不再逐条询问（默认）；
   *  ask  = 内部工具仍逐条走父级审批
   */
  permission?: "allow" | "ask";
  /** 子智能体沙箱档位（可选；缺省跟随全局设置） */
  sandbox?: "off" | "soft" | "restricted";
  /** 文件绝对路径（内置 agent 为 "（内置）"） */
  path: string;
  /** 来源层级：内置 > 用户级 > 项目级 */
  level: "user" | "project" | "builtin";
}

/** 完整 agent 定义（含正文 system prompt） */
export interface AgentFileDef extends AgentMeta {
  /** frontmatter 后的正文 = 角色 system prompt 主体 */
  body: string;
}

/** 内置只读工具集（只读探索子智能体：只读搜索/探索，绝不修改文件/执行命令） */
export const READONLY_TOOLS = [
  "read_file", "search_code", "list_directory", "project_scan", "git_status", "git_diff", "use_skill",
  // v2.11：后台子智能体/后台任务状态查询（只读管理）
  "list_agents", "report", "job_list", "job_output",
  // v3.3：阻塞等待后台任务完成（只读等待）
  "wait_task",
  // v3.1：目录树 / 环境 / 时间（只读探索）
  "project_tree", "os_info", "current_time",
];

/** 内置 agent（调用时机——explore=只读探索/调研（占调用大头），general-purpose=复杂多步任务） */
export const BUILTIN_AGENTS: AgentFileDef[] = [
  {
    name: "general-purpose",
    description: "通用子智能体（复杂多步任务）：深度代码审计、代码审查、功能实现等多步推理执行；可访问全部内置工具（写能力委派需一次授权审批）",
    path: "（内置）",
    level: "builtin",
    body:
      "你是 InFu 的通用子智能体，专注完成被父智能体委派的子任务。\n" +
      "要求：\n" +
      "1. 只处理委派范围的任务，不要越界修改范围外的代码；\n" +
      "2. 只使用可用工具，基于工具返回的事实行动，不要臆测；\n" +
      "3. 完成后输出结构化摘要：结论 / 关键发现 / 建议，总字数不超过 2000 字。",
  },
  {
    name: "explore",
    description: "只读探索/调研（调用时机：跨多文件扫描、摸清现状、只需结论不要文件转储——回答需要 sweeping many files 时；指定搜索广度 medium/very thorough）",
    tools: READONLY_TOOLS,
    path: "（内置）",
    level: "builtin",
    body:
      "你是 InFu 的只读探索子智能体（只读探索子智能体）。\n" +
      "要求：\n" +
      "1. 只有只读工具（read_file / search_code / list_directory / project_scan / git_status / git_diff / use_skill），绝不修改文件、绝不执行命令；\n" +
      "2. 读摘要而非整文件，定位代码而非审查代码——给出结论（含 file:line 引用），不要文件转储；\n" +
      "3. 完成后输出结构化摘要：结论 / 关键发现（含 file:line）/ 建议，总字数不超过 2000 字。",
  },
];

/** 解析 agent 文件内容；缺 frontmatter/description/正文 → 返回 null（不注册） */
export function parseAgentFile(content: string): Omit<AgentFileDef, "name" | "path" | "level"> | null {
  const fm = parseSkillFrontmatter(content);
  const description = fm?.description?.trim();
  if (!description) return null;
  const body = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") // 剥 frontmatter 块
    .trim();
  if (!body) return null;
  const tools = parseList(fm?.tools);
  const model = typeof fm?.model === "string" && fm.model.trim() ? fm.model.trim() : undefined;
  const maxSteps = toInt(fm?.maxSteps);
  const thinkingLevel = toInt(fm?.thinkingLevel);
  const permission = fm?.permission === "ask" ? "ask" : "allow";
  const sandbox = fm?.sandbox === "soft" || fm?.sandbox === "restricted" || fm?.sandbox === "off" ? fm.sandbox : undefined;
  return { description, tools, model, maxSteps, thinkingLevel, permission, sandbox, body };
}

/** 解析工具白名单（逗号/空格/换行分隔，去空去重） */
function parseList(v: unknown): string[] | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const out = [...new Set(v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
  return out.length ? out : undefined;
}

function toInt(v: unknown): number | undefined {
  if (typeof v !== "number" && typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** 读取单个 agent 定义（内置 > 用户级 > 项目级）；不存在/不合法返回 null */
export function readAgentFile(name: string, root: string): AgentFileDef | null {
  const builtin = BUILTIN_AGENTS.find((a) => a.name === name);
  if (builtin) return builtin;
  const candidates = [
    { dir: join(homedir(), ".infu", "agents"), level: "user" as const },
    { dir: join(root, ".infu", "agents"), level: "project" as const },
  ];
  for (const { dir, level } of candidates) {
    const p = join(dir, `${name}.md`);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    const parsed = parseAgentFile(readFileSync(p, "utf-8"));
    if (!parsed) continue;
    return { name, ...parsed, path: p, level };
  }
  return null;
}

/** 收集一个目录下的全部 agent（一层深：<dir>/<name>.md） */
function collectDir(dir: string, level: AgentMeta["level"], out: Map<string, AgentFileDef>): void {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const name = ent.name.slice(0, -3); // 去 .md
    if (!name) continue;
    const p = join(dir, ent.name);
    const parsed = parseAgentFile(readFileSync(p, "utf-8"));
    if (!parsed || out.has(name)) continue; // 高优先级先入 map
    out.set(name, { name, ...parsed, path: p, level });
  }
}

/** 列出全部可用 agent（内置 > 用户级 > 项目级；同名高优先级胜出）；返回完整定义（含正文） */
export function listAgents(root: string): AgentFileDef[] {
  const out = new Map<string, AgentFileDef>();
  for (const a of BUILTIN_AGENTS) out.set(a.name, a);
  collectDir(join(homedir(), ".infu", "agents"), "user", out);
  collectDir(join(root, ".infu", "agents"), "project", out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 删除用户级/项目级 agent 文件（内置不可删）；返回是否删除成功 */
export function deleteAgentFile(name: string, root: string, level: "user" | "project"): boolean {
  if (BUILTIN_AGENTS.some((a) => a.name === name)) return false;
  const dir = level === "user" ? join(homedir(), ".infu", "agents") : join(root, ".infu", "agents");
  const p = join(dir, `${name}.md`);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

/** 写入用户级/项目级 agent 文件（name 规范化校验，防路径穿越）；返回写入路径 */
export function writeAgentFile(name: string, level: "user" | "project", content: string, root: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) {
    throw new Error(`agent 名不合法（仅字母数字与中划线，≤64 字符）: ${name}`);
  }
  if (!parseAgentFile(content)) {
    throw new Error("agent 内容不合法（需要 frontmatter：description 必填 + 正文）");
  }
  const dir = level === "user" ? join(homedir(), ".infu", "agents") : join(root, ".infu", "agents");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.md`);
  writeFileSync(p, content, "utf-8");
  return p;
}

/** 发现层：全部 agent 的 name+description 摘要（追加到 Executor system，模型据此选择委派与时机） */
export function buildAgentsPrompt(agents: AgentMeta[]): string {
  if (!agents.length) return "";
  return (
    "\n\n【可用子智能体】（delegate_task 委派。调用时机：探索/调研/摸清现状 → explore（只读免审批）；深度审计/审查/实现等复杂多步任务 → general-purpose；单点查找直接搜不委派）：\n" +
    agents.map((a) => `- ${a.name}：${a.description.slice(0, 200)}`).join("\n")
  );
}
