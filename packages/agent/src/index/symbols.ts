/**
 * v6.0（S5）符号级代码索引——TS/JS 声明提取（类/函数/接口/类型/枚举/模块/变量）。
 *
 * 原理：逐文件 ts.createSourceFile 语法级解析（无类型检查、不解析依赖图——声明结构
 * 是语法信息，无需 Program；比 ts-morph/完整 Program 轻量得多，20k 文件量级秒级完成）。
 * 用途：code_symbols 工具——「哪里定义了 X / 谁导出 Y」语义级定位，比 search_code 的
 * 正则文本匹配更精准（排除注释/字符串/同名变量噪声）。
 *
 * 持久化：<dataDir>/index/<rootHash>-symbols.json（与文件索引同目录，互不覆盖）。
 * 进程内缓存：按 root 缓存，refresh=true 强制重建。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";
import { resolveDataDir } from "../data-dir.js";
import { collectFiles } from "./index.js";

export type SymbolKind = "class" | "function" | "interface" | "type" | "enum" | "variable" | "module";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  /** 相对 root 的路径（正斜杠） */
  file: string;
  /** 1-based 行号 */
  line: number;
  exported: boolean;
  /** 单行签名（≤160 字符） */
  signature: string;
  /** class/enum：成员数（选填） */
  members?: number;
}

export interface SymbolIndex {
  root: string;
  builtAt: number;
  symbols: SymbolEntry[];
}

const SKIP_EXT = new Set([".json", ".md", ".txt", ".css", ".html", ".yml", ".yaml", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".wasm", ".map"]);
const MAX_FILE_SIZE = 2 * 1024 * 1024;

function symbolsPath(root: string): string {
  const hash = crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12);
  const dir = path.join(resolveDataDir(), "index");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, hash + "-symbols.json");
}

/** 提取声明的单行签名（截断 160） */
function oneLine(text: string, max = 160): string {
  return text.split("\n")[0].trim().replace(/\s+/g, " ").slice(0, max);
}

function paramsText(params: ts.NodeArray<ts.ParameterDeclaration> | undefined): string {
  return (params ?? [])
    .map((p) => {
      const name = p.name.getText();
      // 可选参数：可选标记在参数节点（questionToken）而非名字上
      const opt = p.questionToken ? "?" : "";
      const type = p.type ? `: ${p.type.getText()}` : "";
      return name + opt + type;
    })
    .join(", ")
    .slice(0, 120);
}

function modifiersText(mods: readonly ts.ModifierLike[] | undefined): string {
  return (mods ?? []).map((m) => m.getText()).join(" ");
}

/** 类型参数渲染（NodeArray 无 getText——逐项取文本） */
function typeParamsText(tps: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): string {
  return tps && tps.length ? `<${tps.map((t) => t.getText()).join(", ")}>` : "";
}

