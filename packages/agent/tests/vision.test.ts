/**
 * vision 底座自测（v3.4 审计修复 H1/M7 回归——此前 visionQueue 无任何测试覆盖，
 * read_image/screen_capture 的图片注入完全失效却从未被测试发现）
 * 运行：npx tsx packages/agent/tests/vision.test.ts
 */
import { TOOLS } from "../src/tools/index.js";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, AgentEvent } from "@infu/shared";
import { setDataDirForTest } from "../src/data-dir.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  OK ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

const proj = fs.mkdtempSync(join(tmpdir(), "infu-vision-"));
const dataDir = fs.mkdtempSync(join(tmpdir(), "infu-vision-data-"));
setDataDirForTest(dataDir);
fs.writeFileSync(join(dataDir, "config.json"), JSON.stringify({ version: 1, models: [], approvalPolicy: { mode: "confirm" } }));
fs.mkdirSync(join(proj, "src"), { recursive: true });
// 1x1 红色像素 PNG
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
fs.writeFileSync(join(proj, "src", "pic.png"), PNG_1PX);

const events: AgentEvent[] = [];
// H1 回归关键：ctx 必须预置 visionQueue（loop 构造如此），工具执行收到浅拷贝
const ctx: ToolContext = {
  root: proj,
  cwd: proj,
  requestApproval: async () => true,
  emit: (e) => events.push(e),
  visionQueue: [],
};
// 模拟 loop 执行方式：浅拷贝 + callId（H1 的根因场景）
const run = (name: string, args: Record<string, unknown>) =>
  TOOLS[name].execute(args, { ...ctx, callId: "c-test" });

console.log("\n=== vision 底座自测 ===\n");

// 1. read_image 注入（H1 回归：图片必须进入原 ctx 队列）
console.log("> read_image 注入");
const ri = await run("read_image", { path: "src/pic.png" });
check("注入成功提示", ri.includes("注入视觉上下文"), ri);
check("H1 回归：图片进入原 ctx 队列", ctx.visionQueue!.length === 1, String(ctx.visionQueue!.length));
check("data URL 前缀正确", ctx.visionQueue![0].startsWith("data:image/png;base64,"), ctx.visionQueue![0].slice(0, 40));

// 2. read_image 边界
console.log("\n> read_image 边界");
const esc = await run("read_image", { path: "../../evil.png" });
check("越界拒绝", esc.includes("越界"), esc);
const missing = await run("read_image", { path: "nope.png" });
check("文件不存在拒绝", missing.includes("不存在"), missing);
fs.writeFileSync(join(proj, "src", "note.txt"), "text");
const badType = await run("read_image", { path: "src/note.txt" });
check("非图片类型拒绝", badType.includes("不支持"), badType);
// >8MB 拒绝
fs.writeFileSync(join(proj, "src", "big.png"), Buffer.alloc(8 * 1024 * 1024 + 1, 0));
const big = await run("read_image", { path: "src/big.png" });
check("超过 8MB 拒绝", big.includes("过大"), big);

// 3. screen_capture（桌面通道模拟；process.versions.electron 需存在）
console.log("\n> screen_capture");
const origElectron = process.versions.electron;
(process.versions as Record<string, string>).electron = "43.0.0";
let capCalls = 0;
(globalThis as Record<string, unknown>).__infuScreenCapture = async (dir: string) => {
  capCalls++;
  const f = join(dir, `shot-${capCalls}.png`);
  fs.writeFileSync(f, PNG_1PX);
  return { file: f, origin: { x: -1920, y: 0 } };
};
// 模拟 loop 的浅拷贝执行（H1 场景：拷贝上的 push 必须仍进入原 ctx）
const sc = await TOOLS.screen_capture.execute({}, { ...ctx, callId: "c2" });
check("截图注入成功", sc.includes("注入视觉上下文") && sc.includes("文件绝对路径"), sc);
check("H1 回归：截图进入原 ctx 队列", ctx.visionQueue!.length === 2, String(ctx.visionQueue!.length));
check("截图文件路径返回", sc.includes(".infu"), sc);
check("截图返回相对坐标换算原点", sc.includes("虚拟桌面原点：(-1920, 0)"), sc);
check("截图调用了一次桌面通道", capCalls === 1, String(capCalls));

