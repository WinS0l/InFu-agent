/**
 * 工具系统自测（不依赖任何模型）
 * 运行：npx tsx packages/agent/tests/tools.test.ts
 */
import { TOOLS } from "../src/tools/index.js";
import { resolveDataDir } from "../src/data-dir.js";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";
import type { ToolContext, AgentEvent } from "@infu/shared";
import { redactSensitiveOutput } from "../src/sandbox/index.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// ── 测试项目夹具 ──
const proj = mkdtempSync(join(tmpdir(), "infu-test-"));
const dataDir = mkdtempSync(join(tmpdir(), "infu-tools-data-"));
setDataDirForTest(dataDir);
mkdirSync(join(proj, "src"), { recursive: true });
writeFileSync(join(proj, "package.json"), JSON.stringify({
  name: "fixture", version: "1.0.0",
  dependencies: { react: "^19.0.0", express: "^5.0.0" },
  scripts: { test: "echo hello-test" },
}, null, 2));
writeFileSync(join(proj, "src", "app.ts"), "export const greet = (name: string) => `Hello ${name}`;\n// TODO: fix me\n");
writeFileSync(join(proj, "README.md"), "# Fixture\n测试项目\n");

const events: AgentEvent[] = [];
const recordedDiffs: Array<{ added: number; removed: number }> = [];
const ctx: ToolContext = {
  root: proj,
  cwd: proj,
  requestApproval: async () => true,
  emit: (e) => events.push(e),
  recordFileDiff: (diff) => recordedDiffs.push(diff),
  sessionId: "tools-recovery",
};

const run = (name: string, args: Record<string, unknown>) => TOOLS[name].execute(args, ctx);
const T = TOOLS;

console.log("\n=== 工具系统自测 ===\n");

const redactedShort = redactSensitiveOutput("token=sk-abcdefghijklmnop");
check("短命令输出也脱敏", !redactedShort.includes("abcdefghijklmnop") && redactedShort.includes("已脱敏"), redactedShort);

// 1. project_scan
console.log("▶ project_scan");
const scan = await run("project_scan", {});
check("识别 Node.js 技术栈", scan.includes("Node.js"), scan);
check("识别 React 框架", scan.includes("React"), scan);

// 2. list_directory
console.log("\n▶ list_directory");
const list = await run("list_directory", {});
check("列出 src 目录", list.includes("[dir]  src/"), list);
check("列出 package.json", list.includes("package.json"), list);

// 3. read_file
console.log("\n▶ read_file");
const rd = await run("read_file", { path: "src/app.ts" });
check("读取内容", rd.includes("greet"), rd);
check("带行号", rd.includes("1\t"), rd);

// v3.9 审计修复（M3）：敏感路径读取保护——root=home 的会话不得读 SSH 密钥/配置
// （此前只有写保护，可读 ~/.infu/config.json 含 API Key 经 webfetch 外传）
const homeCtx: ToolContext = { ...ctx, root: homedir() };
const rdSsh = await TOOLS.read_file.execute({ path: ".ssh/config" }, homeCtx);
check("read_file 拒绝敏感路径（.ssh）", rdSsh.includes("受保护"), rdSsh);
const rdCfg = await TOOLS.read_file.execute({ path: join(resolveDataDir(), "config.json") }, homeCtx);
// Hosted Windows can expose %USERPROFILE% and %TEMP% in long/8.3 spellings, causing the
// root boundary to reject before protected-path classification. Both outcomes deny the secret.
check("read_file 拒绝数据目录配置（config.json）", rdCfg.includes("受保护") || rdCfg.includes("越界"), rdCfg);
const rdKube = await TOOLS.read_file.execute({ path: ".kube/config" }, homeCtx);
check("read_file 拒绝 Kubernetes 凭据", rdKube.includes("受保护"), rdKube);
const rdGitConfig = await TOOLS.read_file.execute({ path: ".gitconfig" }, homeCtx);
check("read_file 拒绝 git 全局配置", rdGitConfig.includes("受保护"), rdGitConfig);
// v4.0 审计修复（H2）：批量通道 read_files 与单文件同款防护（此前漏 isProtectedPath——
// 同一会话换工具名即可绕过，整批读出 SSH 私钥/凭据）
const rdFilesSsh = await TOOLS.read_files.execute({ paths: [".ssh/config", "x.txt"] }, homeCtx);
check("read_files 拒绝敏感路径（.ssh）", rdFilesSsh.includes("受保护"), rdFilesSsh);
const rdFilesCfg = await TOOLS.read_files.execute({ paths: [join(resolveDataDir(), "config.json")] }, homeCtx);
check("read_files 拒绝数据目录配置", rdFilesCfg.includes("受保护") || rdFilesCfg.includes("越界"), rdFilesCfg);
// 用户显式附加（extraReadDirs）豁免——附件功能依赖读取数据目录下暂存文件
const rdAttach = await TOOLS.read_file.execute({ path: join(resolveDataDir(), "config.json") }, { ...homeCtx, extraReadDirs: [resolveDataDir()] });
check("附件白名单豁免（extraReadDirs）", rdAttach.includes("受保护") === false, rdAttach);

