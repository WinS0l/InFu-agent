/**
 * v3.5 自动提交与记忆自动提炼测试：
 *  - parseEntries：提炼输出解析（围栏/噪声/白名单/非法输入）
 *  - tryAutoCommit：git 自动提交（成功/无改动/未启用/非仓库/无身份静默）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseEntries } from "../src/memory/refine.js";
import { tryAutoCommit } from "../src/agent/orchestrator.js";

const execFileAsync = promisify(execFile);

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infu-refine-"));

// ── 节 1. parseEntries 解析 ──
console.log("■ 提炼输出解析（围栏/噪声/白名单）：");
{
  const fenced = parseEntries('```json\n[{"topic":"lessons","entry":"内存泄漏要查引用计数"}]\n```');
  check("围栏包裹解析", fenced.length === 1 && fenced[0].topic === "lessons" && fenced[0].entry.includes("内存泄漏"), JSON.stringify(fenced));

  const plain = parseEntries('[{"topic":"conventions","entry":"使用 pnpm"}]');
  check("纯 JSON 解析", plain.length === 1 && plain[0].topic === "conventions");

  const noisy = parseEntries('好的，我总结如下：[{"topic":"preferences","entry":"优先中文回复"}] 以上。');
  check("前后噪声容忍", noisy.length === 1 && noisy[0].topic === "preferences");

  const badTopic = parseEntries('[{"topic":"secrets","entry":"x"},{"topic":"conventions","entry":"y"}]');
  check("非法 topic 过滤", badTopic.length === 1 && badTopic[0].topic === "conventions");

  const empty = parseEntries("[]");
  check("空数组", empty.length === 0);

  const invalid = parseEntries("这不是 JSON");
  check("非法输入空结果", invalid.length === 0);

  const emptyEntry = parseEntries('[{"topic":"conventions","entry":"  "}]');
  check("空 entry 过滤", emptyEntry.length === 0);
}

// ── 节 2. tryAutoCommit 自动提交 ──
console.log("■ 自动 git 提交：");
{
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "tester"], { cwd: repo, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "t@t.test"], { cwd: repo, windowsHide: true });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo, windowsHide: true });

  fs.writeFileSync(path.join(repo, "a.txt"), "hello");
  const note = await tryAutoCommit(repo, "测试任务", true);
  check("有改动提交成功返回提示", note.includes("已自动提交") && note.includes("未推送"), note);
  const log = await execFileAsync("git", ["log", "--oneline", "-2"], { cwd: repo, windowsHide: true });
  check("commit 已创建且消息带 InFu 前缀", log.stdout.includes("InFu: 测试任务"), log.stdout);

  const note2 = await tryAutoCommit(repo, "再次提交", true);
  check("无改动不提交", note2 === "");

  const note3 = await tryAutoCommit(repo, "测试任务", false);
  check("未启用不提交", note3 === "");

  const notRepo = path.join(dir, "notrepo");
  fs.mkdirSync(notRepo);
  fs.writeFileSync(path.join(notRepo, "a.txt"), "x");
  const note4 = await tryAutoCommit(notRepo, "任务", true);
  check("非 git 仓库静默跳过", note4 === "");

  const noUser = path.join(dir, "nouser");
  fs.mkdirSync(noUser);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: noUser, windowsHide: true });
  fs.writeFileSync(path.join(noUser, "a.txt"), "x");
  const note5 = await tryAutoCommit(noUser, "任务", true);
  check("无 git 身份静默跳过", note5 === "");
}

console.log(`\n=== 自动提交与提炼测试完成：${passed} 通过，${failed} 失败 ===`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
