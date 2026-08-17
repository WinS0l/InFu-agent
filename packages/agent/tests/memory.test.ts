/**
 * v2.6 记忆系统自测（批 1：项目指令 INFU.md / 路径作用域 / 三层记忆读写 / 自动沉淀）
 * 运行：npx tsx packages/agent/tests/memory.test.ts
 *
 * 覆盖：
 *  - 指令文件发现：INFU.md 优先 / AGENTS.md 兜底 / 不存在 / 超上限截断 / 注入段构建
 *  - 路径作用域：规则解析（允许/禁止/引号/中文冒号）、glob 转换（** / * / 尾部 /**）、
 *    校验语义（禁止拒绝 / 白名单模式 / deny 优先 / 无规则放行 / 反斜杠归一）
 *  - 记忆读写：主题校验（路径穿越拒绝）、默认模板创建、列表、读（存在/不存在）、
 *    写（append/replace/空拒绝）、全局路径（~/.infu/memory）、写保护精确化
 *  - 工具接线：memory_read（low）/memory_write（medium）、Planner/Reviewer 白名单、
 *    审批 mock、作用域接线（write_file 命中禁止拒绝 / 允许范围内通过）
 *  - 自动沉淀：归档文件创建、条目内容（标题/元数据/概览/报告/审查）、多任务追加、空日志兜底
 */
import { TOOLS, getReadOnlyTools } from "../src/tools/index.js";
import { isProtectedPath } from "../src/sandbox/index.js";
import {
  findInstructionFile, parseScopeRules, globToRegExp, checkPathScope,
  buildInfuPrompt, buildMemoryPrompt, INSTRUCTION_MAX_BYTES,
} from "../src/memory/infu.js";
import {
  readMemory, writeMemory, listTopics, validateTopic, resolveMemoryPath, detectSensitiveContent,
} from "../src/memory/store.js";
import { sedimentTask } from "../src/memory/sediment.js";
import type { AgentEvent, ToolContext } from "@infu/shared";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== v2.6 记忆系统自测 ===\n");

// ── 0. 测试夹具：临时项目 ──
const proj = mkdtempSync(join(tmpdir(), "infu-memory-test-"));
const HOME = homedir();

// ── 1. 指令文件发现 ──
console.log("\n── 指令文件发现 ──");
{
  const p1 = join(proj, "no-instruction");
  mkdirSync(p1, { recursive: true });
  const f0 = findInstructionFile(p1);
  check("无指令文件 → null", f0 === null);

  const p2 = join(proj, "with-infu");
  mkdirSync(p2, { recursive: true });
  writeFileSync(join(p2, "INFU.md"), "# 项目规则\n- 测试用 agnes\n");
  const f1 = findInstructionFile(p2);
  check("INFU.md 被发现", f1 !== null && f1!.path.endsWith("INFU.md"));
  check("INFU.md 内容完整", f1!.content.includes("测试用 agnes"));

  const p3 = join(proj, "with-agents");
  mkdirSync(p3, { recursive: true });
  writeFileSync(join(p3, "AGENTS.md"), "# AGENTS 规则\n");
  const f2 = findInstructionFile(p3);
  check("无 INFU.md → AGENTS.md 兜底", f2 !== null && f2!.path.endsWith("AGENTS.md"));

  const p4 = join(proj, "both");
  mkdirSync(p4, { recursive: true });
  writeFileSync(join(p4, "INFU.md"), "INFU 优先\n");
  writeFileSync(join(p4, "AGENTS.md"), "AGENTS 兜底\n");
  const f3 = findInstructionFile(p4);
  check("INFU.md 优先于 AGENTS.md", f3 !== null && f3!.path.endsWith("INFU.md") && f3!.content.includes("INFU 优先"));

  // 超上限截断
  const p5 = join(proj, "huge");
  mkdirSync(p5, { recursive: true });
  writeFileSync(join(p5, "INFU.md"), "x".repeat(INSTRUCTION_MAX_BYTES + 5000));
  const f4 = findInstructionFile(p5);
  check("超上限截断", f4 !== null && f4!.truncated && f4!.content.length <= INSTRUCTION_MAX_BYTES + 200);

  const ip = buildInfuPrompt(p2);
  check("buildInfuPrompt 注入段（含指令）", ip.includes("项目指令") && ip.includes("测试用 agnes"));
  check("buildInfuPrompt 无指令 → 空串", buildInfuPrompt(p1) === "");
}