/** 单文件声明提取（语法级，无类型检查） */
function extractSymbols(file: string, relative: string, out: SymbolEntry[]): void {
  let text: string;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_SIZE) return;
    text = fs.readFileSync(file, "utf-8");
  } catch { return; }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, path.extname(file).startsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);

  const visit = (node: ts.Node): void => {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const exported = !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const def = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    void def;

    if (ts.isClassDeclaration(node) && node.name) {
      const sig = `class ${node.name.text}${typeParamsText(node.typeParameters)}${node.heritageClauses?.length ? " " + node.heritageClauses.map((h) => h.getText()).join(" ") : ""}`;
      out.push({
        name: node.name.text, kind: "class", file: relative,
        line: sf.getLineAndCharacterOfPosition(node.name.getStart(sf)).line + 1,
        exported, signature: oneLine(sig), members: node.members.length,
      });
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      const sig = `${modifiersText(mods) ? modifiersText(mods) + " " : ""}function ${node.name.text}${typeParamsText(node.typeParameters)}(${paramsText(node.parameters)})${node.type ? `: ${node.type.getText()}` : ""}`;
      out.push({
        name: node.name.text, kind: "function", file: relative,
        line: sf.getLineAndCharacterOfPosition(node.name.getStart(sf)).line + 1,
        exported, signature: oneLine(sig),
      });
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      const sig = `interface ${node.name.text}${typeParamsText(node.typeParameters)}${node.heritageClauses?.length ? " " + node.heritageClauses.map((h) => h.getText()).join(" ") : ""}`;
      out.push({
        name: node.name.text, kind: "interface", file: relative,
        line: sf.getLineAndCharacterOfPosition(node.name.getStart(sf)).line + 1,
        exported, signature: oneLine(sig), members: node.members.length,
      });
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      out.push({
        name: node.name.text, kind: "type", file: relative,
        line: sf.getLineAndCharacterOfPosition(node.name.getStart(sf)).line + 1,
        exported, signature: oneLine(`type ${node.name.text}${typeParamsText(node.typeParameters)} = ${node.type.getText()}`),
      });
    } else if (ts.isEnumDeclaration(node) && node.name) {
      out.push({
        name: node.name.text, kind: "enum", file: relative,
        line: sf.getLineAndCharacterOfPosition(node.name.getStart(sf)).line + 1,
        exported, signature: oneLine(`enum ${node.name.text}`), members: node.members.length,
      });
    } else if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      out.push({
        name: node.name.text, kind: "module", file: relative,
        line: sf.getLineAndCharacterOfPosition(node.name.getStart(sf)).line + 1,
        exported, signature: oneLine(`namespace ${node.name.text}`),
      });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue; // 解构/重命名跳过
        const init = decl.initializer;
        const isFn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const kind: SymbolKind = isFn ? "function" : "variable";
        const sig = isFn && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          ? `const ${decl.name.text} = ${ts.isArrowFunction(init) ? "(" + paramsText(init.parameters) + ")" : "function"}${init.type ? `: ${init.type.getText()}` : ""}`
          : `const ${decl.name.text}${decl.type ? `: ${decl.type.getText()}` : ""}`;
        out.push({
          name: decl.name.text, kind, file: relative,
          line: sf.getLineAndCharacterOfPosition(decl.name.getStart(sf)).line + 1,
          exported: !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
          signature: oneLine(sig),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** 构建符号索引（缓存：同 root 重复调用直接读盘；refresh 强制重建） */
export function buildSymbolIndex(root: string, refresh = false): SymbolIndex {
  const p = symbolsPath(root);
  if (!refresh) {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const idx = JSON.parse(raw) as SymbolIndex;
      if (idx?.symbols && Array.isArray(idx.symbols) && idx.root === path.resolve(root)) return idx;
    } catch { /* 重建 */ }
  }
  const symbols: SymbolEntry[] = [];
  for (const f of collectFiles(root)) {
    if (SKIP_EXT.has(path.extname(f.file).toLowerCase())) continue;
    const abs = path.resolve(root, f.file);
    try { extractSymbols(abs, f.file, symbols); } catch { /* 单个文件失败跳过 */ }
  }
  symbols.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const idx: SymbolIndex = { root: path.resolve(root), builtAt: Date.now(), symbols };
  try { fs.writeFileSync(p, JSON.stringify(idx), "utf-8"); } catch { /* 落盘失败不阻塞 */ }
  return idx;
}

/** 按名称/类型过滤符号（评分：精确 > 前缀 > 包含；kind 精确过滤） */
export function searchSymbols(
  root: string,
  query: string,
  kind?: SymbolKind,
  max = 20,
  refresh = false
): SymbolEntry[] {
  const idx = buildSymbolIndex(root, refresh);
  const q = query.toLowerCase();
  const scored: Array<{ s: SymbolEntry; score: number }> = [];
  for (const s of idx.symbols) {
    if (kind && s.kind !== kind) continue;
    const name = s.name.toLowerCase();
    let score = -1;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else continue;
    scored.push({ s, score });
  }
  scored.sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, max).map((x) => x.s);
}

/** 删除某 root 的符号索引（项目移除时清理孤儿；不存在静默） */
export function deleteSymbolIndex(root: string): void {
  try { fs.rmSync(symbolsPath(root), { force: true }); } catch { /* 忽略 */ }
}

/** 测试辅助：清空进程内缓存 */
export function resetSymbolIndexCache(): void { /* 无进程内缓存（索引直接读盘）；保留签名供测试对齐 */ }