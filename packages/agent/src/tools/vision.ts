/**
 * vision 底座工具（v3.0，触发条件 = 桌面化 + vision 模型）
 *  - read_image：读图片文件 → 注入视觉上下文（ctx.visionQueue → loop 下一轮合并为 image part）
 *  - screen_capture / screen_click / screen_type：computer-use 桌面操作（仅桌面模式，
 *    主进程 PowerShell 截图 + SendInput 零依赖）
 *  - ocr_image（v6.0 B5）：Windows 自带 OCR（Windows.Media.Ocr，PowerShell WinRT）——无视觉
 *    模型时的截图文字兜底：图片 → 纯文本，零依赖、支持中文
 * 非视觉模型：图片注入后由既有降级机制（loop 图片特征错误 → 转文本重试）兜底。
 */
import { z } from "zod";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import type { DesktopScreenCapture, DesktopScreenInput, ToolDef, ToolContext } from "@infu/shared";
import { isPathInside, guard } from "./util.js";
import { isProtectedPath } from "../sandbox/index.js";
import { resolveDataDir } from "../data-dir.js";

/** 图片类型白名单 → data URL 前缀 */
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_IMG = 8 * 1024 * 1024; // 8MB（视觉模型输入上限附近）
/** 避免把可能的令牌/私钥回显到审批、工具结果或会话时间线。 */
const SENSITIVE_TYPED_TEXT = /(?:\b(?:sk|ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{12,}\b|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

function isDesktop(): boolean {
  return process.versions.electron !== undefined;
}

async function verifyScreen(expected: string, pid?: number): Promise<string> {
  const tree = (globalThis as Record<string, unknown>).__infuScreenTree as
    | ((opts: { maxDepth?: number; maxElements?: number; pid?: number }) => Promise<string>)
    | undefined;
  if (typeof tree !== "function") return "验证失败：桌面 UI 树通道不可用（主进程未接线）";
  try {
    const body = await tree({ maxDepth: 6, maxElements: 160, pid });
    const evidence = body.slice(0, 1200);
    return body.includes(expected)
      ? `验证通过：UI 树包含 ${JSON.stringify(expected)}\n证据：${evidence}`
      : `验证失败：UI 树未包含 ${JSON.stringify(expected)}\n证据：${evidence}`;
  } catch (e) {
    return `验证失败：${(e as Error).message}`;
  }
}

/** 截图目录（项目 .infu/screenshots/——INFU 产物统一收进 .infu/） */
function shotDir(ctx: ToolContext): string {
  const dir = join(ctx.root, ".infu", "screenshots");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function pushVision(ctx: ToolContext, dataUrl: string, label: string) {
  (ctx.visionQueue ??= []).push(dataUrl);
  return `已注入视觉上下文（${label}）——模型下一轮将看到该图片；若模型不支持视觉会自动降级`;
}

// ══════════════════ v6.0（B5）OCR 截图文字兜底 ══════════════════
// Windows 自带 OCR（Windows.Media.Ocr，WinRT）——PowerShell 5.1 可直接投影 WinRT 类型，
// 零外部依赖；支持中文（zh-CN 语言包随系统）。触发场景：无视觉模型时把截图/图片的
// 文字提取为纯文本供模型阅读。

const OCR_PS1 = `param([string]$ImagePath, [string]$Lang = "")
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\x601' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = $null
  if ($Lang) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $Lang))
  }
  if (-not $engine) {
    $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
    $pref = $langs | Where-Object { $_.LanguageTag -like 'zh*' } | Select-Object -First 1
    if ($pref) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($pref) }
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { Write-Output "OCR_ERR:无可用 OCR 识别引擎（系统未安装 OCR 语言包）"; exit 1 }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  foreach ($line in $result.Lines) { Write-Output $line.Text }
} catch {
  Write-Output ("OCR_ERR:" + $_.Exception.Message)
  exit 1
}`;

/** OCR 单张图片（Windows.Media.Ocr；非 Windows / 无引擎 → 明确报错） */
export async function ocrImageFile(
  abs: string,
  lang?: string,
  timeoutMs = 30000
): Promise<{ ok: boolean; message: string; text?: string }> {
  if (process.platform !== "win32") return { ok: false, message: "OCR 仅 Windows 可用（依赖系统自带 Windows.Media.Ocr 引擎）" };
  if (!existsSync(abs)) return { ok: false, message: `错误：文件不存在 ${abs}` };
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".bmp"].includes(ext)) {
    return { ok: false, message: `错误：OCR 仅支持 png/jpg/jpeg/bmp（${ext}）` };
  }
  const psFile = join(resolveDataDir(), "ocr.ps1");
  try { writeFileSync(psFile, OCR_PS1, "utf-8"); } catch { /* 落盘失败用已有文件 */ }
  return new Promise((res) => {
    let proc;
    try {
      proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psFile, "-ImagePath", abs, ...(lang ? ["-Lang", lang] : [])], {
        windowsHide: true,
      });
    } catch {
      return res({ ok: false, message: "PowerShell 启动失败（OCR 不可用）" });
    }
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString("utf-8"); });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* 忽略 */ }
      res({ ok: false, message: "OCR 超时" });
    }, timeoutMs);
    proc.on("close", () => {
      clearTimeout(timer);
      const t = out.trim();
      if (!t) return res({ ok: false, message: `OCR 无输出（引擎不可用？）${err ? `：${err.slice(0, 200)}` : ""}` });
      if (t.startsWith("OCR_ERR:")) return res({ ok: false, message: t.slice("OCR_ERR:".length) });
      return res({ ok: true, message: `OCR 识别完成${lang ? `（${lang}）` : "（自动）"}`, text: t });
    });
  });
}