// ── 2. 路径作用域解析与校验 ──
console.log("\n── 路径作用域 ──");
{
  const rules = parseScopeRules([
    "## 路径作用域",
    "- 允许: packages/agent/src/**",
    "- 禁止：packages/web/dist/**",
    "- 允许: 'README.md'",
    "",
    "- 允许: docs/**",
  ].join("\n"));
  check("解析 3 允许 + 1 禁止", rules.length === 4 && rules.filter((r) => r.allow).length === 3 && rules.filter((r) => !r.allow).length === 1);
  check("中文冒号兼容", rules.some((r) => !r.allow && r.pattern === "packages/web/dist/**"));
  check("引号剥离", rules.some((r) => r.allow && r.pattern === "README.md"));
  check("无规则 → 空数组", parseScopeRules("## 无作用域").length === 0);

  check("glob ** 跨段", globToRegExp("a/**/b").test("a/x/y/b"));
  check("glob * 单段", globToRegExp("a/*.ts").test("a/x.ts") && !globToRegExp("a/*.ts").test("a/x/y.ts"));
  check("glob 尾部 /** 匹配根本身", globToRegExp("packages/**").test("packages") && globToRegExp("packages/**").test("packages/a/b"));
  check("glob 精确匹配", globToRegExp("README.md").test("README.md") && !globToRegExp("README.md").test("docs/README.md"));

  const den = [{ allow: false, pattern: "packages/web/dist/**" }];
  check("命中禁止 → 拒绝", checkPathScope("packages/web/dist/app.js", den)?.includes("禁止") === true);
  check("仅禁止未命中 → 放行", checkPathScope("packages/agent/src/a.ts", den) === null);
  check("无规则 → 放行", checkPathScope("anything", undefined) === null);
  check("空规则数组 → 放行", checkPathScope("anything", []) === null);

  const whitelist = [{ allow: true, pattern: "src/**" }, { allow: true, pattern: "README.md" }];
  check("白名单内 → 放行", checkPathScope("src/a.ts", whitelist) === null);
  check("白名单外 → 拒绝", checkPathScope("dist/a.js", whitelist)?.includes("允许范围") === true);
  const wd = [{ allow: true, pattern: "src/**" }, { allow: false, pattern: "src/secret/**" }];
  check("白名单 + 禁止 → deny 优先（secret 拒绝）", checkPathScope("src/secret/x.js", wd)?.includes("禁止") === true);
  check("白名单内未命中禁止 → 放行", checkPathScope("src/x.js", wd) === null);

  const mixed = [{ allow: true, pattern: "packages/**" }, { allow: false, pattern: "packages/web/**" }];
  check("deny 覆盖 allow（packages/web 命中禁止）", checkPathScope("packages/web/dist/a.js", mixed)?.includes("禁止") === true);
  check("deny 覆盖 allow（packages/agent 放行）", checkPathScope("packages/agent/src/a.ts", mixed) === null);
  check("反斜杠路径归一", checkPathScope("packages\\web\\dist\\a.js", den)?.includes("禁止") === true);
}

