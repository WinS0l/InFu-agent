/** 1.0.1 发布门禁：任何一步失败立即停止，不读取或修改用户本地 InFu 数据。 */
import { spawnSync } from "node:child_process";

const checks = [
  ["源码构建", "npm", ["run", "build"]],
  ["Web 生产构建", "npm", ["run", "build", "-w", "@infu/web"]],
  ["桌面构建", "npm", ["run", "build", "-w", "@infu/desktop"]],
  ["内置技能完整性", "node", ["scripts/skills-check.mjs"]],
  ["零告警 lint", "npm", ["run", "lint"]],
  ["全量测试", "npm", ["test"]],
  ["生产依赖审计", "npm", ["audit", "--omit=dev", "--audit-level=high"]],
];

for (const [label, command, args] of checks) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error) {
    console.error(`${label} 无法启动：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} 失败（退出码 ${result.status ?? "unknown"}）`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n✓ 1.0.1 发布门禁全部通过");
