/**
 * v6.0（P1 S1）写后自动验证自测
 * 运行：npx tsx packages/agent/tests/auto-verify.test.ts
 *
 * 覆盖：
 *  - 测试框架自动检测（package.json / pyproject / go.mod / Cargo.toml / 无）
 *  - 写工具触发 / 非写工具不触发 / 失败结果不触发 / 错误文本不触发
 *  - 会话级去抖 60s（连续触发只跑一次）
 *  - general.autoVerify=false 显式关闭
 *  - 真实端到端：npm test 跑通 → 结果回填
 *  - Planner/Reviewer 阶段不触发
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeAutoVerify, detectTestCommand, resetAutoVerifyState } from "../src/agent/auto-verify.js";
import { saveConfig } from "../src/providers/registry.js";
import { setDataDirForTest } from "../src/data-dir.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

(async () => {
  console.log("══ v6.0 S1 写后自动验证 ══");
  const tmpData = mkdtempSync(join(tmpdir(), "infu-av-test-"));
  setDataDirForTest(tmpData);
  saveConfig({ models: [] });

  const base = mkdtempSync(join(tmpdir(), "infu-av-"));
  try {
    // ── 1. 框架检测 ──
    console.log("\n▶ 测试框架自动检测");
    const npmRoot = join(base, "npm"); mkdirSync(npmRoot);
    writeFileSync(join(npmRoot, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e \"console.log('AV_OK')\"" } }));
    check("package.json → npm test", detectTestCommand(npmRoot) === "npm test");
    const pyRoot = join(base, "py"); mkdirSync(pyRoot);
    writeFileSync(join(pyRoot, "requirements.txt"), "pytest\n");
    check("requirements.txt → pytest 链", detectTestCommand(pyRoot)?.startsWith("python -m pytest") === true);
    const goRoot = join(base, "go"); mkdirSync(goRoot);
    writeFileSync(join(goRoot, "go.mod"), "module x\n");
    check("go.mod → go test", detectTestCommand(goRoot) === "go test ./...");
    const rsRoot = join(base, "rs"); mkdirSync(rsRoot);
    writeFileSync(join(rsRoot, "Cargo.toml"), "[package]\n");
    check("Cargo.toml → cargo test", detectTestCommand(rsRoot) === "cargo test");
    const noneRoot = join(base, "none"); mkdirSync(noneRoot);
    writeFileSync(join(noneRoot, "readme.md"), "x");
    check("无框架 → null", detectTestCommand(noneRoot) === null);

    // ── 2. 触发条件 ──
    console.log("\n▶ 触发条件");
    resetAutoVerifyState();
    const in1 = { tool: "write_file", ok: true, out: "已写入 src/a.ts", root: npmRoot, sessionId: "s1" };
    const r1 = await maybeAutoVerify(in1);
    check("write_file 成功触发验证并回填", r1.out.includes("[自动验证]") && r1.out.includes("AV_OK"), r1.out);
    check("真实验证记录可用", r1.verification?.command === "npm test" && r1.verification.status === "passed" && r1.verification.output.includes("AV_OK"), JSON.stringify(r1.verification));
    check("原结果保留", r1.out.startsWith("已写入 src/a.ts"));
    const r2 = await maybeAutoVerify({ ...in1, tool: "read_file" });
    check("read_file 不触发", r2.out === "已写入 src/a.ts" && !r2.verification);
    const r3 = await maybeAutoVerify({ ...in1, tool: "write_file", ok: false });
    check("执行异常（ok=false）不触发", r3.out === "已写入 src/a.ts" && !r3.verification);
    const r4 = await maybeAutoVerify({ ...in1, out: "错误：路径越界" });
    check("错误文本结果不触发", r4.out === "错误：路径越界" && !r4.verification);
    const r5 = await maybeAutoVerify({ ...in1, phase: "planner" });
    check("Planner 阶段不触发", r5.out === "已写入 src/a.ts" && !r5.verification);
    const r6 = await maybeAutoVerify({ ...in1, phase: "reviewer" });
    check("Reviewer 阶段不触发", r6.out === "已写入 src/a.ts" && !r6.verification);
    const r7 = await maybeAutoVerify({ ...in1, tool: "git_commit" });
    check("git_commit 不触发（不在写工具集）", r7.out === "已写入 src/a.ts" && !r7.verification);

    // ── 3. 会话级去抖 ──
    console.log("\n▶ 会话级去抖（60s）");
    resetAutoVerifyState();
    const d1 = await maybeAutoVerify(in1);
    const d2 = await maybeAutoVerify({ ...in1, out: "已写入 src/b.ts" });
    check("连续触发只跑一次（第二次原样返回）", d2.out === "已写入 src/b.ts" && !d2.verification);
    check("不同会话独立去抖", (await maybeAutoVerify({ ...in1, sessionId: "s2", out: "已写入 src/c.ts" })).out.includes("[自动验证]"));
    check("第一次正常回填", d1.out.includes("AV_OK"));

    // ── 4. 显式关闭 ──
    console.log("\n▶ autoVerify=false 显式关闭");
    resetAutoVerifyState();
    saveConfig({ models: [], general: { autoVerify: false } });
    const r8 = await maybeAutoVerify({ ...in1, out: "已写入 src/d.ts" });
    check("关闭后不触发", r8.out === "已写入 src/d.ts" && !r8.verification);
    saveConfig({ models: [] });
  } finally {
    rmSync(base, { recursive: true, force: true });
    try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});