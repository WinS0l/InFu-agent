/**
 * 供应商 /models 上游获取自测（v2 模型管理：勾选启用前拉取模型列表）
 * 运行：npx tsx packages/agent/tests/providers-api.test.ts
 *
 * 直接测 server createApp 的 POST /api/providers/:id/models 端点（mock global fetch）：
 * 成功解析 / 401 透传 / 端点不支持报错 / 供应商不存在
 */
import { createApp } from "../src/server.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const originalFetch = globalThis.fetch;
function installFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  (globalThis as any).fetch = impl;
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// 临时配置文件隔离（server 用 ~/.infu/config.json——这里备份/恢复）
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const CONFIG = join(homedir(), ".infu", "config.json");
const backup = CONFIG + ".providers-test-backup";
function saveTestConfig(cfg: unknown) {
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), "utf-8");
}

console.log("\n=== 供应商上游获取自测 ===\n");

// 备份用户配置（测试后恢复）
const hadConfig = existsSync(CONFIG);
if (hadConfig) copyFileSync(CONFIG, backup);

const app = createApp();
const call = (url: string, init?: RequestInit) => app.request(url, init);

try {
  // 1. 成功：标准 OpenAI /models 返回
  console.log("▶ 成功获取");
  saveTestConfig({
    version: 2,
    providers: [
      { id: "deepseek", name: "DeepSeek", kind: "deepseek", baseURL: "https://api.deepseek.com/v1", apiKey: "sk-test" },
    ],
    models: [],
  });
  installFetch(async (url) => {
    check("请求打到 {baseURL}/models", url === "https://api.deepseek.com/v1/models", url);
    return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro", name: "Pro" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const r1 = await call("/api/providers/deepseek/models", { method: "POST" });
  const j1 = (await r1.json()) as any;
  check("返回模型列表", j1.ok && j1.models.length === 2, JSON.stringify(j1));
  check("id/name 解析", j1.models[0].id === "deepseek-v4-flash" && j1.models[1].name === "Pro");

  // 2. 401：key 无效透传
  console.log("\n▶ 401 透传");
  installFetch(async () => new Response("invalid key", { status: 401 }));
  const r2 = await call("/api/providers/deepseek/models", { method: "POST" });
  const j2 = (await r2.json()) as any;
  check("401 报错含状态码", !j2.ok && j2.message.includes("401"), j2.message);

  // 3. 端点不支持 /models（网络错误）
  console.log("\n▶ 端点不支持");
  installFetch(async () => { throw new TypeError("fetch failed"); });
  const r3 = await call("/api/providers/deepseek/models", { method: "POST" });
  const j3 = (await r3.json()) as any;
  check("网络错误报明确信息", !j3.ok && /获取模型列表失败/.test(j3.message), j3.message);

  // 4. 供应商不存在
  console.log("\n▶ 供应商不存在");
  installFetch(async () => new Response("{}", { status: 200 }));
  const r4 = await call("/api/providers/nope/models", { method: "POST" });
  const j4 = (await r4.json()) as any;
  check("404 供应商不存在", r4.status === 404 && !j4.ok, String(r4.status));

  // 5. 非数组 data 容错
  console.log("\n▶ 异常响应容错");
  installFetch(async () => new Response(JSON.stringify({ data: "not-array" }), { status: 200 }));
  const r5 = await call("/api/providers/deepseek/models", { method: "POST" });
  const j5 = (await r5.json()) as any;
  check("data 非数组返回空列表", j5.ok && j5.models.length === 0);
} finally {
  restoreFetch();
  // 恢复用户配置
  if (hadConfig) {
    copyFileSync(backup, CONFIG);
    rmSync(backup, { force: true });
  }
}

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