// 4. M7 回归：超大截图拒绝（不注入队列）
console.log("\n> screen_capture 大小上限（M7）");
const preLen = ctx.visionQueue!.length;
(globalThis as Record<string, unknown>).__infuScreenCapture = async (dir: string) => {
  const f = join(dir, `huge-${Date.now()}.png`);
  fs.writeFileSync(f, Buffer.alloc(9 * 1024 * 1024, 0));
  return { file: f, origin: { x: 0, y: 0 } };
};const scBig = await TOOLS.screen_capture.execute({}, { ...ctx, callId: "c3" });
check("超大截图拒绝并提示", scBig.includes("过大") && scBig.includes("8MB"), scBig.slice(0, 80));
check("超大截图未注入队列", ctx.visionQueue!.length === preLen, String(ctx.visionQueue!.length));

// 4.5 B3：screen_tree（UI 可访问性树——对齐 Codex get_app_state；桌面通道模拟）
console.log("\n> screen_tree（UI 树）");
let treeOpts: Record<string, unknown> | null = null;
(globalThis as Record<string, unknown>).__infuScreenTree = async (opts: Record<string, unknown>) => {
  treeOpts = opts;
  return '【窗口】 测试应用\n- Pane "主窗口"\n  [0] Button "确定" (100,200 80x30)\n  [1] Edit "搜索框" (100,240 300x22)';
};
const st = await TOOLS.screen_tree.execute({ max_depth: 6, max_elements: 50, pid: 1234 }, { ...ctx, callId: "c4" });
check("screen_tree 返回 UI 树", st.includes("【桌面 UI 可访问性树】") && st.includes('[0] Button "确定"') && st.includes("100,200 80x30"), st.slice(0, 120));
check("screen_tree 参数透传", treeOpts?.maxDepth === 6 && treeOpts?.maxElements === 50 && treeOpts?.pid === 1234, JSON.stringify(treeOpts));
check("screen_tree 未注入视觉队列（纯文本）", ctx.visionQueue!.length === preLen, String(ctx.visionQueue!.length));
const sv = await TOOLS.screen_verify.execute({ expected: "搜索框", pid: 1234 }, { ...ctx, callId: "c4v" });
check("screen_verify 返回 UI 验证证据", sv.startsWith("验证通过") && sv.includes("证据"), sv.slice(0, 180));
// 超长树截断（mock 10000 字符 > 8000 截断线）
(globalThis as Record<string, unknown>).__infuScreenTree = async () => "行\n".repeat(5000);
const stLong = await TOOLS.screen_tree.execute({}, { ...ctx, callId: "c5" });
check("超长 UI 树截断并提示", stLong.includes("已截断") && stLong.length < 9000, String(stLong.length));
// 非桌面拒绝
const savedElectron = process.versions.electron;
delete (process.versions as Record<string, string>).electron;
const stWeb = await TOOLS.screen_tree.execute({}, { ...ctx, callId: "c6" });
check("非桌面拒绝 screen_tree", stWeb.includes("仅桌面版可用"), stWeb);
(process.versions as Record<string, string>).electron = savedElectron as string;

