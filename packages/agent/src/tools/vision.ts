/**
 * vision 底座工具（v3.0，触发条件 = 桌面化 + vision 模型）
 *  - read_image：读图片文件 → 注入视觉上下文（ctx.visionQueue → loop 下一轮合并为 image part）
 *  - screen_capture / screen_click / screen_type：computer-use 桌面操作（仅桌面模式，
 *    主进程 PowerShell 截图 + SendInput 零依赖）
 * 非视觉模型：图片注入后由既有降级机制（loop 图片特征错误 → 转文本重试）兜底。
 */
import { z } from "zod";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import type { ToolDef, ToolContext } from "@infu/shared";
import { isPathInside } from "./util.js";

/** 图片类型白名单 → data URL 前缀 */
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_IMG = 8 * 1024 * 1024; // 8MB（视觉模型输入上限附近）

function isDesktop(): boolean {
  return process.versions.electron !== undefined;
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

export const visionTools: Record<string, ToolDef> = {
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
      "截取当前屏幕并注入视觉上下文（computer-use：视觉模型据此决定下一步操作）。仅桌面版可用。截图保存在项目 .infu/screenshots/ 目录，**返回的完整文件路径是唯一事实——不要猜测/拼接路径，需要重新读取时用返回的绝对路径**。minimize=true 时先最小化 InFu 窗口再截（InFu 挡在最前会截到自己；截完自动恢复）。多显示器时截取全部屏幕的合并区域（点击/移动坐标以该合并图为基准）。何时用：需要观察桌面/应用状态时（与浏览器工具互补——browser_snapshot 管网页，screen_capture 管桌面）。",
    risk: "low",
    schema: z.object({
      minimize: z.boolean().optional().describe("true = 先最小化 InFu 窗口再截（操作桌面时建议；默认 false 截当前屏幕全貌）"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_capture 仅桌面版可用（Web 版无屏幕访问能力）";
      const g = globalThis as Record<string, unknown>;
      const cap = g.__infuScreenCapture as ((dir: string, minimize?: boolean, sessionId?: string) => string | null) | undefined;
      if (typeof cap !== "function") return "错误：桌面截图通道不可用（主进程未接线）";
      const file = cap(shotDir(ctx), args.minimize === true, ctx.sessionId);
      if (!file || !existsSync(file)) return "截图失败：桌面截图通道未返回文件";
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
        `\n文件绝对路径：${file}（read_image 需要时用此路径，不要猜测）`
      );
    },
  },
  "screen_click": {
    name: "screen_click",
    description:
      "在屏幕坐标（x, y）执行鼠标点击（computer-use：配合 screen_capture 观察后操作）。仅桌面版可用。坐标 = 屏幕像素（截图同坐标系）。",
    risk: "medium",
    schema: z.object({
      x: z.number().describe("屏幕 x 坐标（像素）"),
      y: z.number().describe("屏幕 y 坐标（像素）"),
      button: z.enum(["left", "right", "double"]).optional().describe("点击类型（默认 left）"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_click 仅桌面版可用";
      if (!(await ctx.requestApproval(`桌面鼠标点击 (${args.x}, ${args.y})`, "medium"))) return "用户拒绝：未点击";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as ((action: string, ...params: Array<string | number>) => string) | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const btn = (args.button as string) ?? "left";
      const r = input("click", args.x as number, args.y as number, btn);
      return r.startsWith("OK") ? `已点击 (${args.x}, ${args.y}) ${btn === "double" ? "双击" : btn === "right" ? "右键" : "左键"}` : `点击失败：${r}`;
    },
  },
  "screen_type": {
    name: "screen_type",
    description:
      "向当前聚焦窗口输入文本（computer-use：点击输入框后键入）。仅桌面版可用。注意：输入落在系统当前焦点处——使用前先 screen_click 聚焦目标。",
    risk: "medium",
    schema: z.object({
      text: z.string().describe("要输入的文本"),
    }),
    async execute(args, ctx) {
      if (!isDesktop()) return "错误：screen_type 仅桌面版可用";
      if (!(await ctx.requestApproval(`桌面键盘输入：${(args.text as string).slice(0, 40)}`, "medium"))) return "用户拒绝：未输入";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as ((action: string, ...params: Array<string | number>) => string) | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = input("type", args.text as string);
      return r.startsWith("OK") ? `已输入 ${(args.text as string).slice(0, 40)}` : `输入失败：${r}`;
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
      if (!(await ctx.requestApproval(`桌面滚动：${dir} ×${amount}`, "medium"))) return "用户拒绝：未滚动";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as ((action: string, ...params: Array<string | number>) => string) | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = input("scroll", dir, amount);
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
      if (!(await ctx.requestApproval(`桌面按键：${(args.keys as string).slice(0, 40)}`, "medium"))) return "用户拒绝：未按键";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as ((action: string, ...params: Array<string | number>) => string) | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = input("key", args.keys as string);
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
      const input = g.__infuScreenInput as ((action: string, ...params: Array<string | number>) => string) | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = input("move", args.x as number, args.y as number);
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
      if (!(await ctx.requestApproval(desc, "medium"))) return "用户拒绝：未拖拽";
      const g = globalThis as Record<string, unknown>;
      const input = g.__infuScreenInput as ((action: string, ...params: Array<string | number>) => string) | undefined;
      if (typeof input !== "function") return "错误：桌面输入通道不可用（主进程未接线）";
      const r = input("drag", args.x1 as number, args.y1 as number, args.x2 as number, args.y2 as number, (args.steps as number | undefined) ?? 10);
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
        if (!(await ctx.requestApproval(`激活窗口：${name}`, "medium"))) return "用户拒绝：未激活";
      }
      const g = globalThis as Record<string, unknown>;
      const win = g.__infuScreenWindows as ((action: string, name?: string) => string) | undefined;
      if (typeof win !== "function") return "错误：桌面窗口通道不可用（主进程未接线）";
      return win(action, name);
    },
  },
};

/** 写文件辅助（截图工具内部用；避免循环依赖 util 的 guard） */
export function writeShot(file: string, buf: Buffer): void {
  writeFileSync(file, buf);
}
