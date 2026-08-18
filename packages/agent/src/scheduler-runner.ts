/**
 * 定时任务执行器（v3.0 批 11）——无人值守模式
 * 复用 CLI 的任务装配逻辑（模型解析/会话落库/记忆注入），审批 = 全自动
 * （-y 语义：requireExplicit 安全红线一律拒绝）。
 * 独立模块避免循环依赖（server.ts ↔ schedule.ts）。
 */
import { loadConfig, resolveModel, toRuntimeModel } from "./providers/registry.js";
import { makeApprovalHandler } from "./agent/loop.js";
import { runOrchestratedTask } from "./agent/orchestrator.js";
import { getStore } from "./db/store.js";
import { closeShellSession } from "./tools/persistent-shell.js";
import { clearObservedFiles } from "./tools/index.js";
import { clearApprovalMemory, clearSessionBypass } from "./approval/cache.js";
// v3.6：定时任务结束清理 todo 清单 / 插件技能目录（与 server/cli finally 对齐）
import { clearTodos } from "./tools/task-tools.js";
import { clearPluginSkillDirs } from "./plugin/skills.js";
// v3.6 审计修复：定时任务结束清理本会话后台子 Agent/job（此前缺失——
// 定时任务启动的后台任务永久残留至进程退出，持续消耗模型配额）
import { abortBackgroundAgentsByDepth } from "./agent/subagent.js";
import { abortJobsByDepth } from "./tools/jobs.js";
import type { ScheduleEntry } from "./schedule.js";

/** 无人值守审批：等价 CLI -y（low/medium 批准；requireExplicit 拒绝） */
async function unattendedDecide(
  _description: string,
  _risk: "low" | "medium" | "high",
  requireExplicit?: boolean
): Promise<boolean> {
  if (requireExplicit) return false; // 安全红线（联网/自注册等）无人值守绝不放行
  return true;
}

/** 执行定时任务（startScheduler 注入的回调） */
export async function runScheduledTask(entry: ScheduleEntry): Promise<{ ok: boolean; message: string }> {
  const config = loadConfig();
  if (!config) return { ok: false, message: "未配置模型（请先 npm run config）" };
  const modelCfg = resolveModel(config);

  const store = getStore();
  const sessionId = store.createSession({ title: `⏰ ${entry.prompt.slice(0, 30)}`, root: entry.root });
  const emit = (event: import("@infu/shared").AgentEvent) => { store.appendEvent(sessionId, event); };

  try {
    const result = await runOrchestratedTask({
      modelConfig: toRuntimeModel(config, modelCfg),
      prompt: entry.prompt,
      root: entry.root,
      emit,
      sessionId,
      requestApproval: makeApprovalHandler(emit, unattendedDecide),
      orchestrate: false, // 定时任务直接执行（主流式）
      planApproval: false,
    });
    store.updateStatus(sessionId, "done");
    console.log(`[infu-agent] ⏰ 定时任务 ${entry.id} 完成（${result.text.slice(0, 60)}…）`);
    return { ok: true, message: result.text.slice(0, 200) };
  } catch (e) {
    store.updateStatus(sessionId, "error");
    console.log(`[infu-agent] ⏰ 定时任务 ${entry.id} 失败: ${(e as Error).message}`);
    return { ok: false, message: (e as Error).message };
  } finally {
    // v3.0 审计修复（S3）：任务结束关闭持久 shell 会话
    try { closeShellSession(sessionId); } catch { /* 忽略 */ }
    // v3.4 审计修复：补全会话级清理（与服务端任务结束对齐——文件观察/已批准记忆/全权放行
    // 不泄漏到下一次定时执行；服务常驻期间定时任务可能跑很多轮）
    try { clearObservedFiles(sessionId); } catch { /* 忽略 */ }
    try { clearApprovalMemory(sessionId); } catch { /* 忽略 */ }
    try { clearSessionBypass(sessionId); } catch { /* 忽略 */ }
    // v3.6：todo 清单 / 插件技能目录清理（防多轮定时执行累积）
    try { clearTodos(sessionId); } catch { /* 忽略 */ }
    try { clearPluginSkillDirs(); } catch { /* 忽略 */ }
    // v3.6 审计修复：定时任务结束中止会话内全部后台子 Agent/job（runAgent finally
    // 只清本层深度；此处 depth<0 清全部——定时任务启动的后台任务不再残留孤儿进程）
    try { abortBackgroundAgentsByDepth(sessionId, -1); } catch { /* 忽略 */ }
    try { abortJobsByDepth(sessionId, -1); } catch { /* 忽略 */ }
  }
}
