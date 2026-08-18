/**
 * v2.6.1 项目注册表自测（~/.infu/projects.json：创建/移除/查重/损坏恢复）
 * 运行：npx tsx packages/agent/tests/projects.test.ts
 *
 * 注：v3.6 起数据目录重定向到临时目录（setDataDirForTest）——注册表只写临时
 * 目录，不再备份/恢复真实 ~/.infu/projects.json（崩溃即污染用户数据）。
 */
import { listProjects, createProject, removeProject, findProjectByRoot, normalizeRoot, sameRoot } from "../src/projects.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== v2.6.1 项目注册表自测 ===\n");

// v3.6：数据目录重定向到临时目录——注册表（projectsFilePath 跟随 dataDir）
// 落在临时目录（原备份/恢复真实 ~/.infu/projects.json 崩溃即污染用户数据）
const tmpData = mkdtempSync(join(tmpdir(), "infu-test-"));
setDataDirForTest(tmpData);
const REAL = join(tmpData, "projects.json");

// ── 基础 ──
console.log("── 基础 ──");
{
  check("normalizeRoot 去尾分隔符", normalizeRoot("E:\\proj\\") === "E:\\proj" && normalizeRoot("E:/proj/") === "E:/proj");
  check("sameRoot 大小写不敏感（Windows）", sameRoot("E:\\Proj", "e:\\proj"));
  check("sameRoot 尾斜杠不敏感", sameRoot("E:\\proj\\", "E:\\proj"));
  check("空注册表", listProjects().length === 0);
}

// ── 创建 ──
console.log("\n── 创建 ──");
{
  const proj1 = mkdtempSync(join(tmpdir(), "infu-proj-"));
  const r1 = createProject(proj1, "测试项目");
  check("创建成功（id 生成）", r1.ok && !!r1.project && r1.project!.id.startsWith("p-"));
  // v3.6 恒真断言修复：原 `createProject(proj1, "  ")?.ok || true`（注释"占位"）恒真——
  // 且 proj1 已注册会因重复创建返回 ok:false，测不到「空名回退文件夹名」；改用独立目录真实断言
  {
    const projBlank = mkdtempSync(join(tmpdir(), "infu-proj-blank-"));
    const rb = createProject(projBlank, "  ");
    check("名称缺省用文件夹名", rb.ok === true && rb.project?.name === basename(projBlank));
  }
  check("注册表落盘", existsSync(REAL));
  const raw = JSON.parse(readFileSync(REAL, "utf-8"));
  // v3.8 修复：v3.6 新增「名称缺省用文件夹名」用例（projBlank 注册成功）后此处 length
  // 仍写 1——该断言自 v3.6 起一直失败（20 通过 1 失败，退出码 1），npm test 全链红
  check("注册表格式 {version, projects}", raw.version === 1 && Array.isArray(raw.projects) && raw.projects.length === 2);

  check("重复创建拒绝（同 root）", createProject(proj1)?.ok === false);
  check("目录不存在拒绝", createProject("E:\\no-such-dir-xyz")?.ok === false);
  check("空 root 拒绝", createProject("  ")?.ok === false);

  check("findProjectByRoot 命中", findProjectByRoot(proj1)?.name === "测试项目");
  check("findProjectByRoot 未命中", findProjectByRoot("E:\\other") === null);

  const id = r1.project!.id;
  check("listProjects 含创建", listProjects().some((p) => p.id === id));
}

// ── 移除 ──
console.log("\n── 移除 ──");
{
  const proj2 = mkdtempSync(join(tmpdir(), "infu-proj2-"));
  const r2 = createProject(proj2, "待移除");
  const id = r2.project!.id;
  check("移除成功", removeProject(id)?.ok === true);
  check("移除后列表不含", !listProjects().some((p) => p.id === id));
  check("再次移除拒绝", removeProject(id)?.ok === false);
  check("移除不删文件夹", existsSync(proj2));
}

// ── 损坏恢复 ──
console.log("\n── 损坏恢复 ──");
{
  writeFileSync(REAL, "{corrupt json!!!", "utf-8");
  check("损坏文件读取为空列表", listProjects().length === 0);
  // v3.6：损坏备份位于重定向后的数据目录（原为真实 ~/.infu）
  const corruptBackup = readdirSync(tmpData).some((f) => f.startsWith("projects.json.corrupt-"));
  check("损坏文件已备份", corruptBackup);
  const ok = createProject(mkdtempSync(join(tmpdir(), "infu-proj3-")), "重建");
  check("损坏后重建可用", ok.ok && listProjects().length === 1);
}

// ── 清理临时数据目录（v3.6：只删测试自己的临时目录，绝不动用户 ~/.infu）──
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n=== 项目注册表自测完成：${passed} 通过，${failed} 失败 ===\n`);
if (failed > 0) process.exit(1);
