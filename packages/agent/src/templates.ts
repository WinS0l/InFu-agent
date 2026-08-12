/**
 * 模板任务（M4 小白引导）— 一键初始化项目 / 修复测试失败 / 分析项目 / 添加功能
 *
 * 模板 prompt 支持 {fieldName} 占位符，由 renderTemplate 渲染用户填写值。
 * 列表通过 GET /api/templates 提供给 Web 端空态欢迎面板。
 */

import type { TaskTemplate } from "@infu/shared";
export { renderTemplate } from "@infu/shared";

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "init-project",
    name: "初始化新项目",
    category: "初始化",
    description: "在当前目录从零搭建标准项目骨架（配置、目录结构、README）",
    prompt: `当前目录是一个新项目（可能为空）。请：
1) 先分析当前目录已有内容与环境（project_scan / list_directory）；
2) 初始化一个 {techStack} 项目的标准骨架：包管理配置、入口文件、目录结构、README.md、.gitignore；
3) 验证项目可以正常安装/运行。`,
    fields: [
      {
        name: "techStack",
        label: "技术栈",
        placeholder: "如：Node.js + TypeScript / Python / React",
        default: "Node.js + TypeScript",
      },
    ],
  },
  {
    id: "fix-tests",
    name: "修复测试失败",
    category: "修复",
    description: "运行测试，找出失败原因并修复，最后确认全部通过",
    prompt: `请修复这个项目中失败的测试：
1) 先运行测试（run_test），记录失败的用例与报错信息；
2) 阅读相关源码定位失败原因（read_file / search_code）；
3) 修复代码（优先最小改动，符合项目现有风格）；
4) 再次运行测试确认全部通过；若仍有失败继续修复，直到通过或确认无法修复（说明原因）。`,
  },
  {
    id: "analyze",
    name: "分析项目",
    category: "分析",
    description: "分析项目技术栈、结构、核心模块，输出分析报告",
    prompt: `请分析这个项目的技术栈与结构：
1) 用 project_scan 识别技术栈与框架；
2) 用 list_directory / read_file 梳理目录结构与核心模块；
3) 输出一份结构化的项目分析报告（技术栈、模块划分、关键文件、入口、构建/测试方式、潜在风险）。`,
  },
  {
    id: "add-feature",
    name: "添加新功能",
    category: "开发",
    description: "描述要添加的功能，Agent 分析现有代码后实现并验证",
    prompt: `请为这个项目实现以下功能：{feature}
要求：
1) 先分析现有代码结构，找到合适的改动位置；
2) 设计实现方案（如涉及多个方案，说明取舍）；
3) 实现功能（最小改动、符合项目现有风格）；
4) 运行测试验证；若项目没有测试，则至少验证功能可运行。`,
    fields: [
      {
        name: "feature",
        label: "功能描述",
        placeholder: "如：增加一个 /api/status 接口返回服务状态",
      },
    ],
  },
];

/** 按 id 查找模板 */
export function findTemplate(id: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((t) => t.id === id);
}
