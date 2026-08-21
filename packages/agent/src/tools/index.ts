/**
 * InFu 基础工具系统 — PRD 一期 10 个基础工具
 * 基础层：文件 / 终端 / Git；工程层工具（测试）前置基础版
 */

import { z } from "zod";
import fs from "node:fs";
import path, { join } from "node:path";
import type { ToolDef, ToolContext, RiskLevel } from "@infu/shared";
import {
  sanitizeEnv, isProtectedPath, auditCommand, containsSensitiveOutput,
} from "../sandbox/index.js";
import { detectEgress, egressBlockedMessage } from "../sandbox/net-policy.js";
import { registerMcpServer, type RegisterInput } from "../mcp/register.js";
import { registerPlugin, type RegisterPluginInput } from "../plugin/register.js";
import { listSkills, readSkillContent } from "../plugin/skills.js";
import { listAgents, readAgentFile } from "../agent/agents.js";
import { DANGEROUS, isDangerousCommand } from "../sandbox/dangerous.js";
import { delegateTasks, describeDelegation, isReadOnlyDelegation, startBackgroundSubagent,
  listBackgroundAgents, getBackgroundAgent, interruptBackgroundAgent, sendMessageToAgent, getAgentReport,
  availableSubagentSlots, MAX_ACTIVE_SUBAGENTS_PER_SESSION,
  type SubagentSpec } from "../agent/subagent.js";
import { startBackgroundJob, listJobs, getJob, getJobOutput, killJob, auditJobStart } from "./jobs.js";
import { readMemory, writeMemory, validateTopic, checkPathScope } from "../memory/index.js";
import { loadConfig } from "../providers/registry.js";
import { currentApprovalPolicy, isCommandAllowed, hasShellCombinators } from "../approval/policy.js";
import { isEgressAllowed } from "../egress-allow.js";
import {
  clip, MAX_OUTPUT, MAX_FILE_READ, runShell, execLocal, sandboxTag, walkFiles, guard, isPathInside,
  isReadOnlySessionRoot, sessionRootReadOnlyBlock, markObservedFile, assertObservedFileFresh,
  clearObservedFiles, resetObservedFiles,
} from "./util.js";
import { webTools } from "./web.js";
import { gitTools } from "./git-tools.js";
import { taskTools } from "./task-tools.js";
import { sessionTools } from "./session-tools.js";
import { visionTools } from "./vision.js";
import { semanticSearch } from "./semantic.js";
import { execPersistent, closeShellSession } from "./persistent-shell.js";
import { lspDiagnose, lspGotoDefinition, lspCompletions, lspFindReferences } from "./lsp.js";
import { loadIndex } from "../index/index.js";
import { searchSymbols, type SymbolKind } from "../index/symbols.js";
import { fsTools } from "./fs-tools.js";
import { envTools } from "./env-tools.js";
import { backupForRecovery } from "./recovery.js";

/**
 * v3.5 升级 read-before-edit（三层）：
 * ① 未读拒绝：write/edit 前文件必须被 read_file 过（新建文件免读）；
 * ② partial 拒绝：read_file 输出被截断（模型看到不完整内容）视为未读完整，拒绝编辑；
 * ③ stale 检测：每次读取记录文件指纹（mtimeMs + sizeBytes），写时比对——
 *    读后文件被外部修改（用户手改/其他进程/linter）→ 拒绝并提示重读（防基于过期缓存覆盖）。
 * 写成功后用新指纹刷新状态（自己写的算已知，可继续改，无需重读）。
 * 与 v3.2 布尔门禁的区别：v3.2 读一次永久放行（外部改了照样覆盖）；本版带指纹校验。
 */
/** Git numstat style line count: an empty file contributes zero; a trailing newline is not an extra line. */
function countContentLines(text: string): number {
  if (!text) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}
export { clearObservedFiles, resetObservedFiles } from "./util.js";

// ─────────────────────────── 工具定义 ───────────────────────────

/**
 * 高危命令检测（v3.4 审计修复 M2：多分支覆盖破坏性命令变体，见 sandbox/dangerous.ts）。
 * 从 tools/index.ts 提取为独立模块——run_command/run_test/terminal 共用同一门槛。
 */
export { DANGEROUS as DANGEROUS_RE_EXPORT } from "../sandbox/dangerous.js";

/**
 * delegate_task 参数 schema（v2.5）：单任务（prompt）或并行批量（tasks[]）互斥。
 * 单任务字段（agent/tools/root/maxSteps/modelId）与 tasks 元素同构。
 */
const subagentTaskSchema = z.object({
  prompt: z.string().min(1).describe("委派的子任务指令（清晰说明目标与约束）"),
  agent: z.string().min(1).optional().describe("agent 角色名（.infu/agents/<name>.md；缺省用默认子智能体角色）"),
  tools: z.array(z.string().min(1)).optional().describe("工具白名单（内置工具名；缺省 = 只读 + run_test）"),
  root: z.string().min(1).optional().describe("子工作目录（相对项目根；缺省 = 项目根）"),
  maxSteps: z.number().int().min(1).max(50).optional().describe("子循环步数上限（缺省 12）"),
  modelId: z.string().min(1).optional().describe("子模型 id（配置中的模型；缺省继承父级模型）"),
});
const delegateTaskSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    tasks: z.array(subagentTaskSchema).min(1).max(6).optional(),
    agent: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    root: z.string().min(1).optional(),
    maxSteps: z.number().int().min(1).max(50).optional(),
    modelId: z.string().min(1).optional(),
    // v2.11：后台模式（立即返回不阻塞，list_agents/report/send_message/interrupt_agent 管理）
    background: z.boolean().optional().describe("后台模式（默认 false=同步等待回收）。true 时立即返回子智能体 id，父级可继续其他任务；子智能体可用 agent_message 暂停等待父级回复（send_message 恢复）"),
  })
  .superRefine((v, ctx) => {
    const single = !!v.prompt;
    const batch = !!v.tasks?.length;
    if (!single && !batch) ctx.addIssue({ code: "custom", message: "必须提供 prompt（单任务）或 tasks（并行任务）" });
    if (single && batch) ctx.addIssue({ code: "custom", message: "prompt 与 tasks 不能同时提供" });
  });

