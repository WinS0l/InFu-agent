/**
 * vision 底座工具（v3.0，触发条件 = 桌面化 + vision 模型）
 *  - read_image：读图片文件 → 注入视觉上下文（ctx.visionQueue → loop 下一轮合并为 image part）
 *  - screen_capture / screen_click / screen_type：computer-use 桌面操作（仅桌面模式，
 *    主进程 PowerShell 截图 + SendInput 零依赖）
 * 非视觉模型：图片注入后由既有降级机制（loop 图片特征错误 → 转文本重试）兜底。
 */
import { z } from "zod";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
      "截取当前屏幕并注入视觉上下文（computer-use：视觉模型据此决定下一步操作）。仅桌面版可用。截图保存在项目 .infu/screenshots/ 目录，**返回的完整文件路径是唯一事实——不要猜测/拼接路径，需要重新读取时用返回的绝对路径**。minimize=true 时先最小化 InFu 窗口再截（InFu 挡在最前会截到自己；截完自动恢复）。何时用：需要观察桌面/应用状态时（与浏览器工具互补——browser_snapshot 管网页，screen_capture 管桌面）。",
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
};

/** 写文件辅助（截图工具内部用；避免循环依赖 util 的 guard） */
export function writeShot(file: string, buf: Buffer): void {
  writeFileSync(file, buf);
}
