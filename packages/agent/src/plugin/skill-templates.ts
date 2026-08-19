/**
 * skill 模板库（v6.0 P4）——内置高质量 SKILL.md 模板，`infu skill template new` 一键生成本地技能。
 * 模板 = 社区标准 SKILL.md（frontmatter name/description + 结构化正文），
 * 含 {{name}}/{{description}} 占位符，创建时替换。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../data-dir.js";

export interface SkillTemplate {
  id: string;
  title: string;
  description: string;
  /** SKILL.md 正文模板（含 {{name}}/{{description}} 占位符） */
  body: string;
}

const bodyWrap = (frontmatterDesc: string, sections: string): string => `---
name: {{name}}
description: ${frontmatterDesc}
---
{{description}}
${sections}`;

export const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    id: "code-review",
    title: "代码审查",
    description: "只读代码审查技能：逐文件审查 + 问题清单 + 风险分级报告，绝不改代码",
    body: bodyWrap(
      "只读代码审查：发现缺陷/安全隐患/可维护性问题，输出分级报告，绝不修改任何文件",
      `## 触发场景
用户要求「审查/检查/评估」代码、或任务含 review/audit 关键词时使用。

## 工作流程（严格只读——review 期间绝不调用任何写工具）
1. 先 project_tree / list_directory 了解结构，git_status 看改动范围
2. 对每个目标文件 read_file 完整阅读（不跳读）
3. 用 search_code / code_symbols 交叉验证：被调函数是否定义、导出是否被使用
4. lsp_diagnostics 对可疑文件做语义诊断（类型错误/未使用变量）
5. 汇总为审查报告

## 审查清单（逐项核对）
- 安全：路径越界/命令注入/凭据硬编码/SSRF/权限缺失/敏感信息日志
- 正确性：边界条件/空值处理/错误吞掉/竞态/类型滥用/魔法数字
- 性能：循环内 IO/重复计算/N+1/大对象拷贝
- 可维护：死代码/重复代码/命名混乱/过长函数/注释与实际不符

## 报告格式（必守）
每项：**文件:行号** 问题描述 → 影响 → 修复建议
按严重度分级：🔴 严重（必须修）/ 🟡 中等（建议修）/ 🟢 轻微（可选）
结尾给总体结论 + 修改优先级排序（供 Executor 阶段执行）
`,
    ),
  },
  {
    id: "test-runner",
    title: "测试运行与修复",
    description: "测试驱动修复技能：先复现失败 → 定位根因 → 最小修复 → 回归验证",
    body: bodyWrap(
      "修复测试失败的完整闭环：复现 → 根因 → 修复 → 回归，杜绝「改测试凑绿」",
      `## 触发场景
用户报告测试失败、或 run_test 结果非绿、或任务要求「修复测试」。

## 工作流程（TDD 收敛闭环）
1. **先复现**：run_test（自动检测框架）跑出真实失败输出，不要猜
2. **读失败信息**：定位失败用例名 + 断言行 + 错误栈，read_file 对应测试文件
3. **找根因**：从断言反推被测代码路径，read_file 相关源码；不确定时用 code_symbols/lsp_definition 定位
4. **最小修复**：只改根因处，一次只改一处；不为了凑绿改测试断言
5. **回归验证**：再次 run_test，目标 = 全绿；修复后运行相邻套件防连带
6. 修复无进展时换策略（重读需求/查调用方/查历史），连续 3 轮无进展应停下来向用户说明

## 红线
- 绝不修改测试断言来掩盖真实缺陷（除非断言本身确实写错，且要在报告中说明）
- 修复后必须实际运行测试验证（测试框架存在时），不允许口头宣称通过
- 输出交付报告：失败原因 + 改动文件清单 + 验证结果
`,
    ),
  },
  {
    id: "docs-writer",
    title: "文档编写",
    description: "项目文档编写技能：README/API 文档/变更记录，结构清晰、示例可运行",
    body: bodyWrap(
      "编写高质量项目文档：README/API/CHANGELOG，结构规范、示例真实可运行",
      `## 触发场景
用户要求「写文档/补充文档/README/使用说明/API 文档」时使用。

## 工作流程
1. 先了解项目全貌：project_tree 结构 + read_file 入口（package.json/README/主模块）
2. 动手前先列出文档大纲（标题层级），确认覆盖：项目简介/安装/快速开始/配置/API/常见问题
3. 写文档时保持「示例真实」：命令与配置必须实际验证过（run_command 试跑）
4. 完成后自查：链接是否有效、代码块语言标注、术语一致

## 写作规范
- 标题层级正确（一级标题全文档仅一个）
- 每段 ≤5 行；先结论后细节；中文文档用中文标点
- 代码块带语言标注；命令行给完整可复制内容
- README 必备节：简介（一句话 + 能力列表）/ 快速开始（5 步内）/ 配置说明 / 常见问题
- API 文档：签名 + 参数表 + 返回值 + 示例 + 错误说明

## 红线
- 文档内容必须与实现一致（写 API 文档前先读源码确认参数名）
- 不确定的行为标注「待验证」而不是编造
`,
    ),
  },
  {
    id: "refactor",
    title: "重构",
    description: "行为保持重构技能：小步重构、每步验证、可回退，绝不改变外部行为",
    body: bodyWrap(
      "安全重构：保持行为不变的小步重构，每步跑测试验证，随时可回退",
      `## 触发场景
用户要求「重构/优化结构/提取函数/拆分模块/清理代码」时使用。

## 核心原则
- **行为保持**：重构后外部行为（接口/输出/性能语义）必须完全不变
- **小步前进**：每次只做一个可验证的变换，不要大爆炸式重写
- **先有护栏**：重构前先确认有测试覆盖（run_test 全绿基线）；无测试时先补冒烟再动

## 工作流程
1. 基线：run_test 确认当前全绿（或记录当前失败清单）
2. 读目标代码：read_file 全文 + code_symbols/lsp_definition 找关联引用
3. 确定重构计划（命名/职责/依赖），写入 todo_write
4. 小步执行：改一处 → 验证（run_test 或至少 tsc/语法检查）→ 再下一处
5. 收尾：全量回归 + 检查死代码/未使用导入（lsp_diagnostics 辅助）

## 典型变换（按风险升序）
- 重命名/提取常量（零风险）→ 提取函数（低）→ 提取模块/类（中）→ 重写实现（高，必须逐行为验证）

## 红线
- 一次提交一个重构单元；每步都可通过测试回退定位
- 重构 ≠ 加功能：发现新需求记入报告，不在重构中夹带
`,
    ),
  },
];

