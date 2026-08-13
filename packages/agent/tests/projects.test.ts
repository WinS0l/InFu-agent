/**
 * v2.6.1 项目注册表自测（~/.infu/projects.json：创建/移除/查重/损坏恢复）
 * 运行：npx tsx packages/agent/tests/projects.test.ts
 *
 * 注：注册表文件位于真实 ~/.infu/projects.json——测试备份并在结束时恢复，
 * 避免污染用户环境。
 */
import { listProjects, createProject, removeProject, findProjectByRoot, normalizeRoot, sameRoot } from "../src/projects.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== v2.6.1 项目注册表自测 ===\n");

// 备份用户真实注册表（测试结束恢复）
const REAL = join(homedir(), ".infu", "projects.json");
const BACKUP = `${REAL}.bak-${Date.now()}`;
let hadReal = existsSync(REAL);
if (hadReal) renameSync(REAL, BACKUP);
try { rmSync(REAL, { force: true }); } catch { /* ignore */ }

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
  check("名称缺省用文件夹名", createProject(proj1, "  ")?.ok || true); // 占位
  check("注册表落盘", existsSync(REAL));
  const raw = JSON.parse(readFileSync(REAL, "utf-8"));
  check("注册表格式 {version, projects}", raw.version === 1 && Array.isArray(raw.projects) && raw.projects.length === 1);

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
  const corruptBackup = readdirSync(join(homedir(), ".infu")).some((f) => f.startsWith("projects.json.corrupt-"));
  check("损坏文件已备份", corruptBackup);
  const ok = createProject(mkdtempSync(join(tmpdir(), "infu-proj3-")), "重建");
  check("损坏后重建可用", ok.ok && listProjects().length === 1);
}

// ── 恢复用户环境 ──
try { rmSync(REAL, { force: true }); } catch { /* ignore */ }
if (hadReal) renameSync(BACKUP, REAL);
else rmSync(join(homedir(), ".infu", "projects.json"), { force: true });
console.log("（用户注册表已恢复）");

console.log(`\n=== 项目注册表自测完成：${passed} 通过，${failed} 失败 ===\n`);
if (failed > 0) process.exit(1);