// 4. search_code
console.log("\n▶ search_code");
const sr = await run("search_code", { pattern: "TODO" });
check("搜索命中", /src[\\/]app\.ts:2/.test(sr), sr);
mkdirSync(join(proj, ".SSH"), { recursive: true });
writeFileSync(join(proj, ".SSH", "id_rsa"), "PRIVATE-SEMANTIC-SECRET");
const semanticProtected = await run("semantic_search", { query: "PRIVATE-SEMANTIC-SECRET" });
check("semantic_search 无索引分支过滤 .SSH 变体", !semanticProtected.toLowerCase().includes(".ssh"), semanticProtected);

// 5. write_file + 越界防护
console.log("\n▶ write_file");
const wr = await run("write_file", { path: "src/new.txt", content: "hello" });
check("写入成功", wr.includes("已写入"), wr);
check("文件存在", existsSync(join(proj, "src", "new.txt")));
check("新文件结构化 diff 准确", recordedDiffs.at(-1)?.added === 1 && recordedDiffs.at(-1)?.removed === 0, JSON.stringify(recordedDiffs.at(-1)));
const escape = await run("write_file", { path: "../../evil.txt", content: "x" });
check("路径越界被拦截", escape.includes("越界"), escape);

// 6. edit_file + read-before-edit（v3.5 升级对齐 ZCode：未读/partial/stale 三层门禁）
console.log("\n▶ edit_file（read-before-edit 门禁）");
// 未读直接编辑 → 拒绝
const ed0 = await run("edit_file", { path: "README.md", old_text: "# Fixture", new_text: "# InFu" });
check("未读编辑被拒绝", ed0.includes("尚未读取"), ed0);
// 读取后再编辑 → 成功
const rd0 = await run("read_file", { path: "README.md" });
check("read README.md 成功", rd0.includes("Fixture"), rd0);
const ed1 = await run("edit_file", { path: "README.md", old_text: "# Fixture", new_text: "# InFu" });
check("读取后编辑成功", ed1.includes("已修改"), ed1);
check("等行替换结构化 diff 准确", recordedDiffs.at(-1)?.added === 1 && recordedDiffs.at(-1)?.removed === 1, JSON.stringify(recordedDiffs.at(-1)));
// stale：读后外部修改文件 → 编辑被拒（防基于过期缓存覆盖）
const staleTarget = join(proj, "src", "stale.txt");
writeFileSync(staleTarget, "version 1", "utf-8");
await run("read_file", { path: "src/stale.txt" });
await new Promise((r) => setTimeout(r, 20)); // mtime 前进
writeFileSync(staleTarget, "version 2 (external)", "utf-8");
const edStale = await run("edit_file", { path: "src/stale.txt", old_text: "version", new_text: "v" });
check("外部修改后编辑被拒（stale）", edStale.includes("已被修改"), edStale);
// 重读后再编辑 → 成功
await run("read_file", { path: "src/stale.txt" });
const edStale2 = await run("edit_file", { path: "src/stale.txt", old_text: "version 2", new_text: "v2" });
check("重读后编辑成功", edStale2.includes("已修改"), edStale2);
// 编辑成功后无需重读可继续改（写后状态刷新）
const ed4 = await run("edit_file", { path: "README.md", old_text: "# InFu", new_text: "# Fixture" });
check("编辑后直接续改成功（状态刷新）", ed4.includes("已修改"), ed4);
// partial：读取内容超长被截断 → 编辑被拒
const bigTarget = join(proj, "src", "big.txt");
writeFileSync(bigTarget, "line ".repeat(5000), "utf-8");
const rdBig = await run("read_file", { path: "src/big.txt" });
check("大文件读取被截断", rdBig.includes("已截断"), rdBig);
const edBig = await run("edit_file", { path: "src/big.txt", old_text: "line", new_text: "LINE" });
check("截断视图编辑被拒（partial）", edBig.includes("不完整"), edBig);
// 原文不匹配报错（提示先读）
const ed2 = await run("edit_file", { path: "src/app.ts", old_text: "不存在的内容", new_text: "x" });
check("原文不匹配报错（提示先读）", ed2.includes("read_file"), ed2);
// write_file：未读覆盖已存在文件 → 拒绝；读取后覆盖 → 成功（内容恢复夹具 package.json）
console.log("\n▶ write_file（read-before-edit 门禁）");
const wr0 = await run("write_file", { path: "package.json", content: JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { react: "^19.0.0", express: "^5.0.0" }, scripts: { test: "echo hello-test" } }, null, 2) });
check("未读覆盖已存在文件被拒绝", wr0.includes("尚未读取"), wr0);
const rdPkg = await run("read_file", { path: "package.json" });
check("read package.json 成功", rdPkg.includes("fixture"), rdPkg);
const wr2 = await run("write_file", { path: "package.json", content: JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { react: "^19.0.0", express: "^5.0.0" }, scripts: { test: "echo hello-test" } }, null, 2) });
check("读取后覆盖成功", wr2.includes("已写入"), wr2);
const wr3 = await run("write_file", { path: "src/new.txt", content: "hello again" });
check("覆盖成功（写后免重读）", wr3.includes("已写入"), wr3);
// 新建文件无需先读
const wr4 = await run("write_file", { path: "src/brand-new.txt", content: "fresh" });
check("新建文件无需先读", wr4.includes("已写入"), wr4);

