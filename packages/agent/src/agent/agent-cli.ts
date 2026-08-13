/**
 * 子智能体 CLI（v2.5：agent 文件化定义 = 文件系统即注册，管理只读）
 */

import { listAgents } from "./agents.js";

export async function agentCli(args: string[]): Promise<void> {
  const cmd = args[0];
  if (cmd === "list") return agentList(args.slice(1));
  console.log(`InFu 子智能体管理（v2.5：agent 文件化定义，文件系统即注册）

用法：
  infu agent list [--root <路径>]   列出可用子智能体（用户级 ~/.infu/agents > 项目级 .infu/agents）

定义：写入 ~/.infu/agents/<name>.md 或 <root>/.infu/agents/<name>.md 即自动注册，格式：
---
description: 角色一句话说明（必填，发现层摘要）
tools: read_file, search_code, list_directory, project_scan, git_status, git_diff, use_skill, run_test
model: <模型 id，可选；缺省继承父级模型>
maxSteps: 12
---
正文 = 角色系统提示词。Executor 用 delegate_task 工具（agent 参数引用）委派执行。`);
}

async function agentList(args: string[]): Promise<void> {
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const agents = listAgents(root);
  if (!agents.length) {
    console.log("（未发现 agent 文件——写入 ~/.infu/agents/<name>.md 或 <root>/.infu/agents/<name>.md 即自动注册）");
    return;
  }
  for (const a of agents) {
    console.log(`  ${a.name}（${a.level === "user" ? "用户级" : "项目级"}）`);
    console.log(`    ${a.description.slice(0, 120)}`);
    console.log(
      `    工具: ${a.tools?.join(", ") || "只读 + run_test（缺省）"}${a.model ? ` ｜ 模型: ${a.model}` : ""}${a.maxSteps ? ` ｜ 步数: ${a.maxSteps}` : ""}${a.thinkingLevel ? ` ｜ 思考级别: ${a.thinkingLevel}` : ""}`
    );
    console.log(`    文件: ${a.path}`);
  }
}
