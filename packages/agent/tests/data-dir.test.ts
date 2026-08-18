/**
 * v3.5 数据目录迁移测试：
 *  - validateTarget：绝对路径/当前目录/主目录/盘根/嵌套/文件/非空 各拒绝分支
 *  - migrateDataDir：复制 + redirect 指针写入 + 缓存失效（同进程解析即切新目录）
 *  - resolveDataDir：默认缺省 / redirect 优先 / 损坏指针回退
 *  - 迁移后各消费模块（configPath / 会话库 / projects / schedule / memory / skills / agents / sandbox 保护）跟随新目录
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveDataDir,
  invalidateDataDir,
  setDataDirForTest,
  defaultDataDir,
  migrateDataDir,
  validateTarget,
  REDIRECT_FILE,
} from "../src/data-dir.js";
import { configPath } from "../src/providers/registry.js";
import { SessionStore } from "../src/db/store.js";
import { isProtectedPath } from "../src/sandbox/index.js";

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "infu-datadir-"));
const oldDir = path.join(root, "old-infu");
const newDir = path.join(root, "new-infu");

// 隔离：不污染真实 ~/.infu 与 redirect 文件 —— 先记录现场，测试后恢复
const savedRedirect = fs.existsSync(REDIRECT_FILE) ? fs.readFileSync(REDIRECT_FILE, "utf-8") : null;

function withDataDir(dir: string, fn: () => void) {
  setDataDirForTest(dir);
  try {
    fn();
  } finally {
    invalidateDataDir();
  }
}

console.log("▶ 数据目录解析（默认 / redirect / 损坏回退）");
{
  // 无注入、无指针 → 默认
  if (fs.existsSync(REDIRECT_FILE)) fs.rmSync(REDIRECT_FILE, { force: true });
  invalidateDataDir();
  check("默认目录 = ~/.infu", resolveDataDir() === defaultDataDir());
  // redirect 指针优先（不设 test 注入，直接验证指针解析路径）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "infu-datadir-rd-"));
  const rd = path.join(tmp, "rd");
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(REDIRECT_FILE, JSON.stringify({ dir: rd }), "utf-8");
  try {
    invalidateDataDir();
    check("redirect 指针优先解析", resolveDataDir() === rd);
    fs.writeFileSync(REDIRECT_FILE, "{broken json", "utf-8");
    invalidateDataDir();
    check("损坏指针回退默认", resolveDataDir() === defaultDataDir());
  } finally {
    invalidateDataDir();
  }
}

console.log("▶ validateTarget 拒绝分支");
{
  withDataDir(oldDir, () => {
    const cur = resolveDataDir();
    check("相对路径拒绝", validateTarget("relative", cur) !== null);
    check("等于当前目录拒绝", validateTarget(cur, cur) !== null);
    check("主目录本身拒绝", validateTarget(os.homedir(), cur) !== null);
    check("盘根拒绝", validateTarget("C:\\", cur) !== null);
    check("当前目录内部嵌套拒绝", validateTarget(path.join(cur, "sub"), cur) !== null);
    const f = path.join(root, "a-file");
    fs.writeFileSync(f, "x", "utf-8");
    check("目标是文件拒绝", validateTarget(f, cur) !== null);
    const nonEmpty = path.join(root, "nonempty");
    fs.mkdirSync(nonEmpty, { recursive: true });
    fs.writeFileSync(path.join(nonEmpty, "x.txt"), "x", "utf-8");
    check("目标非空拒绝", validateTarget(nonEmpty, cur) !== null);
    check("空目录通过", validateTarget(newDir, cur) === null);
  });
}

console.log("▶ migrateDataDir 迁移 + 缓存失效 + 消费模块跟随");
{
  withDataDir(oldDir, () => {
    // 造数据：config.json / infu.db / projects.json / schedules.json / memory / skills / agents
    fs.mkdirSync(path.join(oldDir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(oldDir, "skills"), { recursive: true });
    fs.mkdirSync(path.join(oldDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(oldDir, "memory", "conventions.md"), "约定1", "utf-8");
    fs.writeFileSync(path.join(oldDir, "skills", "SKILL.md"), "skill", "utf-8");
    fs.writeFileSync(path.join(oldDir, "agents", "helper.md"), "---\ndescription: 帮手\n---\n正文", "utf-8");
    fs.writeFileSync(configPath(), JSON.stringify({ version: 1, defaultModelId: "m1" }), "utf-8");
    const db = new SessionStore(path.join(oldDir, "infu.db"));
    db.close();

    // 校验当前目录下各模块解析一致
    check("configPath 位于数据目录", path.dirname(configPath()) === oldDir);
    check("数据目录被写保护（沙箱）", isProtectedPath(path.join(oldDir, "config.json")));

    const res = migrateDataDir(newDir);
    check("迁移成功", res.ok, res.message);
    check("from/to 正确", res.from === oldDir && res.to === newDir);

    // 缓存失效 → 同进程解析新目录
    check("resolveDataDir 切到新目录", resolveDataDir() === newDir);
    check("configPath 跟随新目录", path.dirname(configPath()) === newDir);
    check("数据已复制（config.json）", fs.existsSync(path.join(newDir, "config.json")));
    check("数据已复制（infu.db）", fs.existsSync(path.join(newDir, "infu.db")));
    check("数据已复制（memory）", fs.readFileSync(path.join(newDir, "memory", "conventions.md"), "utf-8") === "约定1");
    check("数据已复制（skills）", fs.existsSync(path.join(newDir, "skills", "SKILL.md")));
    check("数据已复制（agents）", fs.existsSync(path.join(newDir, "agents", "helper.md")));
    check("旧目录保留为备份", fs.existsSync(path.join(oldDir, "config.json")));
    check("新目录受写保护（沙箱）", isProtectedPath(path.join(newDir, "config.json")));
    check("旧目录不再受保护（已非数据目录）", !isProtectedPath(path.join(oldDir, "config.json")));

    // redirect 指针已写入
    const rd = JSON.parse(fs.readFileSync(REDIRECT_FILE, "utf-8"));
    check("redirect 指针写入正确", rd.dir === newDir);

    // 再次迁移：目标非空拒绝
    const another = path.join(root, "another");
    fs.mkdirSync(another, { recursive: true });
    fs.writeFileSync(path.join(another, "keep.txt"), "x", "utf-8");
    const res2 = migrateDataDir(another);
    check("非空目标二次迁移拒绝", !res2.ok, res2.message);
    check("拒绝后仍解析当前目录", resolveDataDir() === newDir);
    // 空目标二次迁移成功
    const res3 = migrateDataDir(path.join(root, "third"));
    check("空目标二次迁移成功", res3.ok, res3.message);
    check("二次迁移后 resolve 跟随", resolveDataDir() === path.join(root, "third"));
    check("二次迁移后 config 跟随", path.dirname(configPath()) === path.join(root, "third"));
  });
}

// v4.0 审计修复（M11）：迁回/互迁到「已是数据目录」的目标 = 目标先整体备份再全新复制
// （原实现逐项 force 覆盖 = 破坏性合并：目标独有文件残留 + 同名文件被静默覆盖）
console.log("\n▶ 迁回备份（目标已含 config.json）");
{
  const src = path.join(root, "mig-src");
  const dst = path.join(root, "mig-dst");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dst, { recursive: true });
  // 源：数据目录（config.json + 独有文件）
  fs.writeFileSync(path.join(src, "config.json"), JSON.stringify({ version: 1, defaultModelId: "m2" }), "utf-8");
  fs.writeFileSync(path.join(src, "src-only.txt"), "from-src", "utf-8");
  // 目标：旧数据目录（config.json + 目标独有文件）
  fs.writeFileSync(path.join(dst, "config.json"), "{}", "utf-8");
  fs.writeFileSync(path.join(dst, "dst-only.txt"), "from-dst", "utf-8");
  withDataDir(src, () => {
    const res = migrateDataDir(dst);
    check("迁回迁移成功", res.ok, res.message);
    check("目标 config.json 被源覆盖（新数据）", fs.readFileSync(path.join(dst, "config.json"), "utf-8").includes("m2"));
    check("目标独有文件不再残留混合（全新复制）", !fs.existsSync(path.join(dst, "dst-only.txt")));
    check("目标旧数据整体备份保留", fs.readdirSync(path.join(root)).some((n) => n.startsWith("mig-dst.bak-") && fs.existsSync(path.join(root, n, "dst-only.txt"))), "应有 mig-dst.bak-* 含 dst-only.txt");
    check("源数据完整复制", fs.existsSync(path.join(dst, "src-only.txt")));
    check("迁移消息提及备份", res.message.includes("备份"));
  });
}

// ── 清理 ──
try {
  if (savedRedirect === null) fs.rmSync(REDIRECT_FILE, { force: true });
  else fs.writeFileSync(REDIRECT_FILE, savedRedirect, "utf-8");
} catch { /* 忽略 */ }
invalidateDataDir();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n数据目录迁移测试: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
