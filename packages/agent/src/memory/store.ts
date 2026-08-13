/**
 * v2.6 记忆存储（L1 全局 / L2 项目）— 文件系统即记忆
 *
 * - 项目记忆：<root>/.infu/memory/<topic>.md（随项目版本控制）
 * - 全局记忆：~/.infu/memory/<topic>.md（跨项目偏好/工作流）
 * - 主题 = 目录下 *.md 文件名；首次访问创建默认主题模板，给 Agent 明确的写入起点
 *
 * 安全边界：全局记忆位于 ~/.infu（受 isProtectedPath 写保护）——本模块是唯一合法
 * 写入通道。工具层白名单：topic 必须 ^[a-zA-Z0-9_-]{1,64}$（无路径穿越/后缀逃逸）。
 * 敏感信息检测（v2.6.1，Codex secret-redactor 轻量版）：写入前扫描 API key/token/
 * 私钥/连接串等模式，命中即拒绝——记忆文件（可能 git 版本化）不允许进凭据。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type MemoryScope = "project" | "global";

/** 主题名白名单（防路径穿越与非法字符；同时约束长度） */
export const TOPIC_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 敏感凭据模式（Codex secret-redactor 对齐；命中即拒绝写入记忆） */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|sk-[A-Za-z0-9])-[A-Za-z0-9_-]{16,}\b/, // OpenAI/DeepSeek 风格 key
  /\bAKIA[A-Z0-9]{16}\b/, // AWS access key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\bAIza[A-Za-z0-9_-]{20,}\b/, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // 私钥（开头不加 \b：- 与 - 之间无词边界）
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i, // Bearer token
  /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/i, // 显式键值
  /\b(mongodb\+srv|postgres|mysql|redis|amqp|mqtt):\/\/[^\s"']+/i, // 数据库连接串
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
];

/**
 * 检测内容是否含敏感凭据；返回命中描述或 null（安全）。
 * 用于 memory_write 写入前拦截（Codex secret-redactor 轻量版）。
 */
export function detectSensitiveContent(content: string): string | null {
  for (const re of SECRET_PATTERNS) {
    const m = content.match(re);
    if (m) return `疑似敏感凭据：${m[0].slice(0, 40)}`;
  }
  return null;
}

/** 默认主题模板（首次访问自动创建）：主题名 → 中文说明 */
export const DEFAULT_TOPICS: Record<string, string> = {
  conventions: "项目约定（技术栈决策、代码规范、构建/测试命令、用户明确要求）",
  lessons: "踩坑教训（本仓库容易踩的坑与规避方法）",
  preferences: "偏好（跨项目通用偏好与工作流，放全局记忆；项目专属偏好放此处）",
};

/** 记忆读取上限（单主题截断，防止撑爆上下文） */
export const MEMORY_READ_LIMIT = 24 * 1024;

/** 全局记忆目录（~/.infu/memory/） */
export function globalMemoryDir(): string {
  return path.join(os.homedir(), ".infu", "memory");
}

/** 项目记忆目录（<root>/.infu/memory/） */
export function projectMemoryDir(root: string): string {
  return path.join(root, ".infu", "memory");
}

/** 校验主题名；非法返回错误信息（合法返回 null） */
export function validateTopic(topic: string): string | null {
  if (!topic.trim()) return "topic 不能为空";
  if (!TOPIC_RE.test(topic.trim())) return "topic 只能含字母/数字/下划线/连字符（1-64 字符）";
  return null;
}

/** 解析记忆路径（scope + topic → 绝对路径）；非法 topic 抛错由调用方处理 */
export function resolveMemoryPath(scope: MemoryScope, topic: string, root: string): string {
  const err = validateTopic(topic);
  if (err) throw new Error(err);
  const dir = scope === "global" ? globalMemoryDir() : projectMemoryDir(root);
  return path.join(dir, `${topic.trim()}.md`);
}