export const TOOLS: Record<string, ToolDef> = {
  read_file: {
    name: "read_file",
    description:
      "读取文件内容。用于查看源代码、配置、文档。返回纯文本；二进制或超大文件会被截断。注意：write_file/edit_file 必须先读后改——本工具读取过的文件才允许编辑；若读取内容被截断或文件之后被外部修改，编辑会被拒绝并要求重读（对齐主流 read-before-edit）。",
    risk: "low",
    schema: z.object({
      path: z.string().describe("相对项目根的文件路径"),
      offset: z.number().int().min(0).optional().describe("起始行（从 0 开始，默认 0）"),
      limit: z.number().int().min(1).max(500).optional().describe("最多读取行数（默认 200）"),
    }),
    async execute(args, ctx) {
      const rel = args.path as string;
      const abs = path.resolve(ctx.root, rel);
      // v3.1 附件只读白名单：用户附加的文件/文件夹（绝对路径）可读
      const inExtra = (ctx.extraReadDirs ?? []).some((d) => isPathInside(d, abs));
      if (!isPathInside(ctx.root, abs) && !inExtra) return "错误：路径越界（不允许访问项目根之外）";
      // v3.9 审计修复（M3）：read_file 补敏感路径保护——此前只有写保护，root=home 的
      // 会话可读 ~/.infu/config.json（含 API Key）经 webfetch 外传。只读白名单（Planner/
      // Reviewer）同理。memory_read/use_skill 走独立实现不受影响；项目内 .infu 合法场景
      // （outputs/skills）不命中数据目录保护。
      const protectedName = isProtectedPath(abs);
      if (protectedName && !inExtra) {
        return `错误：目标路径位于受保护区域（${protectedName}），拒绝读取——Agent 没有读取 SSH 密钥/凭据/配置的合法场景`;
      }
      // v2.6 路径作用域（INFU.md「路径作用域」节声明式规则：禁止直接拒绝 / 白名单模式）
      const scopeErr = checkPathScope(rel, ctx.scopeRules);
      if (scopeErr && !inExtra) return `错误：路径超出作用域——${scopeErr}（项目指令「路径作用域」节；如需访问请更新规则或与用户确认）`;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `错误：文件不存在 ${rel}`;
      const st = fs.statSync(abs);
      if (st.size > MAX_FILE_READ) return `错误：文件过大（>${MAX_FILE_READ} 字节），请用 search_code 定位相关内容`;
      const all = fs.readFileSync(abs, "utf-8").split("\n");
      const offset = (args.offset as number) || 0;
      const limit = (args.limit as number) || 200;
      const lines = all.slice(offset, offset + limit);
      const head = `文件 ${rel}（共 ${all.length} 行，显示 ${offset + 1}-${offset + lines.length} 行）`;
      const full = head + "\n```\n" + lines.map((l, i) => `${offset + i + 1}\t${l}`).join("\n") + "\n```";
      const clipped = clip(full);
      // v3.5：记录读取指纹（read-before-edit 依据——未读/截断/文件变更都影响后续编辑）
      markObservedFile(ctx.sessionId ?? "", abs, all.join("\n"), offset, args.limit as number | undefined, clipped.length < full.length, st);
      return clipped;
    },
  },

  write_file: {
    name: "write_file",
    description:
      "写入文件（覆盖）。创建新文件或整体重写已有文件。注意：此操作会覆盖目标文件，需用户确认；覆盖已存在文件必须先 read_file 该文件——未读/上次读取不完整/文件已被外部修改都会被拒绝（对齐主流 read-before-edit + 文件变更检测）；新建文件免读。",
    // v2.10：文件编辑降 low（对齐主流：主流 默认模式写文件自动执行；
    // 安全不降级——敏感路径/只读容器/工作树隔离等写保护仍在）
    risk: "low",
    schema: z.object({
      path: z.string().describe("相对项目根的文件路径"),
      content: z.string().describe("完整文件内容"),
    }),
    async execute(args, ctx) {
      const rel = args.path as string;
      const abs = path.resolve(ctx.root, rel);
      if (!isPathInside(ctx.root, abs)) return "错误：路径越界（不允许访问项目根之外）";
      // v2.6 路径作用域（INFU.md「路径作用域」节）
      const scopeErr = checkPathScope(rel, ctx.scopeRules);
      if (scopeErr) return `错误：路径超出作用域——${scopeErr}（项目指令「路径作用域」节；如需写入请更新规则或与用户确认）`;
      // 敏感路径写保护（沙箱 L1）
      const protectedName = isProtectedPath(abs);
      if (protectedName) {
        return `错误：目标路径位于受保护区域（${protectedName}），拒绝写入——Agent 没有修改 SSH 密钥/凭据/配置的合法场景`;
      }
      // v3 默认会话根目录只读（自由会话容器）
      const roBlock = sessionRootReadOnlyBlock(ctx);
      if (roBlock) return `错误：${roBlock}`;
      // v3.5 read-before-edit：覆盖已存在文件必须先读（未读/partial/stale 拒绝）；新建免读
      if (fs.existsSync(abs)) {
        const gateErr = assertObservedFileFresh(ctx.sessionId ?? "", abs, fs.statSync(abs));
        if (gateErr) return gateErr;
      }
      const desc = `写入文件 ${rel}（${(args.content as string).length} 字符）`;
      if (!(await guard(ctx, "write_file", "low", desc))) return "用户拒绝：未写入";
      // An approval can wait for minutes. Recheck immediately before touching an existing file.
      if (fs.existsSync(abs)) {
        const gateErr = assertObservedFileFresh(ctx.sessionId ?? "", abs, fs.statSync(abs));
        if (gateErr) return gateErr;
      }
      const previous = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
      const recoveryId = fs.existsSync(abs) ? backupForRecovery(ctx.root, abs, rel, ctx.sessionId) : null;
      if (fs.existsSync(abs) && !recoveryId) return "错误：无法创建会话恢复副本，未写入";
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content as string, "utf-8");
      // v3.5：写成功 → 用新指纹刷新状态（自己写的算已知，可继续改无需重读）
      const st = fs.statSync(abs);
      markObservedFile(ctx.sessionId ?? "", abs, args.content as string, 0, undefined, false, st);
      const lines = countContentLines(args.content as string);
      ctx.recordFileDiff?.({ added: lines, removed: countContentLines(previous) });
      return `已写入 ${rel}（${(args.content as string).length} 字符，${lines} 行）${recoveryId ? `；可用 file_ops restore 恢复（记录 ${recoveryId}，7 天有效）` : ""}`;
    },
  },

  edit_file: {
    name: "edit_file",
    description:
      "精确替换文件中的一段文本（第一次匹配）。用于局部修改，比 write_file 更安全。必须先 read_file 该文件才能编辑——未读/上次读取不完整/文件已被外部修改都会被拒绝；若 old_text 匹配失败，请重读文件再试。",
    // v2.10：文件编辑降 low（对齐主流自动执行；安全不降级——写保护/只读容器/工作树隔离仍在）
    risk: "low",
    schema: z.object({
      path: z.string().describe("相对项目根的文件路径"),
      old_text: z.string().describe("被替换的原文（必须与文件内容完全一致）"),
      new_text: z.string().describe("替换后的新文本"),
    }),
    async execute(args, ctx) {
      const rel = args.path as string;
      const abs = path.resolve(ctx.root, rel);
      if (!isPathInside(ctx.root, abs)) return "错误：路径越界";
      const scopeErr = checkPathScope(rel, ctx.scopeRules);
      if (scopeErr) return `错误：路径超出作用域——${scopeErr}（项目指令「路径作用域」节）`;
      const protectedName = isProtectedPath(abs);
      if (protectedName) {
        return `错误：目标路径位于受保护区域（${protectedName}），拒绝修改`;
      }
      // v3 默认会话根目录只读（自由会话容器）
      const roBlock = sessionRootReadOnlyBlock(ctx);
      if (roBlock) return `错误：${roBlock}`;
      if (!fs.existsSync(abs)) return `错误：文件不存在 ${rel}`;
      // v3.5 read-before-edit：编辑必须先读（未读/partial/stale 拒绝）
      const st = fs.statSync(abs);
      const gateErr = assertObservedFileFresh(ctx.sessionId ?? "", abs, st);
      if (gateErr) return gateErr;
      const content = fs.readFileSync(abs, "utf-8");
      const oldText = args.old_text as string;
      if (!content.includes(oldText)) {
        return "错误：未找到匹配的原文（old_text 与文件当前内容不一致）——文件可能与你的认知有出入，请先 read_file 确认当前内容与行号后重试";
      }
      const desc = `修改文件 ${rel}（替换 ${oldText.length} 字符）`;
      if (!(await guard(ctx, "edit_file", "low", desc))) return "用户拒绝：未修改";
      const freshStat = fs.statSync(abs);
      const freshGateErr = assertObservedFileFresh(ctx.sessionId ?? "", abs, freshStat);
      if (freshGateErr) return freshGateErr;
      const freshContent = fs.readFileSync(abs, "utf-8");
      if (!freshContent.includes(oldText)) {
        return "错误：文件在审批期间已被修改，old_text 不再匹配——请重新 read_file 后再编辑";
      }
      const recoveryId = backupForRecovery(ctx.root, abs, rel, ctx.sessionId);
      if (!recoveryId) return "错误：无法创建会话恢复副本，未修改";
      const updated = freshContent.replace(oldText, args.new_text as string);
      fs.writeFileSync(abs, updated, "utf-8");
      // v3.5：编辑成功 → 用新指纹刷新状态（本会话后续可继续改，无需重读）
      const st2 = fs.statSync(abs);
      markObservedFile(ctx.sessionId ?? "", abs, updated, 0, undefined, false, st2);
      // 行数 diff 统计（+N -M 行）
      const oldLines = countContentLines(oldText);
      const newLines = countContentLines(args.new_text as string);
      const added = newLines;
      const removed = oldLines;
      ctx.recordFileDiff?.({ added, removed });
      return `已修改 ${rel}（${added > 0 ? `+${added} ` : ""}${removed > 0 ? `-${removed} ` : ""}行）；可用 file_ops restore 恢复（记录 ${recoveryId}，7 天有效）`;
    },
  },

  search_code: {
    name: "search_code",
    description:
      "在项目内搜索代码/文本（正则，忽略 node_modules/.git/dist 等目录）。返回文件:行号:内容。",
    risk: "low",
    schema: z.object({
      pattern: z.string().describe("正则表达式"),
      include: z.array(z.string()).optional().describe("只搜索匹配的文件扩展名，如 ['.ts', '.tsx']"),
      max_results: z.number().int().min(1).max(100).optional().describe("最大结果数（默认 30）"),
    }),
    async execute(args, ctx) {
      // v2.10：正则无效时友好报错（模型可据提示自纠转义，而非笼统「工具执行异常」）
      let re: RegExp;
      try {
        re = new RegExp(args.pattern as string);
      } catch (e) {
        return `错误：正则表达式无效（${(e as Error).message}）——需要匹配字面特殊字符时请转义（如 \\. \\+ \\( \\)）`;
      }
      const include = (args.include as string[] | undefined) || null;
      const max = (args.max_results as number | undefined) || 30;
      const hits: string[] = [];
      // v2.7 索引复用：有索引用索引文件清单（更快），否则实时扫描
      const idx = loadIndex(ctx.root);
      const files = idx ? idx.files.map((f) => path.resolve(ctx.root, f.file)) : walkFiles(ctx.root);
      for (const file of files) {
        // 审计 H-1 兜底：旧索引可能含凭据文件、.SSH 大小写变体可漏过 SKIP——命中拒绝
        if (isProtectedPath(file)) continue;
        if (include && !include.some((ext) => file.endsWith(ext))) continue;
        if (hits.length >= max) break;
        try {
          const lines = fs.readFileSync(file, "utf-8").split("\n");
          for (let i = 0; i < lines.length && hits.length < max; i++) {
            if (re.test(lines[i])) {
              hits.push(`${path.relative(ctx.root, file)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
            }
          }
        } catch {
          /* 二进制/不可读跳过 */
        }
      }
      if (!hits.length) return `未找到匹配 "${args.pattern}"`;
      return `找到 ${hits.length} 处：\n${hits.join("\n")}`;
    },
  },

  // ── v6.0（S5）符号级代码索引：类/函数/接口/类型/枚举/变量 语义级定位 ──
  code_symbols: {
    name: "code_symbols",
    description:
      "在项目内按符号（声明）搜索代码：类/函数/接口/类型/枚举/模块/变量。返回 file:行号:签名。\n" +
      "与 search_code 的区别：这是语义级声明识别（TS 语法解析，排除注释/字符串/同名变量噪声），\n" +
      "search_code 是正则文本匹配。何时用：想找「哪里定义了 X / 谁导出了 Y / 有没有叫 foo 的接口」；\n" +
      "不确定关键词时用 search_code 或 semantic_search。首次调用需构建索引（秒级），refresh=true 强制重建。",
    risk: "low",
    schema: z.object({
      query: z.string().describe("符号名（子串匹配；大小写不敏感）"),
      kind: z.enum(["class", "function", "interface", "type", "enum", "variable", "module"]).optional().describe("限定符号类型"),
      max: z.number().int().min(1).max(50).optional().describe("最大结果数（默认 20）"),
      refresh: z.boolean().optional().describe("强制重建符号索引（代码改动后结果陈旧时用）"),
    }),
    async execute(args, ctx) {
      const hits = searchSymbols(
        ctx.root,
        args.query as string,
        args.kind as SymbolKind | undefined,
        (args.max as number | undefined) || 20,
        args.refresh === true
      );
      if (!hits.length) {
        const kindNote = args.kind ? `（类型 ${args.kind}）` : "";
        return `未找到符号 "${args.query}"${kindNote}。提示：符号索引在首次调用/refresh 时构建；若刚改过代码可用 refresh=true 重建；想按文本搜用 search_code。`;
      }
      const lines = hits.map(
        (s) => `${s.file}:${s.line} ${s.exported ? "export " : ""}${s.signature}${s.members != null ? `  [成员 ${s.members}]` : ""}`
      );
      return `找到 ${hits.length} 个符号：\n${lines.join("\n")}`;
    },
  },

  list_directory: {
    name: "list_directory",
    description: "列出目录内容（不递归）。显示文件/目录/大小。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的目录（默认项目根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      if (!isPathInside(ctx.root, abs)) return "错误：路径越界";
      const scopeErr = checkPathScope(rel, ctx.scopeRules);
      if (scopeErr) return `错误：路径超出作用域——${scopeErr}（项目指令「路径作用域」节）`;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `错误：目录不存在 ${rel}`;
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const lines = entries.map((e) => {
        const full = path.join(abs, e.name);
        if (e.isDirectory()) return `[dir]  ${e.name}/`;
        if (e.isFile()) {
          const size = fs.statSync(full).size;
          return `[file] ${e.name}  (${size} B)`;
        }
        return `[link] ${e.name}`;
      });
      return `目录 ${rel || "/"}（${entries.length} 项）：\n${lines.join("\n")}`;
    },
  },

  run_command: {
    name: "run_command",
    description:
      "在项目内执行 shell 命令（终端执行）。可运行构建、安装依赖、启动服务、查看环境等。高风险命令（删除/强制操作）需确认。需要网络（如 npm install）时设 network=true，须人工审批放行（默认断网执行；full 档全权放行与用户开启的「临时联网」下外传命令直接放行，命令审计照常）。background=true 时后台运行（立即返回 job id 不阻塞，job_list/job_output/job_kill 管理，任务结束时自动终止）。persistent=true 时用持久 shell 会话执行（跨调用保留 cwd/env，如 cd 后下一轮命令仍在同一目录；⚠ 持久会话脱离沙箱）。",
    risk: "medium",
    schema: z.object({
      command: z.string().describe("要执行的命令"),
      timeout: z.number().int().min(1000).max(300000).optional().describe("超时毫秒（默认 60000）"),
      network: z.boolean().optional().describe("是否允许联网（默认 false=断网执行；true 需人工审批，自动批准模式不适用）"),
      background: z.boolean().optional().describe("后台运行（默认 false=等待完成；true 立即返回 job id，用 job_list/job_output/job_kill 管理）"),
      persistent: z.boolean().optional().describe("持久 shell 会话执行（默认 false=一次性进程；true 复用常驻 shell——跨调用保留 cwd/env，如 cd 后继续、export 环境变量。⚠ 持久会话脱离沙箱（进程已起无法施加受限令牌），断网策略/审批照常生效"),
    }),
    async execute(args, ctx) {
      const command = args.command as string;
      const wantNetwork = args.network === true;
      // 断网策略（M6 软控制）：外传命令必须 network=true 且审批放行，否则拦截（默认断网语义）
      const egress = detectEgress(command);
      if (egress && !wantNetwork) {
        // v5.1：full 档（最大审批权限）同样放行——v3.9 只放行了 network=true 路径，
        // 未显式请求联网的 egress 命令仍被断网策略拦截（full 档下模型需多一轮
        // network=true 重试，与「全自主零弹窗」语义不符）；run_test 早已同款放行。
        // 审计照常（egress-allowed-full 标记），数据安全硬闸（受保护路径/SSRF 等）不受影响
        if (currentApprovalPolicy().mode === "full") {
          auditCommand(ctx.root, command, true, "full 档全自主：断网策略放行", "egress-allowed-full");
        } else if (isEgressAllowed(ctx.sessionId ?? "")) {
          // v5.0（C1）：会话级临时联网开关——用户开启后本会话 egress 命令直接放行
          // （审计标记 egress-allowed-temp），到期自动失效
          auditCommand(ctx.root, command, true, "会话级临时联网放行", "egress-allowed-temp");
        } else {
          const msg = egressBlockedMessage(egress);
          auditCommand(ctx.root, command, false, msg, "egress-blocked");
          return `${msg}\n（受限沙箱·断网策略）`;
        }
      }

      let netAllowed = false;
      if (wantNetwork) {
        // 联网必须人工审批（🌐 标记 + requireExplicit：-y 自动批准也不放行；白名单不豁免联网）
        netAllowed = await guard(ctx, "run_command", "high", `🌐 联网放行执行命令（cwd ${ctx.root}）：${command}`, true);
        if (!netAllowed && egress) {
          // v3.9（2026-08-18 用户拍板「最大审批权限」）：full 档断网策略放行——
          // 命令可联网执行，审计照常落库（egress-allowed-full 标记）
          if (currentApprovalPolicy().mode === "full") {
            netAllowed = true;
            auditCommand(ctx.root, command, true, "full 档全自主：断网策略放行", "egress-allowed-full");
          } else {
            // 外传命令未获联网放行 → 断网策略拦截（不执行）
            const msg = egressBlockedMessage(egress);
            auditCommand(ctx.root, command, false, msg, "egress-blocked");
            return `${msg}\n⚠ 联网审批被拒绝（断网策略）`;
          }
        }
      } else {
        // 常规审批（高危命令 high；其余 medium）；命令白名单（v2.4 设置）——
        // v2.10 批 7 对齐主流（主流 allowedCommands）：白名单命中的命令**完全放行不弹窗**
        // （仅联网放行仍人工——外传数据红线不豁免）
        const policy = currentApprovalPolicy();
        // 末尾无 \b：dd if=/…、mkfs.ext4 后随符号（/ .）处无词边界，加 \b 会漏检
        // v2.13：白名单放行的前提 = 单条只读命令——含 shell 组合符（& ; | > < ` $()）
        // 时退回正常审批（"git status & rm -rf x" 命中 git status* 但实际执行 rm）
        // v3.4 审计修复（H3）：白名单命中仍必须过 DANGEROUS——高危命令永不豁免
        // （原实现注释明示「高危检测也被豁免」= `git status & rm -rf` 全模式免审批）
        if (
          isCommandAllowed(command, policy.commandAllowlist) &&
          !hasShellCombinators(command) &&
          !isDangerousCommand(command)
        ) {
          /* 白名单命令：信任放行（组合符/高危均已排除，单条只读命令） */
        } else if (isDangerousCommand(command)) {
          // v3.1 审计修复：高危命令升级为 requireExplicit——CLI -y / 定时任务无人值守
          // 一律拒绝（此前无人值守自动放行 rm -rf 等，与「安全红线绝不自动放行」矛盾）
          // v3.9（CWE-451 轻量）：审批描述带真实 cwd，防「命令在此目录执行」歧义
          if (!(await guard(ctx, "run_command", "high", `执行高风险命令（cwd ${ctx.root}）：${command}`, true))) {
            return "用户拒绝：高危命令未执行";
          }
        } else if (!(await guard(ctx, "run_command", "medium", `执行命令（cwd ${ctx.root}）：${command}`))) {
          return "用户拒绝：命令未执行";
        }
      }
      const timeoutMs = (args.timeout as number | undefined) || 60000;
      // 联网提示（在 background 分支与同步返回中共用）
      const netNote = wantNetwork && !netAllowed ? "\n⚠ 该命令未获联网放行（断网执行）" : "";
      const netTag = netAllowed ? "（联网放行）" : "";

      // v3.0 批 11 持久 shell：复用常驻会话（保留 cwd/env）；审批/断网门禁已通过
      if (args.persistent === true) {
        const sid = ctx.sessionId ?? "default";
        try {
          const out = await execPersistent(sid, ctx.root, command, timeoutMs);
          // v3.1 审计修复：补命令审计（原实现提前 return 绕过 auditCommand——持久分支
          // 与 background/同步分支同为命令执行，必须进 commands.log）
          auditCommand(ctx.root, command, true, out.slice(0, 120), "persistent-shell");
          return `（持久 shell 会话执行）
` + (out.trim() || "（无输出）") + netNote + netTag;
        } catch (e) {
          auditCommand(ctx.root, command, false, (e as Error).message.slice(0, 120), "persistent-shell");
          return `持久 shell 执行失败：${(e as Error).message}`;
        }
      }

      // v2.11 后台模式：启动后立即返回（不阻塞 Agent 循环）；审批/断网门禁已通过，与同步同安全语义
      if (args.background === true) {
        let job;
        try {
          // v3.3：透传 enqueueTaskNotification——job 完成时入队父循环（模型收到 <task-notification> 通知）
          job = startBackgroundJob(command, ctx.root, ctx.sessionId, ctx.delegationDepth ?? 0, ctx.emit, ctx.enqueueTaskNotification);
        } catch (e) {
          return `错误：${(e as Error).message}`;
        }
        auditJobStart(ctx.root, command, job.id);
        return (
          `已后台启动任务 ${job.id}（不阻塞，可继续其他工作）：\n${command}` +
          `\n\n管理：job_list 查看状态 / job_output(job_id) 看输出 / job_kill(job_id) 终止。` +
          `\n任务完成时你会收到 <task-notification> 通知消息（含状态与输出尾部）。` +
          netNote + netTag
        );
      }

      // 沙箱统一分派（docker / 受限沙箱 / 软沙箱）；signal 中止时 kill 命令；
      // v2.14 批 18：子智能体 agent 文件 sandbox 字段覆盖档位
      const r = await execLocal(command, ctx.root, timeoutMs, ctx.abortSignal, ctx.sandboxMode);

      // v2.10 输出落盘：输出 > 8K 时完整写入 .infu/outputs/*.log，
      // 回填 head 4K + 路径提示 + tail 1K（模型可用 read_file 看完整输出；事件/落库仍完整）
      const outText = r.out;
      // v3.4 审计修复：落盘前凭据检测——命令输出含密钥/令牌/私钥时直接写入项目
      // .infu/outputs/*.log 等于把凭据落盘（read_file 可再读到、会话事件也全文存储）。
      // 命中则不入盘：只回填裁剪版 + 警告（模型可据此调整命令，比如只输出变量名）。
      // v4.0 审计修复：凭据模式补常见令牌前缀——GitHub PAT（ghp_）、Slack（xoxb-）、
      // Google API（AIza）、Google OAuth（ya29.）、JWT（eyJ…）此前漏检，命中时输出
      // >8K 会带凭据落盘项目 .infu/outputs/*.log
      if (outText.length > 8000 && !containsSensitiveOutput(outText)) {
        try {
          const outDir = join(ctx.root, ".infu", "outputs");
          fs.mkdirSync(outDir, { recursive: true });
          // v3.5 数据生命周期：文件名带会话前缀（会话删除时联动清理该会话的 outputs）
          const sid = (ctx.sessionId ?? "cli").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8);
          const outFile = join(outDir, `${sid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.log`);
          fs.writeFileSync(outFile, outText, "utf-8");
          const head = outText.slice(0, 4096);
          const tail = outText.slice(-1024);
          return (
            `${head}\n[... 命令输出过长（共 ${outText.length} 字符），完整输出已保存到 ${outFile}——需要时用 read_file 查看 …]\n${tail}` +
            netNote +
            (r.ok ? `\n${sandboxTag(r.sandbox)}${netTag}执行完成` : `\n${sandboxTag(r.sandbox)}${netTag}`)
          );
        } catch {
          /* 落盘失败回退原输出（trimToolResult 仍会裁剪回填副本） */
        }
      }

      // 命令审计（所有模式，含沙箱档位）
      auditCommand(ctx.root, command, r.ok, r.out, r.sandbox);
      return r.out + netNote + (r.ok ? `\n${sandboxTag(r.sandbox)}${netTag}执行完成` : `\n${sandboxTag(r.sandbox)}${netTag}`);
    },
  },

  // ── v2.3 MCP 自注册（主流 config-hook 模式 → 受控工具 + 人工审批）──
  // 只允许追加 mcpServers 节（models/providers/roles/apiKey 不可达）；high + requireExplicit
  // 审批（-y 也不放行）；仅 Executor/直接模式注入（Planner/Reviewer 只读白名单不含）
  mcp_register: {
    name: "mcp_register",
    description:
      "注册一个 MCP 服务器到 InFu 全局配置（~/.infu/config.json 的 mcpServers 节，需人工审批）。" +
      "注册后下一任务执行阶段自动注入该服务器的工具（默认 medium 审批，可用 riskOverrides 覆盖）。" +
      "用途：给 InFu 自己扩展工具生态——按官方文档实现并自测一个 MCP server 后，用它注册启用。",
    risk: "high",
    schema: z.object({
      name: z.string().describe("服务器显示名称（如 filesystem；id 由其自动生成）"),
      type: z.enum(["stdio", "http"]).optional().describe("传输类型：stdio=本地命令；http=远程端点（默认 stdio）"),
      command: z.string().optional().describe("stdio 模式启动命令（Windows 下 npx 需写 npx.cmd）"),
      args: z.array(z.string()).optional().describe("stdio 模式命令参数"),
      url: z.string().optional().describe("http 模式端点 URL"),
      riskOverrides: z
        .record(z.string(), z.enum(["low", "medium", "high"]))
        .optional()
        .describe("风险覆盖：工具名或前缀* → 级别；未覆盖的工具默认 medium 审批"),
    }),
    async execute(args, ctx) {
      // 写配置 = 持久化副作用 + 影响后续任务工具面：high 级 + requireExplicit（-y 也不放行）
      const desc = `注册 MCP 服务器「${args.name}」（${(args.type as string) ?? "stdio"}）到全局配置：\n${JSON.stringify(args, null, 2)}`;
      if (!(await guard(ctx, "mcp_register", "high", desc, true))) {
        return "用户拒绝：未注册（MCP 服务器注册需人工确认）";
      }
      const r = await registerMcpServer(args as unknown as RegisterInput);
      return r.ok ? r.message : `错误：${r.message}`;
    },
  },

  // ── v2.3 批 2 插件自注册（与 mcp_register 同模式：high + requireExplicit + 白名单写 plugins 节）──
  plugin_add: {
    name: "plugin_add",
    description:
      "注册一个 JS/TS 插件到 InFu 全局配置（~/.infu/config.json 的 plugins 节，需人工审批）。" +
      "插件 = 可注册 工具/钩子（preToolUse/postToolUse）/技能目录 的模块（默认导出 {id, name, description, tools?, hooks?, skills?}）。" +
      "注册后下一任务执行阶段自动加载其工具与钩子。用途：给 InFu 自己扩展能力（注意插件代码在 Agent 进程内运行，配置即信任）。",
    risk: "high",
    schema: z.object({
      id: z.string().describe("插件标识（如 my-tools；自动规范化）"),
      path: z.string().describe("插件模块的绝对路径（.ts/.mjs/.js，默认导出 PluginDef）"),
    }),
    async execute(args, ctx) {
      const desc = `注册插件「${args.id}」（${args.path}）到全局配置：\n${JSON.stringify(args, null, 2)}`;
      if (!(await guard(ctx, "plugin_add", "high", desc, true))) {
        return "用户拒绝：未注册（插件注册需人工确认）";
      }
      const r = registerPlugin(args as unknown as RegisterPluginInput);
      return r.ok ? r.message : `错误：${r.message}`;
    },
  },

  // ── v2.3 批 2 skill 激活层（SKILL.md 社区标准：描述常驻 system，此处读全文注入）──
  use_skill: {
    name: "use_skill",
    description:
      "读取一个技能（SKILL.md）的完整内容。任务与「可用技能」列表（system 中列出 name+description）匹配时调用本工具，获取该技能的完整工作说明后按其执行。",
    risk: "low",
    schema: z.object({
      name: z.string().describe("技能名（与可用技能列表中的 name 一致）"),
    }),
    async execute(args, ctx) {
      const name = String(args.name ?? "").trim();
      if (!name) return "错误：name 不能为空";
      const skills = listSkills(loadConfig(), ctx.root);
      const meta = skills.find((s) => s.name === name);
      if (!meta) {
        const available = skills.map((s) => s.name).join("、");
        return `错误：未找到技能 "${name}"（可用技能：${available || "无"}）`;
      }
      return readSkillContent(meta);
    },
  },

  git_status: {
    name: "git_status",
    description: "查看 Git 仓库状态（当前分支 + 变更文件）。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      // v3.5 审计修复：目录越界拦截（对齐 git_add/git_log 同款；path 传 ../.. 可跑任意目录）
      if (!isPathInside(ctx.root, abs)) return `错误：路径越界（不允许访问项目根之外）: ${rel}`;
      const r = await runShell("git status --short --branch", abs, 60000, sanitizeEnv(), ctx.abortSignal);
      if (!r.ok) {
        if (/not a git repository/i.test(r.out)) return `该目录不是 Git 仓库：${abs}`;
        return r.out; // 其他错误（目录不存在/找不到 git）直接透出真实原因
      }
      return r.out;
    },
  },

  // ── v2.5 子智能体委派（函数式：独立上下文/并行执行/结果回收；agent 文件化定义见 agent/agents.ts）──
  delegate_task: {
    name: "delegate_task",
    description:
      "委派子智能体执行子任务：以独立上下文运行一个子 Agent（或 tasks 并行多个不同任务，同时跑），完成后回收结果摘要。\n" +
      "调用时机（对齐主流）：\n" +
      "· explore（只读，免审批）：探索/调研/摸清现状——回答需要跨多文件扫描、只需结论不要文件转储时；指定搜索广度（medium/very thorough）\n" +
      "· general-purpose（全工具，写能力需一次授权）：复杂多步任务——深度审计/代码审查/实现功能等需要多步推理执行时\n" +
      "· 单点查找（已知文件/符号/值）直接搜索即可，不要委派\n" +
      "· 团队并行（v6.0 S3）：大型任务拆成互相独立、边界清晰的子任务后用 tasks 数组一次并行委派（最多 6 个）——不同模块改动/独立调研/可并行验证的产出；子任务间不能有共享写冲突，依赖关系必须清晰\n" +
      "· 需要后台跑（不阻塞当前任务、稍后回收结果）时设 background=true：立即返回子智能体 id，用 list_agents 查看状态 / report 回收结果 / send_message 与等待中的子智能体交互 / interrupt_agent 中止\n" +
      "agent 参数可引用内置角色（explore / general-purpose）或 .infu/agents/<name>.md 角色文件；只读委派免审批，写能力委派需一次授权审批。",
    risk: "high",
    schema: delegateTaskSchema,
    async execute(args, ctx) {
      const tasks: SubagentSpec[] = (args.tasks as SubagentSpec[])?.length
        ? (args.tasks as SubagentSpec[])
        : [{
            prompt: args.prompt as string,
            agent: args.agent as string | undefined,
            tools: args.tools as string[] | undefined,
            root: args.root as string | undefined,
            maxSteps: args.maxSteps as number | undefined,
            modelId: args.modelId as string | undefined,
          }];
      try {
        // 校验角色存在（拼错/不存在 → 直接报错，不弹无效审批；模型可据错误自纠）
        for (const t of tasks) {
          if (t.agent && !readAgentFile(t.agent, ctx.root)) {
            const available = listAgents(ctx.root).map((a) => a.name).join("、");
            return `错误：未找到 agent 定义 "${t.agent}"（可用：${available}；写入 .infu/agents/<name>.md 即自动注册）`;
          }
        }
        // v2.5 返工（对齐主流）：只读委派（explore / 只读白名单）免审批——
        // 读文件搜索不该打断；有写能力的委派（默认全工具/白名单含写工具）→ 一次授权审批，
        // 批准后子智能体内部继承授权（requireExplicit 安全红线仍逐条弹）。
        const readOnly = tasks.every((t) => isReadOnlyDelegation(t, ctx.root));
        if (!readOnly) {
          // v3.4 审计修复：写能力委派对齐安全红线档位（联网/自注册同款 requireExplicit）——
          // 原实现 -y 无人值守自动放行，等于绕过审批直接授权子 Agent 写文件/跑命令
          const approved = await ctx.requestApproval(
            tasks.map((t) => describeDelegation(t, ctx.root)).join("\n\n"),
            "high",
            true
          );
          if (!approved) return "用户拒绝：未授权该委派任务";
        }
        const delegationCtx = {
          tools: TOOLS,
          root: ctx.root,
          projectRoot: ctx.projectRoot,
          emit: ctx.emit,
          requestApproval: ctx.requestApproval,
          modelConfig: ctx.modelConfig,
          fallbackModelConfigs: ctx.fallbackModelConfigs,
          thinkingLevel: ctx.thinkingLevel,
          delegationDepth: ctx.delegationDepth,
          abortSignal: ctx.abortSignal,
          parentCallId: ctx.callId,
          readOnly,
          sessionId: ctx.sessionId,
          scopeRules: ctx.scopeRules,
          extraReadDirs: ctx.extraReadDirs,
          // v3.3 异步任务编排：后台子智能体完成通知 → 父循环上下文注入
          enqueueTaskNotification: ctx.enqueueTaskNotification,
        };
        // v2.11 后台模式：立即返回 id（不阻塞父级）；子 Agent 在注册表异步跑完，父级用
        // list_agents/report/send_message/interrupt_agent 管理
        if (args.background === true) {
          // v2.13 修复：后台模式同样受 per-session 上限约束（原实现绕过检查——
          // 父级可无限启动后台子 Agent 耗尽并发模型请求）
          const slots = availableSubagentSlots(ctx.sessionId);
          if (tasks.length > slots) {
            return `错误：该会话子 Agent 已达上限 ${MAX_ACTIVE_SUBAGENTS_PER_SESSION} 个（当前 ${MAX_ACTIVE_SUBAGENTS_PER_SESSION - slots} 个运行中）——请等待现有子任务完成，或减少本次并行任务数（最多再开 ${slots} 个）`;
          }
          const started = tasks.map((t) => startBackgroundSubagent(t, delegationCtx));
          return (
            `已后台启动 ${started.length} 个子智能体（不阻塞，父级可继续其他任务）：\n` +
            started.map((h) => `· ${h.id}（${h.name}）`).join("\n") +
            `\n\n管理：list_agents 查看状态；report(agent_id) 回收结果；send_message(agent_id, message) 回复等待中的子智能体；interrupt_agent(agent_id) 中止。` +
            `\n子智能体完成时你会收到 <task-notification> 通知消息（含状态与摘要）。`
          );
        }
        return await delegateTasks(tasks, delegationCtx);
      } catch (e) {
        return `错误：${(e as Error).message}`;
      }
    },
  },

  // ── v2.11 子智能体控制（后台模式管理；对齐主流 SendMessage 恢复 + Agent View 仪表盘）──
  list_agents: {
    name: "list_agents",
    description:
      "列出当前会话的后台子智能体（delegate_task background=true 启动的）：id/名称/状态（运行中/等待消息/完成/异常）/模型/步数/工具次数/委派任务摘要。用于管理后台子任务。",
    risk: "low",
    schema: z.object({}),
    async execute(_args, ctx) {
      const agents = listBackgroundAgents(ctx.sessionId);
      if (!agents.length) return "当前会话没有后台子智能体（用 delegate_task background=true 启动）";
      const lines = agents.map((a) => {
        const st = a.status === "running" ? "运行中" : a.status === "waiting" ? "等待消息" : a.status === "done" ? "完成" : "异常";
        return `· ${a.id}（${a.name}）[${st}] ${a.model} ${a.steps}步/${a.toolCount}次工具 — ${a.prompt.slice(0, 80)}`;
      });
      return `后台子智能体（${agents.length} 个）：\n${lines.join("\n")}\n\n回收: report(agent_id)；恢复等待: send_message(agent_id, message)；中止: interrupt_agent(agent_id)`;
    },
  },

  report: {
    name: "report",
    description:
      "回收后台子智能体的结果（delegate_task background=true 启动的）。运行中返回进度；等待消息的返回其消息与恢复方式；已完成返回最终摘要。",
    risk: "low",
    schema: z.object({
      agent_id: z.string().describe("子智能体 id（list_agents 查看）"),
    }),
    async execute(args, ctx) {
      return getAgentReport(ctx.sessionId, String(args.agent_id ?? ""));
    },
  },

  send_message: {
    name: "send_message",
    description:
      "给等待中的后台子智能体发送消息并恢复其任务（对齐主流 SendMessage：子智能体用 agent_message 暂停等待父级回复时，用它回复；运行中/已完成的子智能体不能接收）。",
    risk: "low",
    schema: z.object({
      agent_id: z.string().describe("子智能体 id（list_agents 查看）"),
      message: z.string().describe("回复内容（子智能体将把它作为用户消息继续任务）"),
    }),
    async execute(args, ctx) {
      const r = sendMessageToAgent(ctx.sessionId, String(args.agent_id ?? ""), String(args.message ?? ""));
      // 恢复成功 → agent-resumed 事件（前端子 Agent 状态刷新；落库审计）
      if (r.startsWith("消息已发送")) ctx.emit({ type: "agent-resumed", id: String(args.agent_id ?? "") });
      return r;
    },
  },

  interrupt_agent: {
    name: "interrupt_agent",
    description:
      "中止后台子智能体（agent_id 指定一个，或 all=true 全部）——其任务立即停止，进度结果可用 report 查看。",
    risk: "low",
    schema: z.object({
      agent_id: z.string().optional().describe("子智能体 id（list_agents 查看）"),
      all: z.boolean().optional().describe("中止全部后台子智能体（默认 false）"),
    }),
    async execute(args, ctx) {
      if (args.all === true) {
        const all = listBackgroundAgents(ctx.sessionId);
        let n = 0;
        for (const a of all) {
          if (a.status === "running" || a.status === "waiting") {
            interruptBackgroundAgent(ctx.sessionId, a.id);
            n++;
          }
        }
        return n ? `已请求中止 ${n} 个后台子智能体` : "当前没有运行中的后台子智能体";
      }
      const id = String(args.agent_id ?? "");
      if (!id) return "错误：需要 agent_id 或 all=true";
      if (!interruptBackgroundAgent(ctx.sessionId, id)) return `错误：未找到后台子智能体 ${id}（用 list_agents 查看）`;
      return `已请求中止子智能体 ${id}（其任务将立即停止）`;
    },
  },

  // 子智能体内部通道（仅后台子智能体注入 ctx.agentChannel；父级/同步子智能体调用返回错误）
  agent_message: {
    name: "agent_message",
    description:
      "（子智能体内部）向父智能体发送消息并暂停等待回复——需要父级决策/补充信息时使用。父智能体用 send_message 回复后任务继续。",
    risk: "low",
    schema: z.object({
      message: z.string().describe("发给父智能体的消息（问题/进度/需要的信息）"),
    }),
    async execute(args, ctx) {
      if (!ctx.agentChannel) {
        return "错误：agent_message 仅后台子智能体可用（delegate_task background=true 启动）——请自行决策，或在最终结果中说明";
      }
      const reply = await ctx.agentChannel.waitForMessage(String(args.message ?? ""));
      if (reply == null) return "父智能体已中止（任务停止）";
      return `父智能体回复：${reply}`;
    },
  },

  // ── v2.11 后台任务（job）管理（run_command background=true 启动；主流 jobs 同款）──
  job_list: {
    name: "job_list",
    description:
      "列出当前会话的后台任务（run_command background=true 启动的）：id/命令/状态（运行中/完成/失败/已终止）/退出码/已运行时长。",
    risk: "low",
    schema: z.object({}),
    async execute(_args, ctx) {
      const jobs = listJobs(ctx.sessionId);
      if (!jobs.length) return "当前会话没有后台任务（run_command 加 background=true 启动后台任务）";
      const lines = jobs.map((j) => {
        const st = j.status === "running" ? "运行中" : j.status === "done" ? "完成" : j.status === "failed" ? "失败" : "已终止";
        return `· ${j.id} [${st}${j.code != null ? ` code=${j.code}` : ""}] ${Math.round((Date.now() - j.startedAt) / 1000)}s — ${j.command.slice(0, 80)}`;
      });
      return `后台任务（${jobs.length} 个）：\n${lines.join("\n")}\n\n查看输出: job_output(job_id)；终止: job_kill(job_id)`;
    },
  },

  job_output: {
    name: "job_output",
    description:
      "读取后台任务的输出（run_command background=true 启动的；完整缓冲，超长自动截断）。tail 参数可只看末尾。",
    risk: "low",
    schema: z.object({
      job_id: z.string().describe("任务 id（job_list 查看）"),
      tail: z.number().int().min(1).max(100000).optional().describe("只看末尾 N 字符（默认全部缓冲）"),
    }),
    async execute(args, ctx) {
      return getJobOutput(ctx.sessionId, String(args.job_id ?? ""), args.tail as number | undefined);
    },
  },

  job_kill: {
    name: "job_kill",
    description:
      "终止后台任务（run_command background=true 启动的）——强制结束其进程树。",
    risk: "low",
    schema: z.object({
      job_id: z.string().describe("任务 id（job_list 查看）"),
    }),
    async execute(args, ctx) {
      return killJob(ctx.sessionId, String(args.job_id ?? ""));
    },
  },

  // ── v3.3 异步任务编排：阻塞等待。
  //  与 report/job_output（非阻塞查询）互补——需要结果才能继续时才用）──
  wait_task: {
    name: "wait_task",
    description:
      "阻塞等待后台任务完成（delegate_task background=true 的子智能体 / run_command background=true 的 job）。\n" +
      "语义：等待直到任务结束或超时——完成返回最终结果（子智能体=摘要，job=输出尾部+退出码）；超时返回当前进度，由你决定继续等还是先做别的。\n" +
      "何时用：下一步必须依赖该任务结果时。何时不用：任务完成你会收到 <task-notification> 通知消息——不依赖结果时可以先去干别的，收到通知后再 report/job_output 回收。",
    risk: "low",
    schema: z.object({
      task_type: z.enum(["subagent", "job"]).describe("任务类型：subagent=后台子智能体；job=后台命令"),
      task_id: z.string().describe("任务 id（子智能体：delegate_task background 返回的 id；job：run_command background 返回的 job id）"),
      timeout: z.number().int().min(1).max(600).optional().describe("最长等待秒数（默认 120，上限 600）"),
    }),
    async execute(args, ctx) {
      const taskType = args.task_type as "subagent" | "job";
      const taskId = String(args.task_id ?? "");
      const timeoutMs = (Number(args.timeout) || 120) * 1000;
      // v3.3：等待期间向父循环注入通知（若完成于等待中，模型下一步即可看到通知消息）
      const startedAt = Date.now();
      let lastProgress = "";
      for (;;) {
        // v3.4 审计修复：wait_task 不响应中止——用户 stop/父级 abort 时 500ms 轮询会
        // 继续空转直到超时（子 Agent 任务中止后句柄 status 停在 error，job 停在被杀）。
        // 每轮检查 abortSignal，中止立即返回。
        if (ctx.abortSignal?.aborted) return "任务已中止，停止等待。";
        // 子智能体：轮询句柄状态（status 变 done/error 即结束）
        if (taskType === "subagent") {
          const h = getBackgroundAgent(ctx.sessionId, taskId);
          if (!h) return `错误：未找到后台子智能体 ${taskId}（用 list_agents 查看当前会话的子智能体）`;
          if (h.status === "running") {
            lastProgress = `子智能体「${h.name}」（${h.steps} 步 / ${h.toolCount} 次工具）`;
          } else if (h.status === "waiting") {
            return `子智能体「${h.name}」（${taskId}）正在等待父级消息：${h.waiters[h.waiters.length - 1]?.message ?? ""}\n用 send_message 回复它以恢复任务（或 interrupt_agent 中止）`;
          } else {
            const state = h.status === "done" ? "已完成" : "异常结束";
            return `子智能体「${h.name}」（${taskId}）${state}（${h.steps} 步 / ${h.toolCount} 次工具）：\n${h.result ?? "（无结果）"}`;
          }
        } else {
          const j = getJob(ctx.sessionId, taskId);
          if (!j) return `错误：未找到后台任务 ${taskId}（用 job_list 查看当前会话的后台任务）`;
          if (j.status === "running") {
            lastProgress = `任务 ${j.id}（${j.command.slice(0, 80)}）已运行 ${Math.round((Date.now() - j.startedAt) / 1000)}s`;
          } else {
            return `后台任务 ${taskId} 已${j.status === "done" ? "完成" : j.status === "killed" ? "被终止" : "失败"}（退出码 ${j.code}）：\n${(j.out || "(无输出)").slice(-2000)}`;
          }
        }
        if (Date.now() - startedAt >= timeoutMs) {
          return `等待超时（${Math.round(timeoutMs / 1000)}s）：${lastProgress}，仍在运行。可：① wait_task 继续等待（timeout 加大）；② 先做其他工作，任务完成会收到 <task-notification> 通知；③ job_kill/interrupt_agent 中止。`;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    },
  },

  git_diff: {
    name: "git_diff",
    description:
      "查看 Git 改动（diff）。默认带文件统计（--stat）+ 完整 diff；stat=false 只看完整 diff，file 指定后只看该文件的改动。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
      staged: z.boolean().optional().describe("查看暂存区 diff（默认 false 看工作区）"),
      stat: z.boolean().optional().describe("是否附带文件统计（--stat，默认 true）"),
      file: z.string().optional().describe("只看某个文件的改动（相对项目根的路径）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      // v3.5 审计修复：目录越界拦截（对齐 git_add/git_log 同款）
      if (!isPathInside(ctx.root, abs)) return `错误：路径越界（不允许访问项目根之外）: ${rel}`;
      const wantStat = args.stat !== false;
      const file = args.file as string | undefined;
      // v2.13：file 参数命令注入修复——只允许安全字符（防 $`() 反引号在双引号内执行；
      // git_diff 为 low 免审批，必须硬校验而非转义）。
      // v4.0 审计修复：放开反斜杠——cmd.exe 双引号内反斜杠无转义语义（`"src\a.ts"` 字面
      // 安全），原字符类拒绝 `\` 使 Windows 相对路径（src\a.ts）不可用；`"` 仍拒绝
      // （引号逃逸是 cmd 注入面），死代码 `.replace(/"/g, '\\"')` 随之删除
      if (file !== undefined && !/^[^'"`$()&|<>;\n]+$/.test(file)) {
        return "错误：file 参数包含不安全字符（仅允许普通文件名/路径字符）";
      }
      const gitBase = args.staged ? "git diff --staged" : "git diff";
      const fileArg = file ? ` -- "${file}"` : "";
      const cmd = wantStat
        ? `${gitBase} --stat${fileArg} && ${gitBase}${fileArg}`
        : `${gitBase}${fileArg}`;
      const r = await runShell(cmd, abs, 60000, sanitizeEnv(), ctx.abortSignal);
      if (!r.ok) {
        if (/not a git repository/i.test(r.out)) return `该目录不是 Git 仓库：${abs}`;
        return r.out;
      }
      return r.out || "(无改动)";
    },
  },

  run_test: {
    name: "run_test",
    description: "运行项目测试。自动检测测试框架（npm test / pytest / go test 等），或执行指定命令。",
    // v2.10：跑测试降 low（主流自动执行；run_test 内部命令已走沙箱分派）
    risk: "low",
    schema: z.object({
      command: z.string().optional().describe("自定义测试命令（默认自动检测）"),
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      // v3.5 审计修复：目录越界拦截（run_test 是 low 免审批 + 可执行任意测试命令，
      // path 传 ../.. 等于在任意目录跑命令，必须硬校验）
      if (!isPathInside(ctx.root, abs)) return `错误：路径越界（不允许访问项目根之外）: ${rel}`;
      const explicit = args.command as string | undefined;
      let cmd = explicit;
      if (!cmd) {
        if (fs.existsSync(path.join(abs, "package.json"))) {
          // npm test 自动执行 package.json scripts.test，无需额外参数
          cmd = "npm test";
        } else if (fs.existsSync(path.join(abs, "pyproject.toml")) || fs.existsSync(path.join(abs, "requirements.txt"))) cmd = "python -m pytest -q 2>&1 || python -m unittest -v 2>&1";
        else if (fs.existsSync(path.join(abs, "go.mod"))) cmd = "go test ./...";
        else if (fs.existsSync(path.join(abs, "Cargo.toml"))) cmd = "cargo test";
        else return "未检测到测试框架，请用 command 参数指定";
      }
      // v3.1 审计修复：自定义 command 与 run_command 同门槛——高危命令 requireExplicit
      // （无人值守/auto 档不放行）、普通命令 medium（此前 low 免审批 = 任意命令旁路通道；
      // 自动检测出的标准测试命令仍 low 自动执行）
      // v3.9 审计修复（M1）：白名单放行条件与 run_command 完全对齐——命中白名单且
      // 无 shell 组合符且不高危才放行（原实现 `DANGEROUS && !isCommandAllowed` 让
      // `git status && rm -rf x` 命中 git status* 白名单后降 medium → auto 档自动放行）
      if (explicit) {
        const policy = currentApprovalPolicy();
        if (
          isCommandAllowed(explicit, policy.commandAllowlist) &&
          !hasShellCombinators(explicit) &&
          !isDangerousCommand(explicit)
        ) {
          /* 白名单测试命令：信任放行 */
        } else if (isDangerousCommand(explicit)) {
          if (!(await guard(ctx, "run_test", "high", `执行高风险测试命令：${explicit}`, true))) {
            return "用户拒绝：高风险测试命令未执行";
          }
        } else if (!(await guard(ctx, "run_test", "medium", `运行测试：${explicit}`))) {
          return "用户拒绝：未运行测试";
        }
      } else if (!(await guard(ctx, "run_test", "low", `运行测试：${cmd}`))) {
        return "用户拒绝：未运行测试";
      }
      // 断网策略：测试默认断网，外传命令拦截（run_test 无 network 参数，需去掉外传工具或改用 run_command）
      // v3.9：full 档（最大审批权限）放行——审计照常（egress-allowed-full 标记）
      // v5.0（C1）：会话级临时联网开关同效（egress-allowed-temp）
      const egress = detectEgress(cmd);
      if (egress) {
        if (currentApprovalPolicy().mode === "full") {
          auditCommand(abs, cmd, true, "full 档全自主：断网策略放行", "egress-allowed-full");
        } else if (isEgressAllowed(ctx.sessionId ?? "")) {
          auditCommand(abs, cmd, true, "会话级临时联网放行", "egress-allowed-temp");
        } else {
          const msg = egressBlockedMessage(egress);
          auditCommand(abs, cmd, false, msg, "egress-blocked");
          return `${msg}\n（受限沙箱·断网策略）测试未执行`;
        }
      }
      // 测试命令与 run_command 同走沙箱分派（docker / 受限沙箱 / 软沙箱）；signal 中止时 kill；
      // v2.14 批 18：子智能体 agent 文件 sandbox 字段覆盖档位
      const r = await execLocal(cmd, abs, 300000, ctx.abortSignal, ctx.sandboxMode);
      auditCommand(abs, cmd, r.ok, r.out, r.sandbox);
      return r.out + (r.ok ? `\n${sandboxTag(r.sandbox)}执行完成` : `\n${sandboxTag(r.sandbox)}`);
    },
  },

  project_scan: {
    name: "project_scan",
    description: "扫描项目：识别技术栈（语言/框架/包管理器）并列出顶层结构。用于任务开始前的项目理解。",
    risk: "low",
    schema: z.object({
      path: z.string().optional().describe("相对项目根的目录（默认根）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string | undefined) || ".";
      const abs = path.resolve(ctx.root, rel);
      // v4.0 审计修复：补目录越界拦截——原实现无 isPathInside（其余探索工具均有），
      // `project_scan {path:"../../.."}` 可扫描/读取项目外目录的 package.json 等
      if (!isPathInside(ctx.root, abs)) return "错误：路径越界";
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `错误：目录不存在 ${rel}`;

      // 技术栈识别
      const flags: Record<string, string> = {
        "package.json": "Node.js（JS/TS）",
        "pnpm-lock.yaml": "Node.js（pnpm）",
        "yarn.lock": "Node.js（yarn）",
        "requirements.txt": "Python（pip）",
        "pyproject.toml": "Python（Poetry/uv）",
        "go.mod": "Go",
        "Cargo.toml": "Rust（Cargo）",
        "pom.xml": "Java（Maven）",
        "build.gradle": "Java/Groovy（Gradle）",
        "composer.json": "PHP（Composer）",
        "Gemfile": "Ruby",
        "*.csproj": "C#/.NET",
        "Dockerfile": "Docker",
        "docker-compose.yml": "Docker Compose",
        "Makefile": "Make",
      };
      const detected: string[] = [];
      const files = walkFiles(abs, 3000);
      for (const f of files.slice(0, 500)) {
        const base = path.basename(f);
        if (flags[base] && !detected.includes(flags[base])) detected.push(flags[base]);
        else if (base.endsWith(".csproj") && !detected.includes(flags["*.csproj"])) detected.push(flags["*.csproj"]);
      }

      // 框架识别（package.json 依赖；v2.10 扩充常见框架/构建工具）
      let framework = "";
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(abs, "package.json"), "utf-8"));
        const deps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
        if (deps.react) framework = "React";
        else if (deps.vue) framework = "Vue";
        else if (deps.angular || deps["@angular/core"]) framework = "Angular";
        else if (deps.svelte) framework = "Svelte";
        if (deps.next) framework += " + Next.js";
        else if (deps.nuxt || deps["nuxt3"]) framework += " + Nuxt";
        if (deps.astro) framework += " + Astro";
        if (deps.tauri) framework += " + Tauri（桌面）";
        if (deps.electron) framework += " + Electron（桌面）";
        if (deps["@nestjs/core"]) framework += " + NestJS";
        if (deps.express) framework += " + Express";
        else if (deps.fastify) framework += " + Fastify";
        if (deps.vite) framework += " + Vite";
        else if (deps.webpack) framework += " + Webpack";
        if (deps["@infu/agent"] || deps.ai) framework += " + AI SDK";
        if (deps.zustand || deps.redux) framework += " + 状态管理";
      } catch { /* 非 Node 项目 */ }

      // v2.10：Python 框架识别（requirements.txt / pyproject.toml 依赖名）
      if (!framework) {
        try {
          const req = fs.readFileSync(path.join(abs, "requirements.txt"), "utf-8").toLowerCase();
          if (req.includes("fastapi")) framework = "FastAPI";
          else if (req.includes("django")) framework = "Django";
          else if (req.includes("flask")) framework = "Flask";
        } catch { /* 无 requirements */ }
        try {
          const py = fs.readFileSync(path.join(abs, "pyproject.toml"), "utf-8").toLowerCase();
          if (py.includes("fastapi")) framework = "FastAPI";
          else if (py.includes("django")) framework = "Django";
          else if (py.includes("flask")) framework = "Flask";
        } catch { /* 无 pyproject */ }
      }

      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const tree = entries
        .slice(0, 40)
        .map((e) => (e.isDirectory() ? `  ${e.name}/` : `  ${e.name}`))
        .join("\n");

      const head = [`项目扫描: ${rel || "/"}`, `技术栈: ${detected.join("、") || "未识别"}${framework ? `（${framework}）` : ""}`, `文件数: ${files.length}`].join("\n");
      return head + "\n\n顶层结构:\n" + tree;
    },
  },

  // ── v2.6 记忆系统（渐进式加载：指令常驻 system，记忆按需读 / 稳定知识主动写）──
  memory_read: {
    name: "memory_read",
    description:
      "读取记忆主题文件（渐进式加载）。记忆分两层：项目记忆 .infu/memory/（当前项目约定/教训）与全局记忆 ~/.infu/memory/（跨项目偏好）。" +
      "不传 topic 时列出可用主题。任务开始时如需要了解项目既有约定/踩坑教训，先读相关主题再动手。",
    risk: "low",
    schema: z.object({
      scope: z.enum(["project", "global"]).optional().describe("记忆范围：project=当前项目（默认）；global=跨项目全局"),
      topic: z.string().optional().describe("主题名（conventions 约定 / lessons 教训 / preferences 偏好，或自建主题；省略=列主题列表）"),
    }),
    async execute(args, ctx) {
      const scope = (args.scope as "project" | "global" | undefined) ?? "project";
      const topic = typeof args.topic === "string" ? args.topic : undefined;
      const memoryRoot = ctx.projectRoot ?? ctx.root;
      // v3 自由会话（默认会话根目录只读容器）只能读全局记忆
      if (scope === "project" && isReadOnlySessionRoot(memoryRoot)) {
        return "错误：自由会话只能读取全局记忆（默认会话根目录为只读容器）——请用 scope=global，或先在侧栏选择/创建项目";
      }
      const { text } = readMemory(scope, topic, memoryRoot);
      return clip(text, MAX_OUTPUT);
    },
  },

  memory_write: {
    name: "memory_write",
    description:
      "写入记忆主题文件：把**值得下次任务复用**的稳定知识记录到项目记忆 .infu/memory/ 或全局记忆 ~/.infu/memory/（全局记忆需 medium 审批）。" +
      "用途：项目约定（conventions）/踩坑教训（lessons）/用户偏好（preferences），或自建主题。要求简短准确可复用；不要记录任务过程流水账（系统自动归档历史）；不要重复已有内容。",
    // v2.10 批 5：记忆写入降 low（对齐主流 memory 自动；敏感凭据检测与全局写保护仍在）
    risk: "low",
    schema: z.object({
      scope: z.enum(["project", "global"]).optional().describe("记忆范围：project=当前项目（默认）；global=跨项目全局"),
      topic: z.string().describe("主题名（conventions/lessons/preferences 或自建；只能含字母数字下划线连字符）"),
      content: z.string().describe("要记录的知识内容（append 时作为一条新记录追加；replace 时整体覆盖）"),
      mode: z.enum(["append", "replace"]).optional().describe("写入模式：append=追加一条记录（默认）；replace=整体覆盖主题（需谨慎，默认追加）"),
    }),
    async execute(args, ctx) {
      const scope = (args.scope as "project" | "global" | undefined) ?? "project";
      const topic = String(args.topic ?? "").trim();
      const content = String(args.content ?? "");
      const mode = (args.mode as "append" | "replace" | undefined) ?? "append";
      const memoryRoot = ctx.projectRoot ?? ctx.root;
      // 写保护精确化：全局记忆位于 ~/.infu（受保护）——本工具是唯一合法写入通道；
      // 非法 topic（路径穿越/后缀逃逸）直接拒绝
      const err = validateTopic(topic);
      if (err) return `错误：${err}`;
      // v3 自由会话（默认会话根目录只读容器）不能写项目记忆
      if (scope === "project" && isReadOnlySessionRoot(memoryRoot)) {
        return "错误：自由会话不能写入项目记忆（默认会话根目录为只读容器）——请用 scope=global，或先在侧栏选择/创建项目";
      }
      const desc = `${mode === "replace" ? "覆盖" : "追加到"}${scope === "global" ? "全局" : "项目"}记忆 ${topic}.md：\n${content.slice(0, 200)}`;
      // v2.10 批 5：记忆写入降 low（对齐主流 memory 自动；敏感凭据检测与全局写保护仍在）
      // v4.0 审计修复（M7）：global 作用域 / replace 模式提升 medium——全局记忆会被所有
      // 后续会话读取（prompt 注入可借 low 免审批把恶意指令持久驻留跨会话），replace 可
      // 覆盖用户长期建立的约定。项目 append 保持 low（项目内正常沉淀，主流同款）
      const memRisk: RiskLevel = scope === "global" || mode === "replace" ? "medium" : "low";
      if (!(await guard(ctx, "memory_write", memRisk, desc))) return "用户拒绝：未写入";
      const r = writeMemory(scope, topic, content, mode, memoryRoot);
      return r.ok ? r.message : `错误：${r.message}`;
    },
  },

  // ── v2.6 收尾新增：联网 / Git 提交链 / 任务协作（主流 coding agent 标配）──
  ...webTools,
  ...gitTools,
  ...taskTools,
  // ── v3.0 批 11 LSP 语义诊断（tsserver：类型错误/未使用变量等，远超正则）──
  lsp_diagnostics: {
    name: "lsp_diagnostics",
    description:
      "对单个 TS/JS 文件做语义级类型诊断（TypeScript tsserver 驱动——类型错误、未使用变量、隐式 any 等）。何时用：怀疑类型问题、编译报错定位、代码审查时。比 run_test 快（只查单文件不编译整个项目）；node_modules/typescript 缺失时自动返回不可用。",
    risk: "low",
    schema: z.object({
      path: z.string().describe("相对项目根的 TS/JS 文件路径（如 src/agent/loop.ts）"),
    }),
    async execute(args, ctx) {
      const rel = (args.path as string) || "";
      if (!rel.trim()) return "错误：path 必填";
      const r = await lspDiagnose(ctx.root, rel);
      return r.message;
    },
  },

  // ── v6.0（P3）LSP 跳转定义 / 查找引用 / 补全（tsserver 语义级；诊断的互补能力）──
  lsp_definition: {
    name: "lsp_definition",
    description:
      "跳到符号定义处（TypeScript 语义级，tsserver 驱动）：给定文件 + 行号（1-based）+ 列号，返回定义位置（相对路径:行:列 + 上下文行）。何时用：想找某符号「在哪定义」、阅读引用链、code_symbols 命中后深挖。对内置/三方包符号会提示项目外不展示。",
    risk: "low",
    schema: z.object({
      file: z.string().describe("相对项目根的 TS/JS 文件路径（如 src/agent/loop.ts）"),
      line: z.number().int().min(1).describe("光标所在行（1-based）"),
      offset: z.number().int().min(1).optional().describe("光标所在列（1-based，默认 1）"),
    }),
    async execute(args, ctx) {
      const r = await lspGotoDefinition(ctx.root, (args.file as string) || "", args.line as number, (args.offset as number | undefined) ?? 1);
      return r.message;
    },
  },
  lsp_references: {
    name: "lsp_references",
    description:
      "查找符号的全部引用位置（TypeScript 语义级）：给定文件 + 行 + 列，返回项目内引用列表（相对路径:行:列，含声明本身）。何时用：改接口/函数前评估影响面、找调用方。项目外（三方包）引用只计数不展示。",
    risk: "low",
    schema: z.object({
      file: z.string().describe("相对项目根的 TS/JS 文件路径"),
      line: z.number().int().min(1).describe("光标所在行（1-based）"),
      offset: z.number().int().min(1).optional().describe("光标所在列（1-based，默认 1）"),
    }),
    async execute(args, ctx) {
      const r = await lspFindReferences(ctx.root, (args.file as string) || "", args.line as number, (args.offset as number | undefined) ?? 1);
      return r.message;
    },
  },
  lsp_completion: {
    name: "lsp_completion",
    description:
      "获取某位置的补全候选（TypeScript 语义级）：给定文件 + 行 + 列，返回候选名称 + 类型（类/函数/变量/关键字等）。何时用：不确定某位置可用 API、想确认导入名/成员名、审查补全体验。候选按 tsserver 排序截前 40 个，过滤内部与废弃符号。",
    risk: "low",
    schema: z.object({
      file: z.string().describe("相对项目根的 TS/JS 文件路径"),
      line: z.number().int().min(1).describe("光标所在行（1-based）"),
      offset: z.number().int().min(1).optional().describe("光标所在列（1-based，默认 1）"),
    }),
    async execute(args, ctx) {
      const r = await lspCompletions(ctx.root, (args.file as string) || "", args.line as number, (args.offset as number | undefined) ?? 1);
      return r.message;
    },
  },

  // ── v3.0 批 11 语义检索（BM25 + 中文分词；零依赖本地相关度排序）──
  semantic_search: {
    name: "semantic_search",
    description:
      "语义检索：按相关性在项目内搜索文本（BM25 相关度排序，支持中文——关键词不精确命中也能按相关度找到）。何时用：想找「做某事的代码/配置」但不确定关键词、或 search_code 正则找不到时。比 search_code 慢（全量扫描打分），优先用 search_code 精确匹配。",
    risk: "low",
    schema: z.object({
      query: z.string().describe("自然语言查询（如 权限审批是怎么实现的）"),
      max_results: z.number().int().min(1).max(30).optional().describe("最大结果数（默认 10）"),
    }),
    async execute(args, ctx) {
      const q = (args.query as string) || "";
      if (!q.trim()) return "错误：query 必填";
      const max = (args.max_results as number | undefined) || 10;
      const idx = loadIndex(ctx.root);
      const files = (idx
        ? idx.files.map((f) => path.resolve(ctx.root, f.file))
        : walkFiles(ctx.root)
      ).filter((f) => !isProtectedPath(f));
      const hits = semanticSearch(q, files, ctx.root, max);
      if (!hits.length) return `未找到与 "${q}" 相关的内容`;
      return `找到 ${hits.length} 处相关：\n` + hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
    },
  },

  // ── v2.12 新增：历史会话查询（Agent 复盘/复用；只读）──
  ...sessionTools,
  // ── v3.0 vision 底座：read_image（读图注入视觉）+ screen_*（computer-use 桌面操作）──
  ...visionTools,
  // ── v3.1 工具补齐：project_tree（目录树）/ file_ops（mv/cp/rm/mkdir）──
  ...fsTools,
  // ── v3.1 工具补齐：os_info / current_time（环境与时间，只读）──
  ...envTools,

};

export function getToolNames(): string[] {
  return Object.keys(TOOLS);
}

/** 只读工具子集（Planner 规划 / Reviewer 审查专用——写工具不进循环 = 架构级只读保证；
 *  v2.3 批 2：use_skill 只读（读 SKILL.md 全文）→ 进白名单） */
export function getReadOnlyTools(): Record<string, ToolDef> {
  return {
    read_file: TOOLS.read_file,
    search_code: TOOLS.search_code,
    list_directory: TOOLS.list_directory,
    project_scan: TOOLS.project_scan,
    git_status: TOOLS.git_status,
    git_diff: TOOLS.git_diff,
    git_log: TOOLS.git_log,
    read_files: TOOLS.read_files,
    use_skill: TOOLS.use_skill,
    // v2.10：glob 按模式找路径（与 search_code 内容搜索互补；只读）
    glob: TOOLS.glob,
    // v2.6：memory_read 只读（渐进式记忆加载）→ 进 Planner/Reviewer 白名单；memory_write 不注入
    memory_read: TOOLS.memory_read,
    // v2.11：子智能体/后台任务管理只读工具（查状态/回收结果）
    list_agents: TOOLS.list_agents,
    report: TOOLS.report,
    job_list: TOOLS.job_list,
    job_output: TOOLS.job_output,
    // v2.12：历史会话查询（只读）
    session_search: TOOLS.session_search,
    session_trace: TOOLS.session_trace,
    // v3.0 批 11：语义检索 / LSP 诊断只读 → 进白名单
    semantic_search: TOOLS.semantic_search,
    lsp_diagnostics: TOOLS.lsp_diagnostics,
    // v3.1：目录树 / 环境 / 时间（只读探索）
    project_tree: TOOLS.project_tree,
    os_info: TOOLS.os_info,
    current_time: TOOLS.current_time,
    // v6.0（S5）：符号级代码索引（只读语义检索——声明定位比正则更精准）
    code_symbols: TOOLS.code_symbols,
    // v6.0（P3）：LSP 跳转定义 / 查找引用 / 补全（tsserver 语义级，只读）
    lsp_definition: TOOLS.lsp_definition,
    lsp_references: TOOLS.lsp_references,
    lsp_completion: TOOLS.lsp_completion,
    // v6.0（B5）：OCR 图片文字识别（Windows 自带引擎，只读）
    ocr_image: TOOLS.ocr_image,
  };
}

/** Reviewer 工具集 = 只读 + run_test（审查时可验证测试结果，但无任何写能力） */
export function getReviewerTools(): Record<string, ToolDef> {
  return {
    ...getReadOnlyTools(),
    // v3.0 审计修复（S2）：Reviewer 版 run_test 禁止自定义 command——
    // 否则"只读审查"可通过 run_test {command:"rm -rf ..."} 无审批执行任意命令。
    // ToolDef.schema 类型为 ZodType，构建期断言为 ZodObject 以使用 extend（保持原 schema 元信息）
    run_test: {
      ...TOOLS.run_test,
      schema: (TOOLS.run_test.schema as z.ZodObject<any>).extend({
        command: z.string().optional().describe("自定义测试命令（Reviewer 阶段不可用，仅自动检测框架）"),
      }),
      async execute(args, ctx) {
        if (args.command) {
          return "错误：审查阶段不允许自定义测试命令（仅可自动检测框架运行测试）。如需执行任意命令请改用 Executor 阶段。";
        }
        return (TOOLS.run_test.execute as (a: unknown, c: unknown) => Promise<string>)(args, ctx);
      },
    },
  };
}
