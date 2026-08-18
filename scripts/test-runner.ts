/**
 * InFu 全量测试运行器（v3.8）
 *
 * 替代根 package.json 里的一长串 && 链：逐个运行 packages/agent/tests/*.test.ts，
 * 提供：
 *  - 每套件全局超时（默认 300s，超时 kill 整棵树并标记，杜绝套件挂起让 npm test 无限等待）
 *  - 套件数下限断言（最少运行 MIN_SUITES 个套件，防未来误删测试文件导致"假全绿"）
 *  - 全部套件跑完再汇总（不再遇到失败即停，一次看到全部结果）
 *  - 失败套件输出完整尾部便于定位
 *
 * 用法：
 *   npx tsx scripts/test-runner.ts                 # 全量
 *   npx tsx scripts/test-runner.ts memory net      # 只跑指定套件（文件名或路径片段）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ── 套件清单：保持与历史 npm test 链一致的前后顺序（工具→沙箱→会话→重试→压缩→配置→审批→插件→子代理→记忆→…）──
const SUITES: string[] = [
  "tools.test.ts",
  "templates.test.ts",
  "win-sandbox.test.ts",
  "win-sandbox-net.test.ts",
  "session-store.test.ts",
  "retry.test.ts",
  "rebuild.test.ts",
  "fallback.test.ts",
  "compress.test.ts",
  "steps.test.ts",
  "config-migration.test.ts",
  "thinking.test.ts",
  "providers-api.test.ts",
  "mcp.test.ts",
  "approval-policy.test.ts",
  "approval-cache.test.ts",
  "sandbox-config.test.ts",
  "settings-api.test.ts",
  "terminal.test.ts",
  "plugin.test.ts",
  "subagent.test.ts",
  "memory.test.ts",
  "projects.test.ts",
  "git-tools.test.ts",
  "web-tools.test.ts",
  "task-tools.test.ts",
  "fs-tools.test.ts",
  "loop-opt.test.ts",
  "tools-opt.test.ts",
  "builtin-skills.test.ts",
  "browser.test.ts",
  "e2e-prod.test.ts",
  "subagent-control.test.ts",
  "jobs.test.ts",
  "v212.test.ts",
  "task-notify.test.ts",
  "bugfix.test.ts",
  "cleanup.test.ts",
  "data-dir.test.ts",
  "refine.test.ts",
  "vision.test.ts",
  "net.test.ts",
  "server-api.test.ts",
  "schedule.test.ts",
];

const SUITE_TIMEOUT_MS = 300_000;
const MIN_SUITES = 40;

const testsDir = path.resolve("packages", "agent", "tests");
const onlyFilter = process.argv.slice(2);

function suiteCandidates(): string[] {
  if (onlyFilter.length === 0) return SUITES;
  return SUITES.filter((s) => onlyFilter.some((f) => s.includes(f) || f.includes(s)));
}

interface RunResult {
  file: string;
  code: number | null;
  timedout: boolean;
  ms: number;
  output: string;
  asserts: { passed: number; failed: number } | null;
}

function parseAssertCount(output: string): { passed: number; failed: number } | null {
  // 各套件结果行格式不统一：中文「结果：N 通过 / M 失败」/「X 自测完成：N 通过，M 失败」/
  // 「X 控制：N 通过 / M 失败」/ 英文「N passed, M failed」——统一取最后一段「通过/失败」计数
  const m = /(\d+)\s*通过\s*[\/，,]\s*(\d+)\s*失败/.exec(output) ?? /(\d+)\s+passed\s*,\s*(\d+)\s+failed/.exec(output);
  if (!m) return null;
  return { passed: Number(m[1]), failed: Number(m[2]) };
}

async function runSuite(file: string): Promise<RunResult> {
  const t0 = Date.now();
  return await new Promise<RunResult>((resolve) => {
    const cmd = `npx tsx ${JSON.stringify(file)}`;
    const child = spawn(cmd, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Windows 下 npx 是 .cmd 脚本，必须经 cmd.exe（shell 模式）解释；pid 为 shell 进程，
      // 超时 kill 用 /T 杀整棵树
      shell: process.platform === "win32",
    });
    let out = "";
    const onData = (d: Buffer) => (out += d.toString("utf8"));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let settled = false;
    const finish = (code: number | null, timedout: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        file,
        code,
        timedout,
        ms: Date.now() - t0,
        output: out,
        asserts: parseAssertCount(out),
      });
    };
    const timer = setTimeout(() => {
      // Windows 杀进程树（npx → tsx → 被测套件），避免超时后残留子进程
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* kill 失败交给 close 兜底 */
      }
      finish(null, true);
    }, SUITE_TIMEOUT_MS);
    child.on("close", (code) => finish(code, false));
    child.on("error", () => finish(null, false));
  });
}

async function main() {
  const files = suiteCandidates();
  if (files.length === 0) {
    console.error(`未匹配到任何套件（过滤：${onlyFilter.join(", ")}）`);
    process.exit(2);
  }
  console.log(`▶ InFu 测试运行器：${files.length}/${SUITES.length} 套件（单套件超时 ${SUITE_TIMEOUT_MS / 1000}s）\n`);

  const results: RunResult[] = [];
  for (const f of files) {
    const file = path.join(testsDir, f);
    if (!fs.existsSync(file)) {
      console.log(`  ✗ ${f} —— 文件不存在，跳过`);
      results.push({ file: f, code: null, timedout: false, ms: 0, output: "", asserts: null });
      continue;
    }
    const r = await runSuite(file);
    const ok = r.code === 0 && !r.timedout && (r.asserts ? r.asserts.failed === 0 : true);
    const tag = r.timedout ? "⏱ 超时" : r.code === 0 ? "✓" : "✗";
    const detail = r.asserts ? `（断言 ${r.asserts.passed} 通过 / ${r.asserts.failed} 失败）` : "（无结果行）";
    console.log(`  ${tag} ${f}  ${((r.ms) / 1000).toFixed(1)}s ${detail}`);
    results.push(r);
    if (!ok) {
      const tail = r.output.split(/\r?\n/).slice(-12).join("\n").trim();
      if (tail) console.log(tail.split("\n").map((l) => `      ${l}`).join("\n"));
    }
  }

  const failed = results.filter((r) => r.code !== 0 || r.timedout || (r.asserts ? r.asserts.failed > 0 : false));
  const ran = results.filter((r) => r.code !== null || r.timedout);
  const totalAsserts = results.reduce((acc, r) => acc + (r.asserts?.passed ?? 0), 0);
  const failedAsserts = results.reduce((acc, r) => acc + (r.asserts?.failed ?? 0), 0);

  console.log("\n=== 汇总 ===");
  console.log(`  套件：${ran.length}/${files.length} 运行，失败 ${failed.length}`);
  if (totalAsserts > 0) console.log(`  断言：${totalAsserts} 通过 / ${failedAsserts} 失败`);
  if (onlyFilter.length === 0 && ran.length < MIN_SUITES) {
    console.error(`  ✗ 运行套件数 ${ran.length} < 下限 ${MIN_SUITES}（套件清单可能被误改）`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error("  失败套件：");
    for (const f of failed) {
      console.error(`    - ${f.file}${f.timedout ? "（超时）" : ""}${f.code !== 0 && !f.timedout ? `（退出码 ${f.code}）` : ""}`);
    }
    process.exit(1);
  }
  console.log("  全部通过 ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
