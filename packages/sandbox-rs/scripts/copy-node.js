// napi 构建后把平台特定产物复制为 index.node（main 指向）
// 独立文件而非 node -e：避免 npm script 经 cmd.exe 传递时引号被剥
const fs = require("fs");

const f = fs.readdirSync(".").find((x) => x.endsWith(".node") && x !== "index.node");
if (!f) {
  console.log("⚠ 未找到构建产物 .node");
  process.exit(0);
}
try {
  fs.copyFileSync(f, "index.node");
  console.log("→ index.node (from " + f + ")");
} catch (e) {
  // Windows 文件锁：正在运行的 InFu 服务加载了 index.node 时无法覆盖
  console.log("⚠ index.node 被运行中的 InFu 服务占用，新产物已就绪：" + f);
  console.log("  重启服务后生效（停止 start-infu.bat 并重新启动）");
}
