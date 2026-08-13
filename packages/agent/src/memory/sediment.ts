/**
 * v2.6 会话自动沉淀（L4 项目历史）— 零额外模型调用
 *
 * 每次会话结束（交付报告生成后）把报告原文 + 结构化元数据归档到
 * <root>/.infu/history/YYYY-MM-DD.md（按日期归档，一天多会话追加条目）。
 *
 * 定位（用户拍板 + 主流对齐：Claude Auto Memory 会话中主动写 / Codex 会话后后台
 * 提炼的即时简化版）：本模块做「发生过的」事实归档（只增不改）；
 * 「下次该怎么干的」稳定知识由 Agent 中途经 memory_write 记录（system 已注入引导），
 * 两路配合 = 记忆四层（规则 INFU.md / 全局 / 项目 / 历史）+ 会话历史。
 */

import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "../agent/loop.js";

export interface SedimentInput {
  /** 项目根目录 */
  root: string;
  /** 用户指令（条目标题来源） */
  prompt: string;
  /** 执行结果（RunResult：text/steps/toolCount/approvals/toolLogs） */
  result: Pick<RunResult, "text" | "steps" | "toolCount" | "approvals" | "toolLogs">;
  /** 交付报告全文（buildReport 输出；直接归档不加工） */
  report: string;
  /** 审查意见（可选） */
  reviewText?: string;
  /** 模型标签（展示用；如 provider/model） */
  modelLabel?: string;
}

/** 从工具日志提取「文件改动/命令/测试/记忆」概览行（写类与验证类工具的 summary） */
function buildChangesOverview(toolLogs: RunResult["toolLogs"]): string[] {
  const KEY = new Set(["write_file", "edit_file", "run_test", "run_command", "memory_write", "delegate_task"]);
  const lines: string[] = [];
  for (const l of toolLogs) {
    if (!KEY.has(l.tool)) continue;
    const s = l.summary.split("\n")[0].trim().slice(0, 160);
    if (!s) continue;
    lines.push(`- [${l.ok ? "✓" : "✗"}] ${l.tool}: ${s}`);
  }
  return lines.slice(0, 40); // 防爆：最多 40 行
}

/** 安全标题（会话标题用；去换行/控制字符） */
function cleanTitle(prompt: string): string {
  return prompt.replace(/[\r\n\t]+/g, " ").trim().slice(0, 60) || "（无标题任务）";
}

/**
 * 会话沉淀：追加一条历史条目到 <root>/.infu/history/YYYY-MM-DD.md。
 * 幂等不做去重——同一会话多次调用（理论不会）会产生多条，可接受。
 * 返回归档路径与条目摘要（供 memory-sediment 事件落库审计）。
 */
export function sedimentTask(input: SedimentInput): { path: string; entry: string } {
  const { root, prompt, result, report, reviewText, modelLabel } = input;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);
  const historyDir = path.join(root, ".infu", "history");
  fs.mkdirSync(historyDir, { recursive: true });
  const file = path.join(historyDir, `${dateStr}.md`);

  const a = result.approvals;
  const meta = [
    `- 时间：${dateStr} ${timeStr}`,
    modelLabel ? `- 模型：${modelLabel}` : null,
    `- 执行：${result.steps} 步 · ${result.toolCount} 次工具调用 · 审批 ${a.approved}/${a.required} 通过${a.denied ? `（拒绝 ${a.denied}）` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");

  const changes = buildChangesOverview(result.toolLogs);
  const changesBlock = changes.length ? `\n${changes.join("\n")}\n` : "\n（无写类/验证类工具记录）\n";

  const entry =
    `## ${dateStr} ${timeStr} ｜ ${cleanTitle(prompt)}\n\n` +
    meta +
    `\n\n**文件改动 / 验证概览**：${changesBlock}\n` +
    `**执行摘要**：\n${(result.text || "（无摘要）").slice(0, 2000)}\n\n` +
    `**交付报告**：\n${report}\n` +
    (reviewText ? `\n**审查意见**：\n${reviewText}\n` : "");

  fs.appendFileSync(file, entry + "\n\n---\n\n", "utf-8");
  return { path: file, entry: `归档到 ${path.relative(root, file)}（${dateStr} ${timeStr} ｜ ${cleanTitle(prompt)}）` };
}
