/**
 * v2.6 收尾新增工具：任务协作类
 * - read_files：批量读取多个文件（Gemini read_many_files 同款，省上下文轮次）
 * - todo_write：执行阶段任务清单（主流 TodoWrite 同款；会话内内存态，整体替换）
 * - ask_user：执行中向用户提问（主流 / Gemini ask_user / 主流 question 同款；
 *             经 ToolContext.askUser 通道接线：CLI 读 stdin、Web 弹窗、未接线返回错误）
 */
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { ToolDef, ToolContext } from "@infu/shared";
import { checkPathScope } from "../memory/index.js";
import { isProtectedPath } from "../sandbox/index.js";
import { clip, MAX_FILE_READ, isPathInside, markObservedFile } from "./util.js";

// ── read_files ──

/** 单文件读取核心（与 read_file 同规则：越界/作用域/敏感路径/大小/行号；v3.1 附件白名单放行）
 *  v4.0 审计修复：补 isProtectedPath——批量通道与单文件 read_file 防护对齐（此前 root=home
 *  会话可用 read_files 整批读出 ~/.ssh 私钥与 ~/.infu/config.json 凭据） */
export function readOneFile(rel: string, ctx: ToolContext, offset = 0, limit = 200): string {
  const abs = path.resolve(ctx.root, rel);
  const inExtra = (ctx.extraReadDirs ?? []).some((d) => isPathInside(d, abs));
  if (!isPathInside(ctx.root, abs) && !inExtra) return `错误：路径越界（不允许访问项目根之外）: ${rel}`;
  const protectedName = isProtectedPath(abs);
  if (protectedName && !inExtra) {
    return `错误：目标路径位于受保护区域（${protectedName}），拒绝读取——Agent 没有读取 SSH 密钥/凭据/配置的合法场景`;
  }
  const scopeErr = checkPathScope(rel, ctx.scopeRules);
  if (scopeErr && !inExtra) return `错误：路径超出作用域——${scopeErr}（项目指令「路径作用域」节）`;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `错误：文件不存在 ${rel}`;
  if (fs.statSync(abs).size > MAX_FILE_READ) return `错误：文件过大（>${MAX_FILE_READ} 字节），请用 search_code 定位相关内容: ${rel}`;
  const all = fs.readFileSync(abs, "utf-8").split("\n");
  const off = offset || 0;
  const lim = limit || 200;
  const lines = all.slice(off, off + lim);
  const head = `文件 ${rel}（共 ${all.length} 行，显示 ${off + 1}-${off + lines.length} 行）`;
  const full = head + "\n```\n" + lines.map((l, i) => `${off + i + 1}\t${l}`).join("\n") + "\n```";
  const clipped = clip(full);
  markObservedFile(ctx.sessionId ?? "", abs, all.join("\n"), off, limit, clipped.length < full.length, fs.statSync(abs));
  return clipped;
}

// ── todo_write 内存态任务清单（按会话 + 项目根隔离；会话结束清理）──

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * v3.6 审计修复：原按 root 键控——并行会话同一 root 互相覆盖清单，且条目随 root
 * 永久累积（长驻服务内存增长，无清理点）。改按「会话 + root」隔离 + clearTodos
 * 会话结束清理（server/cli finally 挂接，与 clearObservedFiles 同模式）。
 */
const todoStores = new Map<string, TodoItem[]>();

function todoKey(sessionId: string | undefined, root: string): string {
  return `${sessionId ?? "cli"}\u0000${root}`;
}

export function getTodos(root: string, sessionId?: string): TodoItem[] {
  return todoStores.get(todoKey(sessionId, root)) ?? [];
}

export function setTodos(root: string, items: TodoItem[], sessionId?: string): TodoItem[] {
  todoStores.set(todoKey(sessionId, root), items);
  return items;
}

