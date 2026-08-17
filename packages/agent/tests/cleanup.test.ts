/**
 * v3.5 数据生命周期测试：
 *  - maybeRotateLog：日志超限滚动保留 N 份
 *  - cleanupOldBackups：损坏备份超期删除、未超期保留
 *  - 会话删除联动清理（同 server 逻辑）：outputs/browser 会话前缀文件 + attachments 目录
 *  - removeProject 删除孤儿索引 + config 损坏备份联动清理
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maybeRotateLog, MAX_LOG_BYTES } from "../src/sandbox/index.js";
import { cleanupOldBackups } from "../src/cleanup.js";
import { createProject, removeProject, listProjects } from "../src/projects.js";
import { buildIndex, loadIndex, deleteIndex } from "../src/index/index.js";
import { resolveDataDir, setDataDirForTest } from "../src/data-dir.js";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infu-cleanup-"));
// v3.5 审计修复：数据目录重定向到临时目录——原测试在真实 ~/.infu/ 下创建又删除
// attachments/写 projects.json（备份恢复），风险面大；现在全部落到临时数据目录，
// 末尾统一清理，不碰用户数据（projects/attachments/config 均经 resolveDataDir() 惰性解析）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "infu-cleanup-data-"));
setDataDirForTest(tmpData);

// ── 1. maybeRotateLog ──
console.log("▶ 日志轮转（超限滚动保留 3 份）");
{
  const log = path.join(dir, "agent.log");
  fs.writeFileSync(log, "x".repeat(MAX_LOG_BYTES));
  maybeRotateLog(log);
  check("超限后轮转：主文件被移走", !fs.existsSync(log) || fs.statSync(log).size < MAX_LOG_BYTES);
  check("产生 .log.1", fs.existsSync(log + ".1"));
  maybeRotateLog(log);
  fs.writeFileSync(log, "new", "utf-8");
  check("轮转后新写正常", fs.readFileSync(log, "utf-8") === "new");
  fs.writeFileSync(log, "small", "utf-8");
  const mtime = fs.statSync(log).mtimeMs;
  maybeRotateLog(log);
  check("小文件不轮转", fs.existsSync(log) && fs.statSync(log).mtimeMs >= mtime);
}

// ── 2. cleanupOldBackups ──
console.log("▶ 损坏备份清理（超期删除 / 未超期保留）");
{
  const file = path.join(dir, "projects.json");
  fs.writeFileSync(file, "{}", "utf-8");
  const old = file + ".corrupt-1700000000000";
  const fresh = file + ".corrupt-" + Date.now();
  fs.writeFileSync(old, "x", "utf-8");
  fs.writeFileSync(fresh, "x", "utf-8");
  // 超期备份：mtime 设为过去（命名时间戳只是标识，清理按 mtime）
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(old, past, past);
  cleanupOldBackups(file, 1000);
  check("超期备份已删除", !fs.existsSync(old));
  check("未超期备份保留", fs.existsSync(fresh));
  check("主文件不动", fs.existsSync(file));
}

// ── 3. 会话删除联动清理（同 server 逻辑：前缀匹配删 outputs/browser + attachments）──
console.log("▶ 会话删除联动清理");
{
  const root = path.join(dir, "proj");
  fs.mkdirSync(path.join(root, ".infu", "outputs"), { recursive: true });
  fs.mkdirSync(path.join(root, ".infu", "browser"), { recursive: true });
  const sid8 = "abc12345";
  // 附件暂存目录按 resolveDataDir()（测试已重定向到临时数据目录）
  const realAttach = path.join(resolveDataDir(), "attachments", "cleanup-test-session-zz");
  fs.mkdirSync(realAttach, { recursive: true });
  fs.writeFileSync(path.join(root, ".infu", "outputs", `${sid8}-m0x-abc.log`), "big output", "utf-8");
  fs.writeFileSync(path.join(root, ".infu", "outputs", "other-sess.log"), "keep me", "utf-8");
  fs.writeFileSync(path.join(root, ".infu", "browser", `${sid8}-shot-abc.png`), "img", "utf-8");
  fs.writeFileSync(path.join(root, ".infu", "browser", "other.png"), "keep", "utf-8");
  // 模拟 server 会话删除逻辑
  const id = "cleanup-test-session-zz";
  try {
    for (const [d, prefix] of [
      [path.join(root, ".infu", "outputs"), `${sid8}-`],
      [path.join(root, ".infu", "browser"), `${sid8}-`],
    ] as const) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        if (f.startsWith(prefix)) fs.rmSync(path.join(d, f), { force: true });
      }
    }
    fs.rmSync(path.join(resolveDataDir(), "attachments", id), { recursive: true, force: true });
  } catch { /* ignore */ }
  check("本会话 outputs 已删", !fs.existsSync(path.join(root, ".infu", "outputs", `${sid8}-m0x-abc.log`)));
  check("他会话 outputs 保留", fs.existsSync(path.join(root, ".infu", "outputs", "other-sess.log")));
  check("本会话 browser 已删", !fs.existsSync(path.join(root, ".infu", "browser", `${sid8}-shot-abc.png`)));
  check("他会话 browser 保留", fs.existsSync(path.join(root, ".infu", "browser", "other.png")));
  check("attachments 目录已删", !fs.existsSync(realAttach));
}

// ── 4. 项目移除 → 索引孤儿删除 ──
console.log("▶ 索引孤儿清理");
{
  const root = path.join(dir, "idx-proj");
  fs.mkdirSync(root, { recursive: true });
  buildIndex(root);
  check("索引已建", loadIndex(root) !== null);
  const created = createProject(root, "idx-proj");
  check("项目创建成功", created.ok === true, JSON.stringify(created));
  const removed = removeProject(created.project!.id);
  check("项目移除成功", removed.ok === true, removed.message);
  check("索引文件已删（无孤儿）", loadIndex(root) === null);
  deleteIndex(root);
}

// ── 5. config 损坏备份 + 超期清理联动（临时数据目录内，不碰用户数据）──
console.log("▶ 损坏备份 + 超期清理联动");
{
  const realFile = path.join(resolveDataDir(), "projects.json");
  const hadReal = fs.existsSync(realFile);
  const realBackup = path.join(os.tmpdir(), "infu-projects-real-backup-" + Date.now());
  if (hadReal) fs.copyFileSync(realFile, realBackup);
  const oldBackup = realFile + ".corrupt-1500000000000";
  fs.writeFileSync(oldBackup, "old", "utf-8");
  // 超期 = 超过默认保留期 7 天（projects.ts 用默认 BACKUP_MAX_AGE_MS 清理）
  const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(oldBackup, past, past);
  try {
    fs.writeFileSync(realFile, "not-json{", "utf-8");
    const projs = listProjects();
    check("损坏文件读为空列表", Array.isArray(projs) && projs.length === 0);
    const backups = fs.readdirSync(resolveDataDir()).filter((x) => x.startsWith("projects.json."));
    check("损坏备份已产生", backups.length >= 1, backups.join(","));
    check("超期旧备份已被清理", !fs.existsSync(oldBackup));
  } finally {
    if (hadReal) {
      fs.copyFileSync(realBackup, realFile);
      fs.rmSync(realBackup, { force: true });
    } else {
      fs.rmSync(realFile, { force: true });
    }
  }
}

// 清理
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
