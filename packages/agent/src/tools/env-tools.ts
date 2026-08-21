/**
 * v3.1 环境与系统信息工具。
 * - os_info：系统环境信息（只读，进白名单——Agent 判断平台/工具链可用性）
 * - current_time：当前时间（只读，进白名单——定时/期限类任务需要）
 */
import { z } from "zod";
import os from "node:os";
import type { ToolDef } from "@infu/shared";

export const envTools: Record<string, ToolDef> = {
  os_info: {
    name: "os_info",
    description: "输出当前系统环境信息（只读）：操作系统/平台/架构、CPU 核数、内存总量、Node 版本、主目录。判断命令兼容性（如 Windows 没有 bash）或资源限制时使用。",
    risk: "low",
    schema: z.object({}),
    async execute() {
      const mem = os.totalmem() / 1024 / 1024 / 1024;
      const info = [
        `平台: ${os.platform()} (${os.release()})`,
        `架构: ${os.arch()}`,
        `CPU: ${os.cpus().length} 核 (${os.cpus()[0]?.model.trim() ?? "未知"})`,
        `内存: ${mem.toFixed(1)} GB`,
        `主机名: ${os.hostname()}`,
        `用户目录: ${os.homedir()}`,
        `Node: ${process.version}`,
        `Shell: ${process.platform === "win32" ? "cmd.exe (Windows)" : "/bin/bash"}`,
      ].join("\n");
      return info;
    },
  },

  current_time: {
    name: "current_time",
    description: "输出当前日期与时间（只读）。任务涉及时间判断（构建缓存时效、日志时间戳、定时语义）时先调用，不要猜测当前时间。",
    risk: "low",
    schema: z.object({}),
    async execute() {
      const now = new Date();
      return now.toISOString();
    },
  },
};