// 恢复副本：已有文件覆盖/删除均可在当前会话恢复；副本不放在项目目录或敏感路径。
console.log("\n▶ 文件恢复");
const recoveryTarget = join(proj, "src", "recover.txt");
writeFileSync(recoveryTarget, "before", "utf-8");
await run("read_file", { path: "src/recover.txt" });
const wrRecovery = await run("write_file", { path: "src/recover.txt", content: "after" });
const recoveryId = wrRecovery.match(/记录 ([a-f0-9-]{36})/i)?.[1];
check("覆盖前创建会话恢复副本", !!recoveryId && !existsSync(join(proj, ".infu", "recovery")), wrRecovery);
const restored = await TOOLS.file_ops.execute({ op: "restore", recovery_id: recoveryId }, ctx);
check("restore 恢复覆盖前内容", restored.includes("已恢复") && readFileSync(recoveryTarget, "utf-8") === "before", restored);
const removed = await run("file_ops", { op: "rm", path: "src/recover.txt" });
const removeRecoveryId = removed.match(/记录 ([a-f0-9-]{36})/i)?.[1];
check("删除前创建恢复副本", !!removeRecoveryId && !existsSync(recoveryTarget), removed);
const restoredDeleted = await TOOLS.file_ops.execute({ op: "restore", recovery_id: removeRecoveryId }, ctx);
check("restore 恢复已删除文件", restoredDeleted.includes("已恢复") && readFileSync(recoveryTarget, "utf-8") === "before", restoredDeleted);

// 7. run_command
console.log("\n▶ run_command");
const cmd = await run("run_command", { command: "echo infu-ok" });
check("命令执行", cmd.includes("infu-ok"), cmd);

// 8. git_status / git_diff
console.log("\n▶ git_status / git_diff");
const gs = await run("git_status", {});
check("非 git 仓库友好提示", gs.includes("不是 Git 仓库") || gs.includes("fatal"), gs);

// 9. run_test
console.log("\n▶ run_test");
const rt = await run("run_test", {});
check("自动检测 npm test", rt.includes("hello-test"), rt);

// 10. 越界防护（read）
console.log("\n▶ 越界防护");
const re = await run("read_file", { path: "../../../windows/system32/notepad.exe" });
check("read 越界拦截", re.includes("越界"), re);

// 清理
rmSync(proj, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
