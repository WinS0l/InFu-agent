/**
 * 语义检索（v3.0 批 11）——本地 BM25 式相关性排序（零依赖，无 embedding 模型）
 * 对齐生态：主流 的 grep/semantic 混合——关键词检索 + 相关度排序。
 * 中文分词：bigram（相邻字符对）+ 英文按词——无需词典零依赖。
 * 复用 v2.7 文件索引（loadIndex 加速文件清单），按行建倒排，BM25 打分。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPathInside } from "./util.js";

/** 中文 bigram + 英文词分词 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // 英文/数字词
  for (const m of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) tokens.push(m);
  // 中文 bigram（相邻两字）
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, "");
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
  return tokens;
}

interface Doc {
  file: string;
  lines: string[];
  terms: Map<string, number>; // term → 行内出现次数
  length: number;
}

const STOP = new Set(["", "的", "了", "在", "是", "与", "和", "或", "及", "对", "为", "有", "这", "那", "中", "上", "下", "不", "也", "就", "都", "而", "于", "其", "之", "以", "被", "把", "让", "向", "从", "到", "会", "能", "可", "要", "将", "着", "过", "吗", "呢", "啊", "吧"]);

export interface SemanticHit {
  file: string;
  line: number;
  text: string;
  score: number;
}

/**
 * BM25 检索：query 分词 → 对文档行打分（k1=1.5, b=0.75）
 * files：绝对路径清单（复用项目索引）；root：项目根（路径显示相对）
 */
export function semanticSearch(
  query: string,
  files: string[],
  root: string,
  maxResults = 10
): SemanticHit[] {
  const qTerms = tokenize(query).filter((t) => !STOP.has(t));
  if (!qTerms.length) return [];

  // 统计 df（含 term 的文档行数）与 avgdl
  const df = new Map<string, number>();
  const docLines: Array<{ file: string; line: number; text: string; terms: Map<string, number> }> = [];
  let totalLen = 0;
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue; // 二进制/不可读跳过
    }
    const lines = content.split("\n");
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const toks = tokenize(lines[i]).filter((t) => !STOP.has(t));
      if (!toks.length) continue;
      const terms = new Map<string, number>();
      for (const t of toks) terms.set(t, (terms.get(t) ?? 0) + 1);
      for (const t of new Set(toks)) {
        if (!seen.has(t)) {
          seen.add(t);
          df.set(t, (df.get(t) ?? 0) + 1);
        }
      }
      totalLen += toks.length;
      docLines.push({ file, line: i + 1, text: lines[i].trim(), terms });
    }
  }
  const N = docLines.length || 1;
  const avgdl = totalLen / N || 1;

  // BM25 打分
  const k1 = 1.5;
  const b = 0.75;
  const scored: SemanticHit[] = [];
  for (const dl of docLines) {
    let score = 0;
    for (const t of qTerms) {
      const tf = dl.terms.get(t) ?? 0;
      if (!tf) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl.terms.size / avgdl))));
    }
    if (score > 0) scored.push({ file: dl.file, line: dl.line, text: dl.text.slice(0, 160), score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((h) => ({
    ...h,
    file: isPathInside(root, h.file) ? h.file.slice(root.length + 1) : h.file,
  }));
}

/** 便捷入口：文件清单走 walk（调用方提供） */
export function semanticSearchFiles(
  query: string,
  root: string,
  walkFiles: (root: string) => string[],
  maxResults = 10
): SemanticHit[] {
  return semanticSearch(query, walkFiles(root), root, maxResults);
}
