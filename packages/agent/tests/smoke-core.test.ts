/**
 * 核心模块冒烟套件（审计修复 H-2：semantic/persistent-shell 等关键模块此前零测试）。
 * 覆盖：
 *  - semantic：中文 bigram 分词 + BM25 相关度排序（纯函数，零副作用）
 *  - persistent-shell：真实 shell 会话创建/执行/root 变化重建/清理（win32 冒烟）
 *  - collectFiles：凭据目录大小写变体（.SSH）不入索引（H-1 保护回归）
 *  - dangerous：语言运行时载荷检测纯函数（#6 回归）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ""}`); }
}

console.log("\n=== 核心模块冒烟（smoke-core）===\n");

// ── 1. semantic（中文分词 + 相关度）──
console.log("▶ semantic（BM25）");
{
  const { tokenize, semanticSearch, semanticSearchFiles } = await import("../src/tools/semantic.js");
  const tokens = tokenize("权限审批测试");
  check("中文 bigram 分词", Array.isArray(tokens) && tokens.length > 0, JSON.stringify(tokens));
  check("英文单词保留", tokenize("hello world").includes("hello"));

  const dir = mkdtempSync(path.join(os.tmpdir(), "infu-smoke-sem-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "// 权限审批逻辑：approval policy 拒绝高危命令");
    fs.writeFileSync(path.join(dir, "b.ts"), "// 无关文件：colors palette 颜色主题配置");
    const hits = semanticSearchFiles("权限审批", dir, () => ["a.ts", "b.ts"].map((f) => path.join(dir, f)), 5);
    check("相关度排序（命中权限审批文件在前）", hits.length >= 1 && hits[0].file.endsWith("a.ts"), JSON.stringify(hits.map((h) => h.file)));
    check("结果带路径/得分字段", hits.length >= 1 && typeof hits[0].score === "number");
    const empty = semanticSearch("不存在的词xyzabc", [path.join(dir, "a.ts")], dir, 5);
    check("无命中返回空数组", Array.isArray(empty) && empty.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2. persistent-shell（win32 冒烟）──
console.log("▶ persistent-shell");
{
  if (process.platform === "win32") {
    const { getShellSession, execPersistent, closeShellSession, shellSessionCount } = await import("../src/tools/persistent-shell.js");
    closeShellSession();
    const dirA = mkdtempSync(path.join(os.tmpdir(), "infu-smoke-shell-a-"));
    const dirB = mkdtempSync(path.join(os.tmpdir(), "infu-smoke-shell-b-"));
    try {
      const s1 = getShellSession("smoke-s", dirA);
      check("会话创建", shellSessionCount() === 1);
      check("cwd 跟随 root", s1.cwd === dirA);
      const out1 = await execPersistent("smoke-s", dirA, "echo smoke-ok", 15000);
      check("命令执行回显", out1.includes("smoke-ok"), out1);
      // root 变化 → 自动重建（cwd 跟随）
      const s2 = getShellSession("smoke-s", dirB);
      check("root 变化重建会话", s2 !== s1 && s2.cwd === dirB && shellSessionCount() === 1);
      const out2 = await execPersistent("smoke-s", dirB, "cd && echo second", 15000);
      check("重建后仍可执行", out2.includes("second"), out2);
      // 关闭会话 → 计数归零；再调用自动重建（execPersistent 内部 getShellSession）
      closeShellSession("smoke-s");
      check("close 后会话计数归零", shellSessionCount() === 0);
      const out3 = await execPersistent("smoke-s", dirA, "echo after-close", 15000);
      check("关闭后调用自动重建并成功", out3.includes("after-close"), out3);
    } finally {
      closeShellSession();
      // cmd.exe 进程退出异步（cwd 句柄占用）——清理失败仅留 tmp 残留，不影响测试结论
      await new Promise((r) => setTimeout(r, 500));
      try { rmSync(dirA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 残留忽略 */ }
      try { rmSync(dirB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 残留忽略 */ }
    }
  } else {
    console.log("  （非 win32，跳过真实 PTY 冒烟）");
  }
}

// ── 3. collectFiles 保护回归（H-1：.SSH 大小写变体不入索引）──
console.log("▶ collectFiles 保护");
{
  const { collectFiles } = await import("../src/index/index.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "infu-smoke-collect-"));
  try {
    fs.mkdirSync(path.join(dir, ".SSH"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".SSH", "id_rsa"), "PRIVATE-KEY-MATERIAL");
    fs.writeFileSync(path.join(dir, "node_modules", "x.js"), "junk");
    fs.writeFileSync(path.join(dir, "normal.ts"), "ok");
    const files = collectFiles(dir);
    const names = files.map((f) => f.file).join(",");
    check("普通文件入索引", names.includes("normal.ts"), names);
    check(".SSH 凭据文件不入索引", !names.toLowerCase().includes("id_rsa"), names);
    check("node_modules 不入索引", !names.includes("node_modules/x.js"), names);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 4. dangerous 纯函数（#6 回归）──
console.log("▶ dangerous 运行时载荷");
{
  const { isDangerousCommand, DANGEROUS } = await import("../src/sandbox/dangerous.js");
  check("rm -rf 命中", isDangerousCommand("rm -rf dist") === true);
  check("node -e rmSync 命中", isDangerousCommand("node -e \"require('fs').rmSync('x',{recursive:true})\"") === true);
  check("python -c shutil.rmtree 命中", isDangerousCommand("python -c \"import shutil; shutil.rmtree('x')\"") === true);
  check("无害载荷不命中", isDangerousCommand("node -e \"console.log('hi')\"") === false);
  check("git status 不命中", isDangerousCommand("git status") === false);
  check("git config --list 不命中（白名单收窄后回审批，非高危判定）", isDangerousCommand("git config --list") === false);
  check("原正则导出兼容", DANGEROUS.test("rm -rf x") === true);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);