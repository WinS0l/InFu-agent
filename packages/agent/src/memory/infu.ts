/**
 * v2.6 项目指令文件（INFU.md，对齐 CLAUDE.md / AGENTS.md 生态惯例）
 *
 * - 发现：<root>/INFU.md 优先，其次 <root>/AGENTS.md（生态通用约定兜底）
 * - 注入：全量进 system（上限保护，参考 Codex project_doc_max_bytes = 32KiB）
 * - 作用域：解析「路径作用域」节（- 允许: X / - 禁止: Y，** 跨段、* 单段）→ ScopeRule[]
 *
 * 内容分工（生态共识）：INFU.md = 团队/用户必须遵守的规则（测试命令、代码标准、
 * 禁止项），记忆文件 = 历史决策/偏好/教训（见 store.ts）。
 */

import fs from "node:fs";
import path from "node:path";
import type { ScopeRule } from "@infu/shared";

/** 指令文件合并上限（Codex 同款 project_doc_max_bytes；超过截断并提示） */
export const INSTRUCTION_MAX_BYTES = 32 * 1024;

/** 候选指令文件名（INFU.md 优先，AGENTS.md 生态兜底） */
const CANDIDATE_NAMES = ["INFU.md", "AGENTS.md"];

/** 查找项目指令文件；不存在返回 null */
export function findInstructionFile(root: string): { path: string; content: string; truncated: boolean } | null {
  for (const name of CANDIDATE_NAMES) {
    const p = path.join(root, name);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const raw = fs.readFileSync(p, "utf-8");
    const truncated = raw.length > INSTRUCTION_MAX_BYTES;
    return {
      path: p,
      content: truncated
        ? raw.slice(0, INSTRUCTION_MAX_BYTES) + `\n\n（已截断：文件超过 ${INSTRUCTION_MAX_BYTES} 字节上限，请精简后重新加载）`
        : raw,
      truncated,
    };
  }
  return null;
}

/**
 * 解析「路径作用域」节：- 允许: pattern / - 禁止: pattern 行。
 * 位置不限（INFU.md 任意处），便于用户随手维护。
 */
export function parseScopeRules(content: string): ScopeRule[] {
  const out: ScopeRule[] = [];
  const re = /^[-*]\s*(允许|禁止)\s*[:：]\s*(.+)$/gm;
  for (const m of content.matchAll(re)) {
    const allow = m[1] === "允许";
    const pattern = m[2].trim().replace(/^[`"']|[`"']$/g, "").trim();
    if (!pattern) continue;
    out.push({ allow, pattern });
  }
  return out;
}

/** glob → 正则（** 跨段含零段、* 单段、? 单字符；其余原样） */
export function globToRegExp(glob: string): RegExp {
  let body = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        body += ".*";
        i++;
      } else body += "[^/]*";
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      body += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // 尾部 /** 同时匹配其根本身与任意子孙（packages/** 匹配 packages、packages/x、packages/a/b）
  if (glob.endsWith("/**")) {
    body = body.slice(0, -2).replace(/\/$/, "") + "(?:/.*)?";
  }
  return new RegExp(`^${body}$`);
}

/**
 * 路径作用域校验（相对 root 路径；正斜杠归一）。
 * 语义：命中禁止 → 拒绝；有允许规则时未命中任何允许 → 拒绝（白名单模式）；
 * 无规则或纯禁止规则未命中 → 放行（root 内默认行为不变）。
 * 返回拒绝原因或 null（放行）。
 */
export function checkPathScope(rel: string, rules?: ScopeRule[]): string | null {
  if (!rules?.length) return null;
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  let allowHit = false;
  for (const r of rules) {
    if (!r.pattern) continue;
    if (!globToRegExp(r.pattern).test(norm)) continue;
    if (!r.allow) return `命中禁止规则「${r.pattern}」`;
    allowHit = true;
  }
  if (rules.some((r) => r.allow)) {
    return allowHit ? null : `不在允许范围内（现有允许规则未覆盖该路径）`;
  }
  return null;
}

/** 构建注入 system 的指令段（无指令文件返回空串） */
export function buildInfuPrompt(root: string): string {
  const f = findInstructionFile(root);
  if (!f) return "";
  return `\n\n【项目指令 ${path.basename(f.path)}】（用户/项目权威规则，必须遵守；与本任务的指示冲突时以本指令为准）\n${f.content}`;
}

/** 构建 Executor 记忆引导段（记忆读写用法 + 自动沉淀说明） */
export function buildMemoryPrompt(): string {
  return `\n\n【记忆系统】
- 记忆分三层：项目指令（本 system 内）、项目记忆 .infu/memory/ 与全局记忆 ~/.infu/memory/（主题文件）、项目历史 .infu/history/（本任务完成后系统自动归档交付报告，无需你处理）。
- 开始任务前，若需要了解项目既有约定/踩坑教训，用 memory_read 查看（不传 topic 可列出可用主题）。
- 当你在任务中发现**值得下次任务复用的稳定知识**（项目约定、架构事实、踩坑教训、用户明确偏好）时，用 memory_write 记录到合适主题（conventions=约定 / lessons=教训 / preferences=偏好，可自建主题）。要求：简短、准确、可复用；不要记录任务过程流水账（系统会自动归档），不要重复已存在的内容。`;
}
