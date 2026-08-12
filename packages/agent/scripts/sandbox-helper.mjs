/**
 * 提权辅助进程（M6）——由计划任务 InFuSandboxNetHelper 以 SYSTEM 最高权限拉起
 *
 * 为什么是 SYSTEM：非提权调用者缺 SeImpersonatePrivilege（本机加固策略）；
 * 提权的普通用户令牌又缺 SeAssignPrimaryTokenPrivilege（同样被移除）——
 * 两个特权缺口让 CreateProcessWithTokenW / CreateProcessAsUserW 都无法
 * 以沙箱账号令牌创建进程（1314 / 0xC0000142）。SYSTEM 持有全部特权。
 * DPAPI 解密在 Rust 层自动模拟交互用户（explorer.exe 所在会话）。
 *
 * 协议：队列目录 %ProgramData%\InFu\sandbox-helper\<用户名>\ 下的 req-*.json：
 *  1. 原子改名 claimed-*.json 认领（并发安全）
 *  2. 提权授权工作区（盘根遍历 + Low 完整性，SYSTEM 可改受保护 ACL）
 *  3. 调用原生 runRestricted（登录+受限+低盒管线）
 *  4. 结果写 res-<uuid>.json，删除 claimed 文件
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync, writeFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(process.env.ProgramData ?? "C:\ProgramData", "InFu", "sandbox-helper");
const REQ_PREFIX = "req-";
const CLAIM_PREFIX = "claimed-";
const RES_PREFIX = "res-";

if (!existsSync(root)) process.exit(0); // 无待办（首次运行前目录未建）

for (const userDirName of readdirSync(root)) {
  const dir = join(root, userDirName);
  if (!existsSync(dir)) continue;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (!name.startsWith(REQ_PREFIX) || !name.endsWith(".json")) continue;
    const uuid = name.slice(REQ_PREFIX.length, -5);
    const claimed = join(dir, CLAIM_PREFIX + name.slice(REQ_PREFIX.length));
    try {
      renameSync(join(dir, name), claimed); // 原子认领：并发实例不会重复处理
    } catch {
      continue; // 已被其它实例认领或文件已消失
    }
    try {
      const req = JSON.parse(readFileSync(claimed, "utf-8"));
      for (const [k, v] of Object.entries(req.debugEnv ?? {})) process.env[k] = v;
      const m = require(req.modulePath ?? "@infu/sandbox-rs");
      // 提权授权：盘根遍历（受保护 ACL 仅 SYSTEM/提权可改）+ 工作区 Modify + Low 完整性
      let grantNote = "";
      try {
        m.netGrantDir(req.cwd);
      } catch (e) {
        grantNote = `\n⚠ 工作区授权失败（${e?.message ?? e}）`;
      }
      const r = await m.runRestricted(req.command, {
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        env: req.env ?? {},
        ...(req.sandboxUser ? { sandboxUser: req.sandboxUser } : {}),
      });
      if (grantNote && r) {
        r.stderr = (r.stderr || "") + grantNote;
      }
      writeFileSync(join(dir, RES_PREFIX + uuid + ".json"), JSON.stringify(r), "utf-8");
    } catch (e) {
      writeFileSync(
        join(dir, RES_PREFIX + uuid + ".json"),
        JSON.stringify({
          ok: false, code: -1, stdout: "", stderr: "", timedOut: false,
          level: "helper-error", net: "none",
          error: `提权辅助进程失败: ${e?.message ?? e}`,
        }),
        "utf-8"
      );
    } finally {
      try { rmSync(claimed, { force: true }); } catch { /* 清理失败不影响结果 */ }
    }
  }
}