/** 确保记忆目录与默认主题模板存在（幂等；只在首次访问时创建模板） */
export function ensureMemoryDir(scope: MemoryScope, root: string): string {
  const dir = scope === "global" ? globalMemoryDir() : projectMemoryDir(root);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // 首次创建：预置默认主题模板（只建目录刚创建时的这一次，避免覆盖用户后续自建）
    for (const [topic, hint] of Object.entries(DEFAULT_TOPICS)) {
      const p = path.join(dir, `${topic}.md`);
      if (!fs.existsSync(p)) {
        fs.writeFileSync(
          p,
          `# ${topic}\n\n> ${hint}\n> 本文件由 memory_read / memory_write 工具读写，也可手动编辑。\n`,
          "utf-8"
        );
      }
    }
  }
  return dir;
}

/** 列出主题（返回 {name, hint} 列表；hint 取文件首行非空标题） */
export function listTopics(scope: MemoryScope, root: string): Array<{ name: string; hint: string }> {
  const dir = scope === "global" ? globalMemoryDir() : projectMemoryDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -3);
      let hint = "";
      try {
        const first = fs.readFileSync(path.join(dir, f), "utf-8").split("\n").find((l) => l.trim());
        if (first) hint = first.replace(/^#+\s*/, "").trim();
      } catch {
        /* 读取失败不阻塞列表 */
      }
      return { name, hint };
    });
}

/** 读取主题内容（带截断）；topic 省略时返回主题列表文本。首次访问（目录不存在）自动创建默认模板 */
export function readMemory(scope: MemoryScope, topic: string | undefined, root: string): { text: string; topics: Array<{ name: string; hint: string }> } {
  // 首次访问创建目录与默认模板（读/写均触发；幂等）
  ensureMemoryDir(scope, root);
  const topics = listTopics(scope, root);
  if (!topic || !topic.trim()) {
    const body = topics.length
      ? topics.map((t) => `- ${t.name}：${t.hint}`).join("\n")
      : "（暂无主题；可写入 conventions/lessons/preferences 或自建主题）";
    return { text: `可用主题（${scope === "global" ? "全局记忆 ~/.infu/memory/" : "项目记忆 .infu/memory/" }）：\n${body}`, topics };
  }
  const p = resolveMemoryPath(scope, topic, root);
  if (!fs.existsSync(p)) {
    return { text: `主题「${topic.trim()}」不存在（可用 memory_write 创建）`, topics };
  }
  const content = fs.readFileSync(p, "utf-8");
  return {
    text: `记忆（${scope === "global" ? "全局" : "项目"} · ${topic.trim()}，${content.length} 字符）${content.length > MEMORY_READ_LIMIT ? "（已截断）" : ""}：\n${content.slice(0, MEMORY_READ_LIMIT)}`,
    topics,
  };
}

/** 写入记忆（append=追加一条带时间戳的记录；replace=整体覆盖）。写入前做敏感凭据检测（Codex 模式）。 */
export function writeMemory(
  scope: MemoryScope,
  topic: string,
  content: string,
  mode: "append" | "replace",
  root: string
): { ok: boolean; message: string } {
  if (!content.trim()) return { ok: false, message: "content 不能为空" };
  const secret = detectSensitiveContent(content);
  if (secret) return { ok: false, message: `拒绝写入：${secret}——记忆文件不允许存凭据（请去掉后再写）` };
  const err = validateTopic(topic);
  if (err) return { ok: false, message: err };
  const dir = ensureMemoryDir(scope, root);
  const p = path.join(dir, `${topic.trim()}.md`);
  try {
    if (mode === "replace" || !fs.existsSync(p)) {
      fs.writeFileSync(p, content.trim() + "\n", "utf-8");
    } else {
      const now = new Date();
      const stamp = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)}`;
      fs.appendFileSync(p, `\n---\n\n## ${stamp}（Agent 记录）\n\n${content.trim()}\n`, "utf-8");
    }
    return { ok: true, message: `已写入${scope === "global" ? "全局" : "项目"}记忆 ${topic.trim()}.md（${mode === "replace" ? "覆盖" : "追加"}）` };
  } catch (e) {
    return { ok: false, message: `写入失败：${(e as Error).message}` };
  }
}
