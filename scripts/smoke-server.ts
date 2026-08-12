// 服务冒烟测试（临时）
import { createApp } from "../packages/agent/src/server.js";

async function main() {
  const app = createApp();
  const res = await app.request("/api/health");
  console.log("health:", res.status, await res.text());
  const res2 = await app.request("/api/models");
  console.log("models:", res2.status, await res2.text());
}
main();
