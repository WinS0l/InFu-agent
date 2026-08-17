/**
 * document-skills 官方插件（v2.7）——docx/pdf/pptx 三个文档技能
 * 借鉴 zcode 官方 document-skills 插件（Anthropic document-skills 复刻）。
 * 插件 = 分发单位，内容为 skills（由 loadPlugins 的 registerPluginSkillDirs 挂载）。
 */
import { fileURLToPath } from "node:url";

const skillDir = (name: string) => fileURLToPath(new URL(`../../../skills/${name}`, import.meta.url));

export default {
  id: "document-skills",
  name: "document-skills",
  description: "文档处理三件套：docx（Word 创建/编辑/审阅）、pdf（报告/创意/LaTeX/PDF 处理）、pptx（PowerPoint 精确编辑）。",
  version: "1.0.0",
  skills: [skillDir("docx"), skillDir("pdf"), skillDir("pptx")],
};