/** v3.6：会话结束清理（防长驻服务内存累积；CLI 无会话 id 用 "cli" 键） */
export function clearTodos(sessionId?: string): void {
  const prefix = `${sessionId ?? "cli"}\u0000`;
  for (const k of todoStores.keys()) {
    if (k.startsWith(prefix)) todoStores.delete(k);
  }
}

function formatTodos(items: TodoItem[]): string {
  if (!items.length) return "任务清单为空";
  const statusMark = (s: TodoItem["status"]) => (s === "completed" ? "[x]" : s === "in_progress" ? "[→]" : "[ ]");
  const done = items.filter((i) => i.status === "completed").length;
  const lines = items.map((i, n) => `${n + 1}. ${statusMark(i.status)} ${i.text}`);
  return `任务清单（${done}/${items.length} 完成）：\n${lines.join("\n")}`;
}

// ── 工具定义 ──

export const taskTools: Record<string, ToolDef> = {
  glob: {
    name: "glob",
    description:
      "按 glob 模式查找文件路径（如 **/*.ts、src/**/*.tsx、*.md）。与 search_code 互补：glob 按路径/模式找文件（不知道内容时用），search_code 按文件内容搜索。自动跳过 node_modules/.git/.infu/dist 等目录。",
    risk: "low",
    schema: z.object({
      pattern: z.string().min(1).describe("glob 模式（相对项目根；** 跨任意层级，* 单段，{a,b} 多选）"),
    }),
    async execute(args, ctx) {
      const pattern = args.pattern as string;
      // v2.13：防越界增强——原实现只挡 `..`/`../`，反斜杠（`..\..\Users`）与绝对路径
      // （`C:\...`、`/...`）可逃出项目根；统一用相对路径规则校验
      if (/\.\.([\\/]|$)/.test(pattern) || /^([a-zA-Z]:[\\/]|\/)/.test(pattern)) {
        return "错误：glob 模式必须相对项目根（不允许 .. 与绝对路径）";
      }
      try {
        const matches = await fg(pattern, {
          cwd: ctx.root,
          ignore: ["**/node_modules/**", "**/.git/**", "**/.infu/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**", "**/target/**"],
          onlyFiles: true,
          dot: false,
          absolute: false,
          suppressErrors: true,
        });
        const limited = matches.slice(0, 200);
        const lines = limited.map((p) => `- ${p}`).join("\n");
        return `匹配 ${matches.length} 个文件${matches.length > 200 ? `（仅显示前 200 个）` : ""}：\n${lines}`;
      } catch (e) {
        return `错误：glob 执行失败：${(e as Error).message}`;
      }
    },
  },

  read_files: {
    name: "read_files",
    description:
      "批量读取多个文件内容（每个文件最多 200 行，超大文件会被拒绝）。比逐个 read_file 更省轮次。返回带行号文本，多个文件用分隔线隔开。",
    risk: "low",
    schema: z.object({
      paths: z.array(z.string().min(1)).min(1).max(10).describe("相对项目根的文件路径列表（最多 10 个）"),
    }),
    async execute(args, ctx) {
      // 执行端参数防御（zod 只用于生成 schema 给模型，模型可能传错类型——友好报错让模型自纠）
      const raw = args.paths;
      if (!Array.isArray(raw)) {
        return `错误：paths 参数必须是数组（收到 ${raw === null ? "null" : typeof raw}）。请重新调用，形如 ["src/a.ts","src/b.ts"]。`;
      }
      const paths = (raw as unknown[]).filter((p): p is string => typeof p === "string");
      if (!paths.length) return "错误：paths 为空数组（至少要一个文件路径）";
      const parts = paths.map((p) => readOneFile(p, ctx));
      return parts.join("\n\n──────\n\n");
    },
  },

  todo_write: {
    name: "todo_write",
    description:
      "维护当前任务的执行清单（TodoWrite）。多步任务开始时先建立任务清单，每完成一步更新对应项状态（整体替换：调用时传入最新完整清单）。" +
      "状态：pending 待办 / in_progress 进行中 / completed 完成。任务完成时清空或全部标记 completed。",
    risk: "low",
    schema: z.object({
      todos: z
        .array(
          z.object({
            text: z.string().min(1).describe("任务项描述"),
            status: z.enum(["pending", "in_progress", "completed"]).optional().describe("状态（默认 pending）"),
          })
        )
        .max(20)
        .describe("完整任务清单（整体替换旧清单；空数组=清空）"),
    }),
    async execute(args, ctx) {
      // 执行端参数防御（模型可能传错类型——友好报错让模型自纠，不抛 TypeError）
      const raw = args.todos;
      if (!Array.isArray(raw)) {
        return `错误：todos 参数必须是数组（收到 ${raw === null ? "null" : typeof raw}）。请重新调用，形如 [{"text":"任务项","status":"pending"}]，不要用对象/字符串替代。`;
      }
      const items: TodoItem[] = (raw as Array<{ text?: unknown; status?: unknown }>).map((t) => ({
        text: typeof t?.text === "string" ? t.text : String(t?.text ?? ""),
        status: (["pending", "in_progress", "completed"].includes(t?.status as string) ? (t?.status as string) : "pending") as TodoItem["status"],
      }));
      setTodos(ctx.root, items, ctx.sessionId);
      // v2.10：emit 事件（前端 Todo 面板实时展示 + 落库重放）
      ctx.emit({ type: "todo-write", items });
      return formatTodos(items);
    },
  },

  ask_user: {
    name: "ask_user",
    description:
      "在执行过程中向用户提问（澄清需求/选型确认/获取必要信息）。用户回答后继续任务；用户未回答（跳过）时返回空。仅在确实需要用户输入时使用，不要用琐碎问题打断。",
    risk: "low",
    schema: z.object({
      question: z.string().describe("要问用户的问题（清晰具体）"),
      description: z.string().optional().describe("问题补充说明（背景/权衡，弹窗展示；可选）"),
      multiSelect: z.boolean().optional().describe("是否允许多选（默认单选；加性功能开关用多选，互斥选择用单选）"),
      options: z
        .array(
          z.union([
            z.string().min(1),
            z.object({
              label: z.string().min(1).describe("选项标签（1-5 词）"),
              desc: z.string().optional().describe("选项说明（1-2 句，可选）"),
              recommended: z.boolean().optional().describe("推荐选项（UI 显示推荐徽章）"),
            }),
          ])
        )
        .max(8)
        .optional()
        .describe("可选项（用户可从中选择或自定义回答；推荐用结构化对象带 recommended/desc）"),
    }),
    async execute(args, ctx) {
      if (!ctx.askUser) {
        return "错误：ask_user 通道未接线（当前环境不支持执行中提问，请改为在任务描述中说明需求）";
      }
      if (typeof args.question !== "string" || !args.question.trim()) {
        return "错误：question 参数必须是字符串。请重新调用并给出要问的问题。";
      }
      const question = args.question as string;
      // v2.10：选项归一化为结构化（string → {label}；对象原样保留 desc/recommended）
      const options = (Array.isArray(args.options) ? (args.options as unknown[]) : undefined)?.map((o) =>
        typeof o === "string"
          ? { label: o }
          : {
              label: String((o as { label?: unknown }).label ?? ""),
              desc: (o as { desc?: unknown }).desc as string | undefined,
              recommended: (o as { recommended?: unknown }).recommended as boolean | undefined,
            }
      );
      const answer = await ctx.askUser(question, options as Array<string | { label: string; desc?: string; recommended?: boolean }> | undefined);
      if (answer == null) return "用户未回答（跳过该问题，继续任务）";
      const trimmed = answer.trim();
      return trimmed ? `用户回答：${trimmed}` : "用户未回答（跳过该问题，继续任务）";
    },
  },
};
