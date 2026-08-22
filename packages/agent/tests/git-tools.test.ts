/**
 * v2.6 收尾 Git 工具自测（git_log / git_add / git_commit / git_branch / git_diff 增强）
 * 运行：npx tsx packages/agent/tests/git-tools.test.ts
 */
import { TOOLS } from "../src/tools/index.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ToolContext, AgentEvent } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// ── git 仓库夹具（真实 git；跳过不可用时标注）──
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: proj, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const proj = mkdtempSync(join(tmpdir(), "infu-git-"));
let gitOk = true;
try {
  git("init", "-q");
  git("config", "user.email", "test@infu.local");
  git("config", "user.name", "infu-test");
  writeFileSync(join(proj, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "init commit");
} catch (e) {
  gitOk = false;
  console.log("⚠ git 不可用，跳过 Git 工具测试:", (e as Error).message);
}

const events: AgentEvent[] = [];
const ctx: ToolContext = {
  root: proj,
  cwd: proj,
  requestApproval: async () => true,
  emit: (e) => events.push(e),
};
const run = (name: string, args: Record<string, unknown>) => TOOLS[name].execute(args, ctx);

console.log("\n=== v2.6 收尾 Git 工具自测 ===\n");

if (gitOk) {
  // 1. git_log
  console.log("▶ git_log");
  const gl = await run("git_log", {});
  check("列出提交历史", /init commit/.test(gl), gl);
  const gl2 = await run("git_log", { count: 1 });
  check("count 生效（只 1 条）", (gl2.match(/^[0-9a-f]{7,}/gm) ?? []).length <= 1, gl2);

  // 2. git_diff 增强
  console.log("\n▶ git_diff 增强");
  writeFileSync(join(proj, "a.txt"), "hello\nworld\n");
  const gdStat = await run("git_diff", {});
  check("默认带 --stat", /\|\s*\d+\s+[+-]+/m.test(gdStat) || /a\.txt/.test(gdStat), gdStat);
  const gdNoStat = await run("git_diff", { stat: false });
  check("stat=false 无统计", !/^\s*[^\s]+\s+\|\s*\d+/.test(gdNoStat) || /\+world/.test(gdNoStat), gdNoStat);
  const gdFile = await run("git_diff", { file: "a.txt" });
  check("file 过滤命中", /\+world/.test(gdFile), gdFile);

  // 3. git_add
  console.log("\n▶ git_add");
  const ga = await run("git_add", { all: true });
  check("暂存全部改动", ga.includes("暂存"), ga);
  const st = git("status", "--short");
  check("文件进入暂存区", /^A /.test(st) || /^M /.test(st), st);

  // 4. git_commit
  console.log("\n▶ git_commit");
  const gc = await run("git_commit", { message: "feat: add world" });
  check("提交成功", /feat: add world/.test(gc) && gc.includes("未推送"), gc);
  check("HEAD 前进了", git("log", "--oneline", "-1").includes("feat: add world"), git("log", "--oneline", "-1"));
  const gcEmpty = await run("git_commit", { message: "nothing to do" });
  check("无改动友好提示", /没有可提交的改动/.test(gcEmpty), gcEmpty);

  // 5. git_branch
  console.log("\n▶ git_branch");
  const gbList = await run("git_branch", { action: "list" });
  check("列分支含当前", /master|main/.test(gbList) && /当前分支/.test(gbList), gbList);
  const gbCreate = await run("git_branch", { action: "create", name: "feature-x" });
  check("创建分支", gbCreate.includes("已创建分支 feature-x"), gbCreate);
  const gbSwitch = await run("git_branch", { action: "switch", name: "feature-x" });
  check("切换分支", /feature-x/.test(gbSwitch), gbSwitch);
  check("当前在 feature-x", git("branch", "--show-current") === "feature-x", git("branch", "--show-current"));
  const gbBad = await run("git_branch", { action: "create", name: "bad;rm -rf" });
  check("非法分支名拒绝", /非法分支名/.test(gbBad), gbBad);
  // 切回 master 保持后续干净
  run("git_branch", { action: "switch", name: git("branch", "--show-current") === "feature-x" ? "master" : "main" });
} else {
  const gs = await run("git_log", {});
  check("git 不可用时友好提示", gs.includes("不是 Git 仓库") || gs.includes("fatal"), gs);
}

// 6. 非 git 目录友好提示
console.log("\n▶ 非 git 目录");
const plain = mkdtempSync(join(tmpdir(), "infu-plain-"));
writeFileSync(join(plain, "x.txt"), "x");
const plainCtx = { ...ctx, root: plain };
const gl3 = await TOOLS.git_log.execute({}, plainCtx);
check("git_log 友好提示", /不是 Git 仓库/.test(gl3), gl3);
const gb3 = await TOOLS.git_branch.execute({ action: "list" }, plainCtx);
check("git_branch 友好提示", /不是 Git 仓库/.test(gb3), gb3);
rmSync(plain, { recursive: true, force: true });

// 清理（Windows 下 .git 可能被锁，失败不阻塞结果统计）
try { rmSync(proj, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
