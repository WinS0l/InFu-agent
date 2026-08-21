/**
 * skill-creator 官方插件（v2.7）——引导 Agent 创建/迭代高质量 SKILL.md 技能
 * 引导 Agent 创建和维护高质量 SKILL.md 技能。
 */
import { fileURLToPath } from "node:url";

export default {
  id: "skill-creator",
  name: "skill-creator",
  description: "创建新技能、编辑现有技能、迭代措辞。把重复工作流沉淀为可复用 SKILL.md 时使用。",
  version: "1.0.0",
  skills: [fileURLToPath(new URL("../../../skills/skill-creator", import.meta.url))],
};
