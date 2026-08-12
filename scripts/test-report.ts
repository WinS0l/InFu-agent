// 交付报告生成器自测
import { buildReport } from "../packages/agent/src/agent/loop.js";

const report = buildReport({
  prompt: "修复登录页面的 bug",
  steps: 5,
  toolLogs: [
    { tool: "project_scan", args: {}, ok: true, summary: "Node.js" },
    { tool: "read_file", args: { path: "src/App.jsx" }, ok: true, summary: "内容..." },
    { tool: "edit_file", args: { path: "src/App.jsx" }, ok: true, summary: "已修改" },
    { tool: "write_file", args: { path: "src/new.js" }, ok: true, summary: "已写入" },
    { tool: "run_test", args: {}, ok: true, summary: "1 passed, 0 failed" },
    { tool: "run_command", args: { command: "npm run build" }, ok: false, summary: "构建失败" },
  ],
  approvals: { required: 3, approved: 2, denied: 1 },
});
console.log(report);