/** 项目内最新截图路径（无则返回 null） */
function latestShot(ctx: ToolContext): string | null {
  const dir = join(ctx.root, ".infu", "screenshots");
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir).filter((f) => /\.(png|jpe?g|bmp)$/i.test(f));
    if (!files.length) return null;
    const latest = files.map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
    return join(dir, latest.f);
  } catch {
    return null;
  }
}

export const visionTools: Record<string, ToolDef> = {
  "ocr_image": {
    name: "ocr_image",
    description:
      "对图片做 OCR 文字识别（Windows 自带引擎 Windows.Media.Ocr，零依赖，支持中文）——无视觉模型时的截图文字兜底：把图片里的文字提取为纯文本，模型可直接阅读。何时用：模型不支持视觉、或需要精确读取界面文字/报错信息时（配合 screen_capture 截图后识别）。何时不用：模型支持视觉时 read_image 信息更完整（含布局/颜色）。path 省略时自动识别项目 .infu/screenshots/ 里最新一张截图。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的图片路径（png/jpg/jpeg/bmp；省略 = 最新截图）"),
      lang: z.string().optional().describe("识别语言（如 zh-CN/en-US；省略 = 自动优先中文）"),
    }),
    async execute(args, ctx) {
      let abs: string;
      if (args.path) {
        const rel = args.path as string;
        abs = resolve(ctx.root, rel);
        if (!isPathInside(ctx.root, abs)) return "错误：路径越界（不允许访问项目根之外）";
      } else {
        const shot = latestShot(ctx);
        if (!shot) return "错误：.infu/screenshots/ 下没有截图（先 screen_capture，或用 path 指定图片）";
        abs = shot;
      }
      if (isProtectedPath(abs)) return "错误：图片位于受保护区域，拒绝 OCR";
      const r = await ocrImageFile(abs, args.lang as string | undefined);
      if (!r.ok) return r.message;
      const text = r.text ?? "";
      return `OCR 文字识别结果（${text.length} 字符，图片 ${abs.split(/[\\/]/).pop()}）：\n${text.slice(0, 4000)}${text.length > 4000 ? "\n…（已截断，完整文本过长）" : ""}`;
    },
  },
  "read_image": {
    name: "read_image",
    description:
      "读取图片文件（png/jpg/webp）并注入视觉上下文——支持视觉的模型下一轮即可「看到」图片内容。何时用：需要分析截图/图片/设计稿时。何时不用：纯文本文件用 read_file；模型不支持视觉时本工具会提示降级。",
    risk: "low",
    schema: z.object({
      path: z.string().describe("相对项目根的图片路径（png/jpg/jpeg/webp/gif）"),
    }),
    async execute(args, ctx) {
      const rel = args.path as string;
      const abs = resolve(ctx.root, rel);
      if (!isPathInside(ctx.root, abs)) return "错误：路径越界（不允许访问项目根之外）";
      if (isProtectedPath(abs)) return "错误：图片位于受保护区域，拒绝读取";
      if (!existsSync(abs)) return `错误：文件不存在 ${rel}`;
      const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
      const mime = MIME[ext];
      if (!mime) return `错误：不支持的图片类型 ${ext}（支持 png/jpg/jpeg/webp/gif）`;
      const size = existsSync(abs) ? (await import("node:fs")).statSync(abs).size : 0;
      if (size > MAX_IMG) return `错误：图片过大（${(size / 1024 / 1024).toFixed(1)}MB > 8MB 上限）`;
      const b64 = readFileSync(abs).toString("base64");
      return pushVision(ctx, `data:${mime};base64,${b64}`, `${rel} ${(size / 1024).toFixed(0)}KB`);
    },
  },
  "screen_capture": {
    name: "screen_capture",
    description:
      "截取当前屏幕并注入视觉上下文（computer-use：视觉模型据此决定下一步操作）。仅桌面版可用。截图保存在项目 .infu/screenshots/ 目录，**返回的完整文件路径是唯一事实——不要猜测/拼接路径，需要重新读取时用返回的绝对路径**。多显示器截图返回虚拟桌面原点：图片内坐标是相对坐标，screen_click/move/drag 使用的始终是绝对物理屏幕坐标，需将图片坐标加上该原点；screen_tree 已直接返回绝对坐标。minimize=true 时先最小化 InFu 窗口再截（InFu 挡在最前会截到自己；截完自动恢复）。",
    risk: "low",
    schema: z.object({
      minimize: z.boolean().optional().describe("true = 先最小化 InFu 窗口再截（操作桌面时建议；默认 false 截当前屏幕全貌）"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_capture 仅桌面版可用（Web 版无屏幕访问能力）";
      const g = globalThis as Record<string, unknown>;
      const cap = g.__infuScreenCapture as DesktopScreenCapture | undefined;
      if (typeof cap !== "function") return "错误：桌面截图通道不可用（主进程未接线）";
      const captured = await cap(shotDir(ctx), args.minimize === true, ctx.sessionId, ctx.abortSignal);
      if (!captured || !existsSync(captured.file)) return "截图失败：桌面截图通道未返回文件";
      const { file, origin } = captured;
      // v3.4 审计修复（M7）：screen_capture 补大小上限（原实现无检查——4K 双屏 PNG
      // 可达 10-40MB，base64 后直接撑爆下一轮模型请求；read_image 有 8MB 检查它没有）
      const shotSize = statSync(file).size;
      if (shotSize > MAX_IMG) {
        return `截图过大（${(shotSize / 1024 / 1024).toFixed(1)}MB > 8MB 上限）：${file}——请用 read_image 按需读取或先压缩/裁剪后再分析`;
      }
      const b64 = readFileSync(file).toString("base64");
      const name = file.split(/[\\/]/).pop() ?? "shot.png";
      return (
        pushVision(ctx, `data:image/png;base64,${b64}`, `桌面截图 ${name}`) +
        `\n文件绝对路径：${file}（read_image 需要时用此路径，不要猜测）` +
        `\n虚拟桌面原点：(${origin.x}, ${origin.y})。截图内 (0,0) = 此绝对屏幕坐标；操作截图中的点时，将图片坐标加上此原点。`
      );
    },
  },
  "screen_tree": {
    name: "screen_tree",
    description:
      "读取桌面应用的 UI 可访问性树（Windows UI Automation——对齐 Codex get_app_state）：控件类型/名称/位置矩形/可用状态。交互控件带 [n] 编号 + 绝对坐标（物理像素，与 screen_capture 截图/screen_click 点击同坐标系）。何时用：操作桌面应用前**先读树**——比截图+视觉猜坐标精确得多（控件名称直接可读）；截图用于操作后的视觉验证。点击坐标 = 矩形中心 (x + 宽/2, y + 高/2)。仅桌面版可用。",
    risk: "low",
    schema: z.object({
      max_depth: z.number().int().min(1).max(10).optional().describe("树最大深度（默认 5；深层应用如浏览器可加大）"),
      max_elements: z.number().int().min(10).max(300).optional().describe("最多输出交互元素数（默认 120）"),
      pid: z.number().int().min(0).optional().describe("目标窗口的进程 id（screen_windows 查看；缺省 = 当前前台窗口）"),
    }),
    async execute(args, _ctx) {
      if (!isDesktop()) return "错误：screen_tree 仅桌面版可用（Web 版无桌面访问能力）";
      const g = globalThis as Record<string, unknown>;
      const tree = g.__infuScreenTree as ((opts: { maxDepth?: number; maxElements?: number; pid?: number }) => Promise<string>) | undefined;
      if (typeof tree !== "function") return "错误：桌面 UI 树通道不可用（主进程未接线）";
      const r = await tree({
        maxDepth: args.max_depth as number | undefined,
        maxElements: args.max_elements as number | undefined,
        pid: args.pid as number | undefined,
      });
      // 树文本 8K 截断（超长折叠提示——大应用树可达数百行）
      const body = r.length > 8000 ? r.slice(0, 8000) + `\n…（UI 树过长已截断，共 ${r.length} 字符——可用 max_elements/max_depth 收窄或 pid 指定窗口）` : r;
      return `【桌面 UI 可访问性树】\n${body}`;
    },
  },
  "screen_verify": {
    name: "screen_verify",
    description:
      "验证桌面 UI 自动化结果：读取目标/前台窗口的 UI 可访问性树，并确认 expected 文本存在。关键点击、输入、安装或提交后应调用；失败会返回截断的当前 UI 证据，供重新定位或恢复。",
    risk: "low",
    schema: z.object({
      expected: z.string().min(1).describe("UI 树中应出现的窗口标题、控件名称或状态文本"),
      pid: z.number().int().min(0).optional().describe("目标窗口进程 id；缺省 = 当前前台窗口"),
    }),
    async execute(args) {
      if (!isDesktop()) return "错误：screen_verify 仅桌面版可用";
      return await verifyScreen(args.expected as string, args.pid as number | undefined);
    },
  },
  "screen_click": {
    name: "screen_click",
    description:
      "在屏幕坐标（x, y）执行鼠标点击（computer-use：配合 screen_capture 观察后操作）。仅桌面版可用。坐标 = 屏幕像素（截图同坐标系）。提供 expected 时会在点击后读取 UI 树并验证结果。",
    risk: "medium",
    schema: z.object({
      x: z.number().describe("屏幕 x 坐标（像素）"),
      y: z.number().describe("屏幕 y 坐标（像素）"),
      button: z.enum(["left", "right", "double"]).optional().describe("点击类型（默认 left）"),
      expected: z.string().min(1).optional().describe("点击后 UI 树中应出现的文本"),
      pid: z.number().int().min(0).optional().describe("验证目标窗口进程 id"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_click 仅桌面版可用";
      if (!(await guard(ctx, "screen_click", "medium", `桌面鼠标点击 (${args.x}, ${args.y})`))) return "用户拒绝：未点击";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as DesktopScreenInput | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const btn = (args.button as string) ?? "left";
      const r = await input("click", [args.x as number, args.y as number, btn], ctx.abortSignal);
      if (!r.startsWith("OK")) return `点击失败：${r}`;
      const out = `已点击 (${args.x}, ${args.y}) ${btn === "double" ? "双击" : btn === "right" ? "右键" : "左键"}`;
      return typeof args.expected === "string"
        ? `${out}\n${await verifyScreen(args.expected, args.pid as number | undefined)}`
        : out;
    },
  },
  "screen_type": {
    name: "screen_type",
    description:
      "向当前聚焦窗口输入文本（computer-use：点击输入框后键入）。仅桌面版可用。注意：输入落在系统当前焦点处——使用前先 screen_click 聚焦目标。提供 expected 时会在输入后验证 UI 树，输入内容始终不回显。",
    risk: "medium",
    schema: z.object({
      text: z.string().describe("要输入的文本"),
      expected: z.string().min(1).optional().describe("输入后 UI 树中应出现的非敏感状态文本"),
      pid: z.number().int().min(0).optional().describe("验证目标窗口进程 id"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_type 仅桌面版可用";
      const text = args.text as string;
      const sensitive = SENSITIVE_TYPED_TEXT.test(text);
      const description = sensitive
        ? `向桌面应用输入疑似敏感凭据（${text.length} 个字符，内容已遮蔽）`
        : `桌面键盘输入（${text.length} 个字符）`;
      if (!(await guard(ctx, "screen_type", sensitive ? "high" : "medium", description, sensitive))) return "用户拒绝：未输入";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as DesktopScreenInput | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = await input("type", [text], ctx.abortSignal);
      if (!r.startsWith("OK")) return `输入失败：${r}`;
      const out = `已输入 ${text.length} 个字符（内容不回显）`;
      return typeof args.expected === "string"
        ? `${out}\n${await verifyScreen(args.expected, args.pid as number | undefined)}`
        : out;
    },
  },
  "screen_scroll": {
    name: "screen_scroll",
    description:
      "滚动当前鼠标位置的页面/列表（computer-use：配合 screen_capture 观察后滚动）。仅桌面版可用。direction=up/down 垂直、left/right 水平（Shift+滚轮语义）；amount=格数（1 格 ≈ 3-5 行，默认 1）。何时用：页面超出截图范围需要查看更多内容时（比反复截图+点击更精准）。",
    risk: "medium",
    schema: z.object({
      direction: z.enum(["up", "down", "left", "right"]).optional().describe("滚动方向（默认 down）"),
      amount: z.number().int().min(1).max(20).optional().describe("滚动格数（默认 1；1 格 ≈ 3-5 行）"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_scroll 仅桌面版可用";
      const dir = String(args.direction ?? "down");
      const amount = Number(args.amount ?? 1);
      if (!(await guard(ctx, "screen_scroll", "medium", `桌面滚动：${dir} ×${amount}`))) return "用户拒绝：未滚动";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as DesktopScreenInput | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = await input("scroll", [dir, amount], ctx.abortSignal);
      return r.startsWith("OK") ? `已滚动 ${dir} ${amount} 格` : `滚动失败：${r}`;
    },
  },
  "screen_key": {
    name: "screen_key",
    description:
      "向系统发送按键/组合键（computer-use：操作快捷键——Ctrl+C 复制、Ctrl+V 粘贴、Enter 确认、Alt+Tab 切窗、F5 刷新、方向键导航等）。仅桌面版可用。格式：用 + 组合，如 \"ctrl+c\"、\"alt+tab\"、\"enter\"、\"f5\"、\"shift+up\"。支持 a-z/0-9/enter/tab/esc/space/方向键/f1-f12/ctrl/alt/shift/win。何时用：点击/输入之外需要快捷键操作的场景。",
    risk: "medium",
    schema: z.object({
      keys: z.string().describe("按键组合（+ 分隔：ctrl+c、alt+tab、enter、f5、shift+up）"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_key 仅桌面版可用";
      if (!(await guard(ctx, "screen_key", "medium", `桌面按键：${(args.keys as string).slice(0, 40)}`))) return "用户拒绝：未按键";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as DesktopScreenInput | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = await input("key", [args.keys as string], ctx.abortSignal);
      return r.startsWith("OK") ? `已按键 ${args.keys}` : `按键失败：${r}`;
    },
  },
  "screen_move": {
    name: "screen_move",
    description:
      "移动鼠标到屏幕坐标（不点击）——computer-use：悬停预览/准备点击前定位。仅桌面版可用。坐标 = 屏幕像素（截图同坐标系）。",
    risk: "low",
    schema: z.object({
      x: z.number().describe("屏幕 x 坐标（像素）"),
      y: z.number().describe("屏幕 y 坐标（像素）"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_move 仅桌面版可用";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as DesktopScreenInput | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = await input("move", [args.x as number, args.y as number], ctx.abortSignal);
      return r.startsWith("OK") ? `鼠标已移动到 (${args.x}, ${args.y})` : `移动失败：${r}`;
    },
  },
  // ── v3.3 computer use 补齐（对齐 Codex 官方契约 drag / Claude Code 拖拽能力）──
  "screen_drag": {
    name: "screen_drag",
    description:
      "从坐标 (x1,y1) 拖拽到 (x2,y2)（按下左键 → 移动 → 松开）——computer-use：拖拽文件/滑块/画布/选中文本范围。仅桌面版可用。坐标 = 屏幕像素（截图同坐标系）。",
    risk: "medium",
    schema: z.object({
      x1: z.number().describe("起点屏幕 x 坐标（像素）"),
      y1: z.number().describe("起点屏幕 y 坐标（像素）"),
      x2: z.number().describe("终点屏幕 x 坐标（像素）"),
      y2: z.number().describe("终点屏幕 y 坐标（像素）"),
      steps: z.number().int().min(1).max(50).optional().describe("移动步数（默认 10；拖拽越慢越稳，长距离可加大）"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_drag 仅桌面版可用";
      const desc = `桌面拖拽 (${args.x1}, ${args.y1}) → (${args.x2}, ${args.y2})`;
      if (!(await guard(ctx, "screen_drag", "medium", desc))) return "用户拒绝：未拖拽";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as DesktopScreenInput | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = await input("drag", [args.x1 as number, args.y1 as number, args.x2 as number, args.y2 as number, (args.steps as number | undefined) ?? 10], ctx.abortSignal);
      return r.startsWith("OK") ? `已拖拽 (${args.x1}, ${args.y1}) → (${args.x2}, ${args.y2})` : `拖拽失败：${r}`;
    },
  },
  "screen_windows": {
    name: "screen_windows",
    description:
      "窗口管理（computer-use：定位/切换到目标应用窗口）——action=list 列出当前可见窗口（进程名+窗口标题，只读）；action=activate 激活指定窗口（按进程名或标题模糊匹配，前台置顶并恢复最小化）。仅桌面版可用。何时用：screen_capture 截到的是当前前台窗口，需要操作其他应用时先 list 找目标再 activate。",
    risk: "low",
    schema: z.object({
      action: z.enum(["list", "activate"]).describe("list=列出可见窗口；activate=激活指定窗口"),
      name: z.string().optional().describe("activate 用：进程名（如 notepad/chrome）或窗口标题关键词（模糊匹配）"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_windows 仅桌面版可用";
      const action = String(args.action ?? "list");
      const name = String(args.name ?? "").trim();
      if (action === "activate") {
        if (!name) return "错误：activate 需要 name 参数（进程名或窗口标题关键词）";
        if (!(await guard(ctx, "screen_windows", "medium", `激活窗口：${name}`))) return "用户拒绝：未激活";
      }
      const g = globalThis as Record<string, unknown>;
      const win = g.__infuScreenWindows as ((action: string, name?: string, signal?: AbortSignal) => Promise<string>) | undefined;
      if (typeof win !== "function") return "错误：桌面窗口通道不可用（主进程未接线）";
      return win(action, name, ctx.abortSignal);
    },
  },
};

/** 写文件辅助（截图工具内部用；避免循环依赖 util 的 guard） */
export function writeShot(file: string, buf: Buffer): void {
  writeFileSync(file, buf);
}