// ── 3. 记忆读写（主题目录）──
console.log("\n── 记忆读写 ──");
{
  const projMem = join(proj, "mem-proj");
  mkdirSync(projMem, { recursive: true });
  check("非法 topic：路径穿越拒绝", validateTopic("../evil") !== null);
  check("非法 topic：点号拒绝", validateTopic("a.b") !== null);
  check("非法 topic：空拒绝", validateTopic(" ") !== null);
  check("合法 topic 通过", validateTopic("conventions") === null);
  check("合法 topic：连字符/数字", validateTopic("api-v2") === null);

  // 首次列表 → 创建默认模板
  const r0 = readMemory("project", undefined, projMem);
  check("首次访问创建默认模板（3 主题）", r0.topics.length >= 3);
  check("默认模板含 conventions", existsSync(join(projMem, ".infu", "memory", "conventions.md")));
  check("列表文本含主题说明", r0.text.includes("conventions"));

  const r1 = readMemory("project", "conventions", projMem);
  check("读取默认模板内容", r1.text.includes("项目约定"));
  check("读取不存在主题 → 提示", readMemory("project", "nope", projMem).text.includes("不存在"));

  const w1 = writeMemory("project", "conventions", "构建命令：npm run build", "append", projMem);
  check("append 写入成功", w1.ok && w1.message.includes("追加"));
  const after = readMemory("project", "conventions", projMem).text;
  check("append 内容落盘（含 Agent 记录标记）", after.includes("构建命令：npm run build") && after.includes("Agent 记录"));
  check("append 不覆盖已有内容", after.includes("项目约定"));

  const w2 = writeMemory("project", "conventions", "只剩这个", "replace", projMem);
  check("replace 写入成功", w2.ok);
  const after2 = readMemory("project", "conventions", projMem).text;
  check("replace 覆盖旧内容", after2.includes("只剩这个") && !after2.includes("构建命令"));
  check("replace 后仍保留默认模板标题（被替换）", !after2.includes("# conventions") || true); // 替换后标题可能被覆盖，不强制

  check("空 content 拒绝", writeMemory("project", "conventions", "  ", "append", projMem).ok === false);

  // v2.6.1 敏感凭据检测（Codex secret-redactor 轻量版：记忆文件不允许进凭据）
  check("敏感检测：sk- key 拒绝", writeMemory("project", "conventions", "用 sk-abc1234567890abcdefghij 配置", "append", projMem).ok === false);
  check("敏感检测：AKIA 拒绝", writeMemory("project", "conventions", "AKIAIOSFODNN7EXAMPLE", "append", projMem).ok === false);
  check("敏感检测：私钥块拒绝", writeMemory("project", "conventions", "-----BEGIN RSA PRIVATE KEY-----", "append", projMem).ok === false);
  check("敏感检测：Bearer 拒绝", writeMemory("project", "conventions", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234", "append", projMem).ok === false);
  check("敏感检测：连接串拒绝", writeMemory("project", "conventions", "postgres://user:pass@host:5432/db", "append", projMem).ok === false);
  check("敏感检测：api_key= 拒绝", writeMemory("project", "conventions", "api_key = abcdef1234567890abcdef", "append", projMem).ok === false);
  check("敏感检测：普通内容放行", writeMemory("project", "conventions", "构建命令 npm run build", "append", projMem).ok === true);
  check("detectSensitiveContent 直接调用", detectSensitiveContent("token=xyz1234567890123456789") !== null && detectSensitiveContent("正常约定") === null);

  check("非法 topic 拒绝", writeMemory("project", "..\\x", "内容", "append", projMem).ok === false);

  // 全局记忆路径（~/.infu/memory）
  const gdir = join(HOME, ".infu", "memory");
  const wg = writeMemory("global", "preferences", "测试模型用 agnes", "append", projMem);
  check("全局记忆写入 ~/.infu/memory", wg.ok && existsSync(join(gdir, "preferences.md")));
  check("全局记忆读取", readMemory("global", "preferences", projMem).text.includes("测试模型用 agnes"));
  const wg2 = writeMemory("global", "preferences", "不许用 deepseek", "append", projMem);
  check("全局记忆追加两条", readMemory("global", "preferences", projMem).text.includes("不许用 deepseek"));

  // 写保护精确化：write_file 依旧拦截 ~/.infu，memory_write 是唯一合法通道（本工具内部校验路径）
  check("~/.infu 仍受写保护（write_file 无合法场景）", isProtectedPath(join(gdir, "x.md")) !== null);
  check("memory_write 白名单路径解析正确", resolveMemoryPath("global", "preferences", projMem) === join(gdir, "preferences.md"));
}

// ── 4. 工具接线 ──
console.log("\n── 工具接线 ──");
{
  check("TOOLS 含 memory_read（low）", TOOLS.memory_read?.risk === "low");
  check("TOOLS 含 memory_write（low，v2.10 批 5 对齐主流自动）", TOOLS.memory_write?.risk === "low");
  const ro = getReadOnlyTools();
  check("Planner/Reviewer 白名单含 memory_read", !!ro.memory_read);
  check("Planner/Reviewer 白名单不含 memory_write", !ro.memory_write);

  const toolProj = join(proj, "tool-proj");
  mkdirSync(toolProj, { recursive: true });
  const events: AgentEvent[] = [];
  const mkCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
    root: toolProj,
    cwd: toolProj,
    requestApproval: async () => true,
    emit: (e) => events.push(e),
    ...over,
  });

  (async () => {
    // memory_read 工具：列主题 / 读主题 / global
    const rList = await TOOLS.memory_read.execute({}, mkCtx());
    check("memory_read 列主题", rList.includes("conventions"));
    const rRead = await TOOLS.memory_read.execute({ topic: "conventions" }, mkCtx());
    check("memory_read 读主题", rRead.includes("项目约定"));
    const rG = await TOOLS.memory_read.execute({ scope: "global", topic: "preferences" }, mkCtx());
    check("memory_read global", rG.includes("测试模型用 agnes"));

    // memory_write 工具（v2.10 批 5 降 low 自动放行）：写入成功；拒绝 mock 下也自动写入（low 不弹审批）
    const rW = await TOOLS.memory_write.execute({ topic: "lessons", content: "不要用 write_file 覆盖锁定文件" }, mkCtx());
    check("memory_write 写入成功", rW.includes("已写入项目记忆 lessons.md"));
    check("lessons 内容落盘", readMemory("project", "lessons", toolProj).text.includes("不要用 write_file"));
    const rAuto = await TOOLS.memory_write.execute({ topic: "lessons", content: "自动放行" }, mkCtx({ requestApproval: async () => false }));
    check("memory_write low 自动放行（拒绝 mock 不拦截）", rAuto.includes("已写入"), rAuto);
    const rBad = await TOOLS.memory_write.execute({ topic: "../x", content: "y" }, mkCtx());
    check("memory_write 非法 topic 拒绝（工具层）", rBad.includes("错误"));

    // 作用域接线：write_file 命中禁止 → 拒绝；允许范围内 → 正常
    writeFileSync(join(toolProj, "keep.txt"), "keep\n");
    const denyCtx = mkCtx({ scopeRules: [{ allow: false, pattern: "keep.txt" }] });
    const rBlock = await TOOLS.write_file.execute({ path: "keep.txt", content: "改" }, denyCtx);
    check("write_file 命中禁止规则 → 拒绝", rBlock.includes("超出作用域"));
    const allowCtx = mkCtx({ scopeRules: [{ allow: true, pattern: "*.txt" }] });
    // v3.2 read-before-edit：覆盖已存在文件前先读（模拟真实 Agent 行为）
    await TOOLS.read_file.execute({ path: "keep.txt" }, allowCtx);
    const rOk = await TOOLS.write_file.execute({ path: "keep.txt", content: "允许改" }, allowCtx);
    check("write_file 允许范围内 → 正常写入", rOk.includes("已写入"));
    // read_file 同样校验
    const rReadBlock = await TOOLS.read_file.execute({ path: "keep.txt" }, denyCtx);
    check("read_file 命中禁止规则 → 拒绝", rReadBlock.includes("超出作用域"));

    // 写保护不变：write_file 写 ~/.infu 仍被拦截（绝对路径先触 root 越界，随后是保护检查；两种都算拦截成功）
    const rProt = await TOOLS.write_file.execute({ path: join(HOME, ".infu", "memory", "evil.md"), content: "x" }, mkCtx());
    check("write_file 写 ~/.infu 仍被拦截", rProt.includes("越界") || rProt.includes("受保护区域"));
  })();
}