// 5. screen_click 审批拒绝/批准
console.log("\n> screen_click 审批");
let receivedSignal: AbortSignal | undefined;
let receivedInput: { action: string; params: Array<string | number> } | undefined;
(globalThis as Record<string, unknown>).__infuScreenInput = async (action: string, params: Array<string | number>, signal?: AbortSignal) => {
  receivedSignal = signal;
  receivedInput = { action, params };
  return `OK:${action}:${params.join(",")}`;
};
let denied = false;
const denyCtx: ToolContext = { ...ctx, visionQueue: [], requestApproval: async () => { denied = true; return false; } };
const deniedOut = await TOOLS.screen_click.execute({ x: 10, y: 20 }, { ...denyCtx, callId: "c4" });
check("拒绝时未点击", deniedOut.includes("用户拒绝"), deniedOut);
check("medium 审批被触发", denied, "未触发审批");
const okOut = await TOOLS.screen_click.execute({ x: 10, y: 20 }, { ...ctx, callId: "c5" });
check("批准后点击成功", okOut.includes("已点击 (10, 20)"), okOut);
(globalThis as Record<string, unknown>).__infuScreenTree = async () =>
  '【窗口】 测试应用\n  [0] Button "确定"\n  [1] Edit "搜索框"';
const verifiedClick = await TOOLS.screen_click.execute({ x: 10, y: 20, expected: "确定", pid: 1234 }, { ...ctx, callId: "c5v" });
check("screen_click 单次调用包含操作后验证", verifiedClick.includes("验证通过") && verifiedClick.includes("确定"), verifiedClick);
const controller = new AbortController();
await TOOLS.screen_move.execute({ x: -1910, y: 20 }, { ...ctx, callId: "absolute", abortSignal: controller.signal });
check("桌面输入使用绝对坐标并透传取消信号", receivedSignal === controller.signal && receivedInput?.action === "move" && receivedInput.params[0] === -1910, JSON.stringify(receivedInput));

// 6. 其余 screen_* 通道
console.log("\n> screen_type / scroll / key / move / drag / windows");
const t1 = await TOOLS.screen_type.execute({ text: "hello" }, { ...ctx, callId: "c6" });
check("type 成功且不回显输入", t1.includes("已输入 5 个字符") && !t1.includes("hello"), t1);
const t1v = await TOOLS.screen_type.execute({ text: "secret-value", expected: "搜索框", pid: 1234 }, { ...ctx, callId: "c6v" });
check("screen_type 单次调用验证且不泄露输入", t1v.includes("验证通过") && !t1v.includes("secret-value"), t1v);
const t2 = await TOOLS.screen_scroll.execute({ direction: "down", amount: 2 }, { ...ctx, callId: "c7" });
check("scroll 成功", t2.includes("已滚动 down 2"), t2);
const t3 = await TOOLS.screen_key.execute({ keys: "ctrl+c" }, { ...ctx, callId: "c8" });
check("key 成功", t3.includes("已按键 ctrl+c"), t3);
const t4 = await TOOLS.screen_move.execute({ x: 5, y: 6 }, { ...ctx, callId: "c9" });
check("move 成功", t4.includes("已移动到 (5, 6)"), t4);
const t5 = await TOOLS.screen_drag.execute({ x1: 0, y1: 0, x2: 100, y2: 100 }, { ...ctx, callId: "c10" });
check("drag 成功", t5.includes("已拖拽"), t5);
(globalThis as Record<string, unknown>).__infuScreenWindows = async (_action: string) => "OK list";
const t6 = await TOOLS.screen_windows.execute({ action: "list" }, { ...ctx, callId: "c11" });
check("windows list 成功", t6.includes("OK"), t6);
const t7 = await TOOLS.screen_windows.execute({ action: "activate", name: "notepad" }, { ...ctx, callId: "c12" });
check("windows activate 成功", t7.includes("OK"), t7);

// 7. 非桌面环境拒绝
console.log("\n> 非桌面环境");
delete (process.versions as Record<string, string>).electron;
const web = await run("screen_capture", {});
check("Web 环境 screen_capture 拒绝", web.includes("仅桌面版可用"), web);
const webClick = await run("screen_click", { x: 1, y: 1 });
check("Web 环境 screen_click 拒绝", webClick.includes("仅桌面版可用"), webClick);
// 还原（后续测试可能复用进程）
if (origElectron !== undefined) (process.versions as Record<string, string>).electron = origElectron;

// 清理
fs.rmSync(proj, { recursive: true, force: true });
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