/** 列出模板（id + 标题 + 简介） */
export function listSkillTemplates(): Array<{ id: string; title: string; description: string }> {
  return SKILL_TEMPLATES.map((t) => ({ id: t.id, title: t.title, description: t.description }));
}

/** 校验技能名（目录名规则：字母数字 _-，非空，不以 . 开头，无路径分隔符） */
export function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && !name.startsWith(".");
}

/** 从模板创建技能 → <dataDir>/skills/<name>/SKILL.md；已存在返回 false（不覆盖） */
export function createSkillFromTemplate(name: string, templateId: string): { ok: boolean; message: string; path?: string } {
  if (!isValidSkillName(name)) {
    return { ok: false, message: `技能名不合法（仅允许字母/数字/_/-，不能以 . 开头）：${name}` };
  }
  const tpl = SKILL_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) {
    return { ok: false, message: `模板不存在：${templateId}（infu skill template list 查看可用模板）` };
  }
  const dest = path.join(resolveDataDir(), "skills", name);
  const skillFile = path.join(dest, "SKILL.md");
  if (fs.existsSync(skillFile)) {
    return { ok: false, message: `${skillFile} 已存在（不覆盖；可先移除再创建）` };
  }
  try {
    fs.mkdirSync(dest, { recursive: true });
    const content = tpl.body
      .replaceAll("{{name}}", name)
      .replaceAll("{{description}}", tpl.description);
    fs.writeFileSync(skillFile, content, "utf-8");
    return { ok: true, message: `已从模板 "${tpl.id}" 创建技能 ${name} → ${skillFile}`, path: skillFile };
  } catch (e) {
    return { ok: false, message: `创建失败：${(e as Error).message}` };
  }
}