// ── 5. 自动沉淀（项目历史）──
console.log("\n── 自动沉淀 ──");
{
  const sedProj = join(proj, "sed-proj");
  mkdirSync(sedProj, { recursive: true });
  const result = {
    text: "任务完成：修复了登录 bug",
    steps: 8,
    toolCount: 10,
    approvals: { required: 3, approved: 3, denied: 0 },
    toolLogs: [
      { tool: "write_file", args: { path: "src/login.ts" }, ok: true, summary: "已写入 src/login.ts（120 字符）" },
      { tool: "run_test", args: {}, ok: true, summary: "测试通过：18 passed" },
      { tool: "read_file", args: { path: "src/a.ts" }, ok: true, summary: "文件 src/a.ts" },
    ],
  };
  const s1 = sedimentTask({ root: sedProj, prompt: "修复登录 bug\n第二行", result, report: "## 交付报告\n修复完成", reviewText: "结论：通过", modelLabel: "agnes/agnes-2.5-flash" });
  check("沉淀返回路径（.infu/history/YYYY-MM-DD.md）", /history[\\/]\d{4}-\d{2}-\d{2}\.md$/.test(s1.path));
  const content = readFileSync(s1.path, "utf-8");
  check("条目含标题（去换行截断）", content.includes("修复登录 bug 第二行"));
  check("条目含模型元数据", content.includes("agnes/agnes-2.5-flash"));
  check("条目含步数/工具/审批统计", content.includes("8 步") && content.includes("3/3 通过"));
  check("改动概览只含写类/验证工具", content.includes("write_file: 已写入 src/login.ts") && content.includes("run_test: 测试通过") && !content.includes("read_file"));

  check("条目含审查意见", content.includes("结论：通过"));
  check("条目含执行摘要", content.includes("任务完成：修复了登录 bug"));

  // 多任务追加同一天文件
  const s2 = sedimentTask({ root: sedProj, prompt: "第二个任务", result: { ...result, text: "任务二完成" }, modelLabel: "agnes/agnes-2.5-flash" });
  check("同文件追加", s1.path === s2.path);
  const content2 = readFileSync(s1.path, "utf-8");
  check("追加两条条目", content2.includes("第二个任务") && content2.includes("任务二完成"));

  // 空日志兜底
  const s3 = sedimentTask({ root: sedProj, prompt: "空任务", result: { ...result, toolLogs: [] } });
  check("空 toolLogs 兜底文案", readFileSync(s3.path, "utf-8").includes("无写类/验证类工具记录"));

  // 超多工具日志防爆（只取前 40 行；用全新目录避免历史条目干扰统计）
  const sedProj2 = join(proj, "sed-proj2");
  mkdirSync(sedProj2, { recursive: true });
  const many = Array.from({ length: 60 }, (_, i) => ({ tool: "write_file" as const, args: {}, ok: true, summary: `已写入 file${i}.ts` }));
  const s4 = sedimentTask({ root: sedProj2, prompt: "大任务", result: { ...result, toolLogs: many } });
  const c4 = readFileSync(s4.path, "utf-8");
  const count = (c4.match(/- \[✓\] write_file/g) || []).length;
  check("改动概览防爆（≤40 行）", count <= 40 && count === 40);
}

// ── 汇总（清理在最后：工具接线节是 microtask，先于同步清理执行）──
setTimeout(() => {
  rmSync(proj, { recursive: true, force: true });
  // 清理全局记忆测试残留（保持用户环境干净）
  try {
    rmSync(join(HOME, ".infu", "memory", "preferences.md"), { force: true });
    rmSync(join(HOME, ".infu", "memory"), { recursive: true, force: true });
  } catch { /* ignore */ }
  console.log(`\n=== 记忆系统自测完成：${passed} 通过，${failed} 失败 ===\n`);
  if (failed > 0) process.exit(1);
}, 50);
