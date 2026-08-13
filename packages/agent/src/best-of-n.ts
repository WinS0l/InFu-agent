/**
 * /best-of-n 并行尝试（借鉴 Cursor）— CLI 版
 *
 * 同一任务在 N 个独立 worktree（每任务独立分支）并行运行完整编排
 * （Planner→Executor→Reviewer），完成后按评分择优，输出对比表。
 * 任务后 worktree 保留，由用户手动 merge / discard（与现有 worktree 语义一致）。
 *
 * 成本提示：N 倍 token 消耗。计划确认在并行模式下自动关闭。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { AgentEvent } from "@infu/shared";
import { runOrchestratedTask, type OrchestratedRunOptions, type OrchestratedResult } from "./agent/orchestrator.js";

const execFileAsync = promisify(execFile);

export interface BestOfNOptions {
  /** 并行路数（默认 3） */
  n: number;
  modelConfig: OrchestratedRunOptions["modelConfig"];
  /** v2.2 降级链（备用模型，各 worktree 共享） */
  fallbackModelConfigs?: OrchestratedRunOptions["fallbackModelConfigs"];
  prompt: string;
  root: string;
  emit: (e: AgentEvent) => void;
  requestApproval: OrchestratedRunOptions["requestApproval"];
  maxSteps?: number;
  /** 所有路共享的中止信号（SIGINT 全停） */
  abortSignal?: AbortSignal;
}

export interface BestOfNTrial {
  /** 1-based */
  index: number;
  /** worktree 分支名（= 目录名） */
  name: string;
  /** worktree 绝对路径 */
  path: string;
  score: number;
  testPassed: boolean;
  toolSuccess: number;
  steps: number;
  /** 任务最终输出（摘要） */
  summary: string;
}

export interface BestOfNResult {
  trials: BestOfNTrial[];
  best: BestOfNTrial;
  baseRoot: string;
}

async function createWorktree(root: string, name: string): Promise<string> {
  const wtPath = path.join(root, ".infu-worktrees", name);
  await execFileAsync("git", ["worktree", "add", wtPath, "-b", name], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  });
  return wtPath;
}

/** 评分（可解释、可复现）：测试 ×40 + 工具成功率 ×25 + 报告完整度 ×20 + 步骤效率 ×15 */
function scoreTrial(r: OrchestratedResult): { testPassed: boolean; toolSuccess: number; score: number } {
  const tests = r.toolLogs.filter((t) => t.tool === "run_test");
  const testPassed = !!tests[tests.length - 1]?.ok; // 最近一次测试运行通过
  const total = r.toolLogs.length;
  const okTools = r.toolLogs.filter((t) => t.ok).length;
  const toolSuccess = total ? okTools / total : 0;
  const reportLen = (r.report ?? "").length;
  const score = Math.round(
    (testPassed ? 40 : 0) +
      toolSuccess * 25 +
      Math.min(1, reportLen / 300) * 20 +
      Math.max(0, 1 - r.steps / 60) * 15
  );
  return { testPassed, toolSuccess, score };
}

/** 校验 root 是 git 仓库（worktree 前置条件） */
export async function assertGitRepo(root: string): Promise<void> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
    });
  } catch {
    throw new Error(`--best-of-n 需要 Git 仓库（当前 root 不是：${root}）`);
  }
}

export async function runBestOfN(opts: BestOfNOptions): Promise<BestOfNResult> {
  await assertGitRepo(opts.root);

  const stamp = Date.now().toString(36);
  const controller = new AbortController();
  const signal = opts.abortSignal ?? controller.signal;

  const trials: BestOfNTrial[] = await Promise.all(
    Array.from({ length: opts.n }, async (_, i) => {
      const index = i + 1;
      const name = `infu-best-${stamp}-${index}`;
      const wtPath = await createWorktree(opts.root, name);

      const result = await runOrchestratedTask({
        modelConfig: opts.modelConfig,
        fallbackModelConfigs: opts.fallbackModelConfigs,
        prompt: opts.prompt,
        root: wtPath,
        // 并行模式下计划确认关闭（无法逐个交互）；审批仍可逐条询问
        planApproval: false,
        emit: opts.emit,
        requestApproval: opts.requestApproval,
        maxSteps: opts.maxSteps,
        abortSignal: signal,
      });

      const { testPassed, toolSuccess, score } = scoreTrial(result);
      return {
        index,
        name,
        path: wtPath,
        score,
        testPassed,
        toolSuccess,
        steps: result.steps,
        summary: result.text.slice(0, 200),
      };
    })
  );

  // 评分排序（稳定，同分取先完成者）
  const sorted = [...trials].sort((a, b) => b.score - a.score || a.index - b.index);
  return { trials, best: sorted[0], baseRoot: opts.root };
}

/** 对比表渲染（CLI 输出） */
export function formatComparison(r: BestOfNResult): string {
  const lines: string[] = [];
  lines.push(`\n═══ /best-of-n 结果（${r.trials.length} 路并行）═══`);
  for (const t of r.trials) {
    lines.push(
      `  [尝试 ${t.index}] ${t.name}  ${t.testPassed ? "✅测试通过" : "❌测试未过"}  工具成功率 ${Math.round(t.toolSuccess * 100)}%  步骤 ${t.steps}  得分 ${t.score}`
    );
    lines.push(`      ${t.path}`);
  }
  lines.push("");
  lines.push(`★ 最优：尝试 ${r.best.index}（得分 ${r.best.score}）`);
  lines.push(`  合并：  git -C "${r.baseRoot}" merge ${r.best.name}`);
  lines.push(`  丢弃：  git -C "${r.baseRoot}" worktree remove --force ".infu-worktrees/${r.best.name}" && git -C "${r.baseRoot}" branch -D ${r.best.name}`);
  return lines.join("\n");
}
