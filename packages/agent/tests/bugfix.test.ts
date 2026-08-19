/**
 * v2.13 bug 收尾回归自测（探索排查确认的修复项）
 * 运行：npx tsx packages/agent/tests/bugfix.test.ts
 *
 * 覆盖：
 *  - 白名单组合符绕过拦截（git status && rm -rf 退回审批）
 *  - 白名单收窄（git branch 创建/删除、git config 写入不再默认放行）
 *  - isPathInside 路径边界（同前缀兄弟目录逃逸拦截）
 *  - updateStatus stopped 终态保护（用户停止不被 done/error 覆盖）
 */

import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/db/store.js";
import { DEFAULT_COMMAND_ALLOWLIST, hasShellCombinators, isCommandAllowed } from "../src/approval/policy.js";
import { isPathInside } from "../src/tools/util.js";
import { isPrivateTarget } from "../src/tools/web.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

(async () => {
  console.log("══ v2.13 bug 收尾回归 ══");

  // ── 1. 白名单组合符绕过 ──
  console.log("\n▶ 组合符拦截（hasShellCombinators）");
  check("纯命令无组合符", hasShellCombinators("git status --short") === false);
  check("&& 链式拦截", hasShellCombinators("git status && rm -rf node_modules") === true);
  check("; 拦截", hasShellCombinators("ls; whoami") === true);
  check("重定向拦截", hasShellCombinators("echo evil > ~/.ssh/config") === true);
  check("管道拦截", hasShellCombinators("ls | grep x") === true);
  check("反引号拦截", hasShellCombinators("echo `whoami`") === true);
  check("$() 拦截", hasShellCombinators("echo $(whoami)") === true);

  // ── 2. 白名单收窄（写操作不再默认放行）──
  console.log("\n▶ 默认白名单收窄");
  check("git branch -a 只读列表放行", isCommandAllowed("git branch -a", DEFAULT_COMMAND_ALLOWLIST) === true);
  check("git branch 创建分支不放行", isCommandAllowed("git branch feature-x", DEFAULT_COMMAND_ALLOWLIST) === false);
  check("git branch -D 删除不放行", isCommandAllowed("git branch -D main", DEFAULT_COMMAND_ALLOWLIST) === false);
  check("git config --get 只读放行", isCommandAllowed("git config --get user.name", DEFAULT_COMMAND_ALLOWLIST) === true);
  check("git config --global 写入不放行", isCommandAllowed("git config --global user.email x@y.z", DEFAULT_COMMAND_ALLOWLIST) === false);
  check("git status 仍放行", isCommandAllowed("git status --short --branch", DEFAULT_COMMAND_ALLOWLIST) === true);
  check("npm run 不放行（执行任意 package.json 脚本，v3.0 审计 S4 收紧）", isCommandAllowed("npm run build", DEFAULT_COMMAND_ALLOWLIST) === false);
  check("npm run 无参数列脚本仍放行（只读）", isCommandAllowed("npm run", DEFAULT_COMMAND_ALLOWLIST) === true);
  check("npm ls 放行", isCommandAllowed("npm ls --depth=0", DEFAULT_COMMAND_ALLOWLIST) === true);

  // ── 3. 路径边界（isPathInside）──
  console.log("\n▶ 路径边界（startsWith 前缀漏洞修复）");
  const pathBase = mkdtempSync(join(tmpdir(), "infu-path-"));
  const pathRoot = join(pathBase, "work");
  const sibling = join(pathBase, "work2");
  mkdirSync(pathRoot);
  mkdirSync(sibling);
  check("根内文件放行", isPathInside(pathRoot, join(pathRoot, "a", "b.ts")) === true);
  check("根自身放行", isPathInside(pathRoot, pathRoot) === true);
  check("同前缀兄弟目录拦截", isPathInside(pathRoot, join(sibling, "evil.ts")) === false);
  check("根外拦截", isPathInside(pathRoot, join(pathBase, "other", "x.ts")) === false);
  check("win32 大小写变体拦截", isPathInside(pathRoot, join(pathBase, "WORK2", "x.ts")) === false);
  check("父目录相对路径 resolve 后拦截", isPathInside(pathRoot, join(pathRoot, "..", "work2", "x.ts")) === false);
  rmSync(pathBase, { recursive: true, force: true });

  // ── 3.2. 符号链接/目录联接逃逸（v6.0 S6：junction 越界回归 + fail-closed）──
  console.log("\n▶ junction 逃逸拦截（真实目录联接）");
  {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = mkdtempSync(join(tmpdir(), "infu-junc-"));
    const proj = join(base, "proj");
    const outside = join(base, "outside");
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(outside, "subdir"), { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
    writeFileSync(join(outside, "subdir", "inner.txt"), "inner");
    const junc = join(proj, "j");
    if (process.platform === "win32") {
      execFileSync("cmd.exe", ["/c", "mklink", "/J", junc, outside], { stdio: "ignore" });
    } else {
      // POSIX：真实符号链接同样验证（逃逸路径等价）
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, junc, "dir");
    }
    try {
      check("junction 直达外部已有文件拦截", isPathInside(proj, join(junc, "secret.txt")) === false);
      check("junction 子目录已有文件拦截", isPathInside(proj, join(junc, "subdir", "inner.txt")) === false);
      check("junction 内写新文件拦截", isPathInside(proj, join(junc, "new.txt")) === false);
      check("junction 内深层新目录拦截", isPathInside(proj, join(junc, "deep", "new", "deep.txt")) === false);
      check("junction 自身拦截（目标在根外）", isPathInside(proj, junc) === false);
      check("根内普通文件放行", isPathInside(proj, join(proj, "real.txt")) === true);
      check("根内不存在的普通文件放行（新建合法）", isPathInside(proj, join(proj, "sub", "future.txt")) === true);
      // fail-closed（v6.0）：整条祖先链不可解析（盘符不存在）→ 无法 realpath 验证 → 拒绝而非词法放行
      {
        const { existsSync } = await import("node:fs");
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
        const free = letters.find((l) => !existsSync(`${l}:\\`));
        if (free) {
          const ghostRoot = `${free}:\\nope\\proj`;
          check("祖先链不可解析 fail-closed 拦截", isPathInside(ghostRoot, `${ghostRoot}\\x.txt`) === false);
          check("祖先链不可解析同根外也拦截", isPathInside(ghostRoot, `${free}:\\nope\\other\\x`) === false);
        } else {
          console.log("  ⏭ 无空闲盘符，跳过 fail-closed 用例");
        }
      }
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ── 3.5. SSRF 防护（webfetch 内网拦截）──
  console.log("\n▶ SSRF 防护");
  // v6.0 S6：env 后门已移除；测试默认即拦截路径（setPrivateUrlAllowedForTests 未开启时）
  check("回环地址拦截", (await isPrivateTarget("http://127.0.0.1:8080/x")).ok === false);
  check("本地主机名拦截", (await isPrivateTarget("http://localhost:3000/")).ok === false);
  check("私网 192.168 拦截", (await isPrivateTarget("http://192.168.1.1/")).ok === false);
  check("私网 10.x 拦截", (await isPrivateTarget("http://10.0.0.5/")).ok === false);
  check("链路本地拦截（云元数据）", (await isPrivateTarget("http://169.254.169.254/latest/meta-data")).ok === false);
  check("IPv6 回环拦截", (await isPrivateTarget("http://[::1]:8080/")).ok === false);
  // v3.6 回归：IPv6 变体（十六进制 IPv4-mapped / IPv4-compatible / 完整形式回环）——
  // 原实现只认 ::ffff: 点分形式，以下全漏判放行（web.ts isPrivateIp 与桌面 isLoopbackTarget 同源修复）
  check("IPv6 hex IPv4-mapped 回环拦截（::ffff:7f00:1）", (await isPrivateTarget("http://[::ffff:7f00:1]:4317/")).ok === false);
  check("IPv6 简写 IPv4-compatible 回环拦截（::7f00:1）", (await isPrivateTarget("http://[::7f00:1]:4317/")).ok === false);
  check("IPv6 完整形式回环拦截（0:0:0:0:0:0:0:1）", (await isPrivateTarget("http://[0:0:0:0:0:0:0:1]:4317/")).ok === false);
  check("IPv6 点分 IPv4-mapped 拦截（::ffff:127.0.0.1）", (await isPrivateTarget("http://[::ffff:127.0.0.1]:8080/")).ok === false);
  check("IPv6 公网 hex mapped 放行（::ffff:8.8.8.8）", (await isPrivateTarget("http://[::ffff:8.8.8.8]/")).ok === true);
  check("公网 IP 放行", (await isPrivateTarget("http://8.8.8.8/")).ok === true);
  check("非 http 协议拒绝", (await isPrivateTarget("ftp://example.com/x")).ok === false);

  // ── 4. stopped 终态保护 ──
  console.log("\n▶ updateStatus stopped 保护");
  const dir = mkdtempSync(join(tmpdir(), "infu-bugfix-"));
  const store = new SessionStore(join(dir, "t.db"));
  const sid = store.createSession({ title: "t", root: "E:\\x" });
  store.updateStatus(sid, "stopped");
  store.updateStatus(sid, "done");
  check("stopped 不被 done 覆盖", store.getSession(sid)?.status === "stopped");
  store.updateStatus(sid, "error");
  check("stopped 不被 error 覆盖", store.getSession(sid)?.status === "stopped");
  store.updateStatus(sid, "running");
  check("stopped 可被新任务 running 覆盖（续跑）", store.getSession(sid)?.status === "running");
  store.updateStatus(sid, "done");
  check("running → done 正常", store.getSession(sid)?.status === "done");
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* 句柄释放中忽略 */ }

  console.log(`\nbug 收尾回归：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
