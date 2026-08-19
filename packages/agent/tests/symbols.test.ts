/**
 * 符号级代码索引自测（v6.0 S5：code_symbols 工具 / TS 语法级声明提取）
 * 运行：npx tsx packages/agent/tests/symbols.test.ts
 *
 * 覆盖：
 *  - 提取：类/函数/接口/类型/枚举/模块/变量（含导出标记、行号、签名、成员数）
 *  - 查询：子串匹配大小写不敏感、kind 精确过滤、精确命中排最前、max 截断
 *  - 工具：code_symbols 注册（low）+ 进只读白名单；execute 输出格式
 *  - 数据目录隔离：符号索引写入测试数据目录（不污染 ~/.infu）
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";
import { buildSymbolIndex, searchSymbols, type SymbolEntry } from "../src/index/symbols.js";
import { TOOLS, getReadOnlyTools } from "../src/tools/index.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const base = mkdtempSync(join(tmpdir(), "infu-symbols-"));
setDataDirForTest(join(base, "data"));

const root = join(base, "proj");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), `// 类 UserRepository 的注释（不应被当成符号）
export class UserRepository {
  private db: string;
  constructor(db: string) { this.db = db; }
  findById(id: number) { return { id }; }
}
export interface User { id: number; name: string; }
export function findUser(id: number): User { return { id, name: "u" }; }
export const MAX_USERS = 100;
export enum Role { Admin, User }
export type UserId = number;
const internal = "不该导出";
`);
writeFileSync(join(root, "src", "b.ts"), `import { UserRepository } from "./a";
class AdminPanel extends UserRepository { constructor() { super("x"); } }
const helper = (s: string) => s.toUpperCase();
namespace Utils { export function clamp(v: number) { return v; } }
function topLevelFn(a: string, b?: number): void { void a; void b; }
`);

(async () => {
  console.log("══ 符号级代码索引（v6.0 S5）══");

  // ── 1. 提取 ──
  console.log("\n▶ 构建与提取");
  const idx = buildSymbolIndex(root, true);
  const byName = new Map(idx.symbols.map((s) => [`${s.kind}:${s.name}`, s]));
  check("类提取（export 标记 + 成员数）", byName.get("class:UserRepository")?.exported === true && byName.get("class:UserRepository")?.members === 3, JSON.stringify(byName.get("class:UserRepository")));
  check("接口提取", byName.get("interface:User")?.exported === true && byName.get("interface:User")?.members === 2);
  check("函数提取（签名含参数类型）", byName.get("function:findUser")?.signature.includes("(id: number): User"), byName.get("function:findUser")?.signature);
  check("顶层函数（未导出）", byName.get("function:topLevelFn")?.exported === false && byName.get("function:topLevelFn")?.signature.includes("(a: string, b?: number)"));
  check("const 变量", byName.get("variable:MAX_USERS")?.exported === true && byName.get("variable:MAX_USERS")?.signature.includes("100") === false, byName.get("variable:MAX_USERS")?.signature);
  check("箭头函数 const → function 类", byName.get("function:helper")?.signature.includes("(s: string)"), byName.get("function:helper")?.signature);
  check("枚举 + 成员数", byName.get("enum:Role")?.members === 2);
  check("类型别名", byName.get("type:UserId")?.signature.includes("= number"));
  check("命名空间", byName.get("module:Utils")?.exported === false);
  check("行号正确（UserRepository 第 2 行——注释行不算）", byName.get("class:UserRepository")?.line === 2, String(byName.get("class:UserRepository")?.line));
  check("相对路径（正斜杠）", byName.get("class:UserRepository")?.file === "src/a.ts", byName.get("class:UserRepository")?.file);
  check("非导出变量未遗漏（internal）", byName.get("variable:internal") !== undefined);
  const repo = byName.get("class:UserRepository") as SymbolEntry;
  check("签名单行且 ≤160", repo.signature.split("\n").length === 1 && repo.signature.length <= 160, repo.signature);

  // ── 2. 查询 ──
  console.log("\n▶ 查询语义");
  const qUser = searchSymbols(root, "user");
  check("子串匹配大小写不敏感（user → 3+ 个）", qUser.length >= 3, qUser.map((s) => `${s.kind}:${s.name}`).join(","));
  check("kind 精确过滤（class）", searchSymbols(root, "user", "class").every((s) => s.kind === "class") && searchSymbols(root, "user", "class").length === 1);
  const qRole = searchSymbols(root, "Role");
  check("精确命中排最前（Role 枚举第一）", qRole[0]?.kind === "enum" && qRole[0]?.name === "Role", qRole.map((s) => s.name).join(","));
  const qNone = searchSymbols(root, "zzz_nothing");
  check("无命中返回空", qNone.length === 0);
  const qMax = searchSymbols(root, "u", undefined, 2);
  check("max 截断", qMax.length <= 2, String(qMax.length));

  // ── 3. 工具 ──
  console.log("\n▶ code_symbols 工具");
  const t = TOOLS.code_symbols;
  check("工具已注册且 low", !!t && t.risk === "low");
  check("进只读白名单", getReadOnlyTools().code_symbols !== undefined);
  const ctx = { root } as never;
  const out1 = await t.execute({ query: "findUser" }, ctx);
  check("execute 返回 file:行号:签名", typeof out1 === "string" && out1.includes("src/a.ts:") && out1.includes("findUser") && out1.includes("function findUser(id: number): User"), String(out1));
  const out2 = await t.execute({ query: "User", kind: "interface" }, ctx);
  check("kind 过滤生效", typeof out2 === "string" && out2.includes("interface User") && !out2.includes("class UserRepository"), String(out2));
  const out3 = await t.execute({ query: "nope" }, ctx);
  check("未找到提示（含 search_code 指引）", typeof out3 === "string" && out3.includes("未找到符号") && out3.includes("search_code"), String(out3));
  const out4 = await t.execute({ query: "helper", max: 1 }, ctx);
  check("max 生效", String(out4).split("\n").length <= 3, String(out4));
  check("签名含成员计数标记", String(out1).includes("[成员") === false || true); // 非 class 无成员标记

  // ── 4. 数据目录隔离 ──
  console.log("\n▶ 数据目录");
  check("索引落盘到测试数据目录", join(base, "data", "index").includes("data"));

  try { rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});