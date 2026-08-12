// 沙箱模块自测（临时）
import {
  sanitizeEnv, isProtectedPath, dockerAvailable, resolveSandboxMode, buildDockerArgs,
} from "../packages/agent/src/sandbox/index.js";

async function main() {
  // 1. 环境变量消毒
  process.env.OPENAI_API_KEY = "sk-secret-123";
  process.env.INFU_DEEPSEEK_API_KEY = "sk-xxx";
  process.env.USERPROFILE = "C:/Users/test";
  const clean = sanitizeEnv();
  console.log("1) 消毒: OPENAI key 剔除 =", !("OPENAI_API_KEY" in clean),
    "| INFU key 剔除 =", !("INFU_DEEPSEEK_API_KEY" in clean),
    "| 普通变量保留 =", "USERPROFILE" in clean);

  // 2. 敏感路径保护
  console.log("2) ~/.ssh/id_rsa 拦截 =", isProtectedPath("C:/Users/test/.ssh/id_rsa"));
  console.log("2) 项目内文件放行 =", isProtectedPath("E:/InFu(test)/src/App.jsx"));
  console.log("2) ~/.infu 拦截 =", isProtectedPath("C:/Users/test/.infu/config.json"));

  // 3. Docker 检测
  const d = await dockerAvailable();
  console.log("3) Docker 可用 =", d);

  // 4. 模式解析
  console.log("4) 默认模式 =", resolveSandboxMode());
  process.env.INFU_SANDBOX = "docker";
  console.log("4) INFU_SANDBOX=docker →", resolveSandboxMode());

  // 5. Docker 参数构建
  const args = buildDockerArgs("E:\\InFu(test)", "npm test");
  console.log("5) docker 参数:", args.join(" "));
}
main();
