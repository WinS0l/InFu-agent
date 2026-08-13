/**
 * 示例插件（v2.3 批 2 端到端实测夹具）
 * 运行：由 InFu 动态 import（config.plugins[] 引用）
 *
 * 演示能力：
 *  - 注册一个工具 echo_text（low risk）
 *  - 注册一个 preToolUse 安全钩子：拦截对敏感路径（config.json / .ssh/）的写操作
 */
import { z } from "zod";

export default {
  id: "sample",
  name: "示例插件",
  description: "v2.3 批 2 示例：echo_text 工具 + 敏感路径写保护钩子",
  tools: [
    {
      name: "echo_text",
      description: "原样返回文本（插件示例工具，无副作用）",
      schema: z.object({
        text: z.string().describe("要回显的文本"),
      }),
      risk: "low",
      execute: async (args) => `插件回显：${args.text ?? ""}`,
    },
  ],
  hooks: {
    preToolUse: async ({ tool, args }) => {
      // 示例安全钩子：拦截对敏感路径的写操作（write_file/edit_file）
      if ((tool === "write_file" || tool === "edit_file") && /(config\.json|\.ssh[\\/])/.test(String(args.path ?? ""))) {
        return { decision: "block", reason: "示例插件安全钩子：禁止修改配置文件（config.json / .ssh）" };
      }
      return { decision: "allow" };
    },
  },
};
