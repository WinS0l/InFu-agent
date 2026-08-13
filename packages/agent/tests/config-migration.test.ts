/**
 * config v1 → v2 迁移自测（v2 模型管理重构：供应商凭据 + 模型引用）
 * 运行：npx tsx packages/agent/tests/config-migration.test.ts
 *
 * 覆盖：归并（同 kind+baseURL 合并）/ custom 多端点编号 / key 迁移 /
 *      默认模型与 roles 保留 / 幂等 / 已是 v2 不动 / 校验失败报错
 */
import { parseInfuConfig, migrateConfigV1 } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== config v1→v2 迁移自测 ===\n");

// 1. 基础归并：同 kind 合并一家，custom 按 baseURL 分家
console.log("▶ 归并与 key 迁移");
const v1 = {
  version: 1,
  defaultModelId: "deepseek-v4-flash",
  roles: { reviewer: "kimi-k3" },
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek Flash", provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-1", contextWindow: 1_000_000 },
    { id: "deepseek-v4-pro", name: "DeepSeek Pro", provider: "deepseek", model: "deepseek-v4-pro", apiKey: "sk-2" },
    { id: "kimi-k3", name: "Kimi", provider: "custom", model: "kimi-k3", baseURL: "https://api.moonshot.cn/v1", apiKey: "sk-3" },
    { id: "local-qwen", name: "Ollama", provider: "ollama", model: "qwen3:8b" },
  ],
};
const r = parseInfuConfig(v1);
check("解析成功", r.ok, r.ok ? "" : r.error);
const cfg = (r as { ok: true; config: any }).config;
check("版本升到 2", cfg.version === 2, String(cfg.version));
check("deepseek 合并为一家（key 取首个）", cfg.providers.filter((p: any) => p.kind === "deepseek").length === 1, JSON.stringify(cfg.providers));
const ds = cfg.providers.find((p: any) => p.kind === "deepseek");
check("deepseek key 迁移到供应商层", ds.apiKey === "sk-1");
check("custom 保留 baseURL", cfg.providers.find((p: any) => p.kind === "custom")?.baseURL === "https://api.moonshot.cn/v1");
check("ollama 无 key", cfg.providers.find((p: any) => p.kind === "ollama")?.apiKey === undefined);
const flash = cfg.models.find((m: any) => m.id === "deepseek-v4-flash");
check("模型引用 providerId", flash.providerId === "deepseek" && flash.apiKey === undefined, JSON.stringify(flash));
check("contextWindow 保留", flash.contextWindow === 1_000_000);
check("defaultModelId 保留", cfg.defaultModelId === "deepseek-v4-flash");
check("roles 保留", cfg.roles?.reviewer === "kimi-k3");

// 2. custom 多端点编号
console.log("\n▶ custom 多端点编号");
const r2 = migrateConfigV1({
  models: [
    { id: "a", name: "A", provider: "custom", model: "a", baseURL: "https://x.com/v1", apiKey: "k1" },
    { id: "b", name: "B", provider: "custom", model: "b", baseURL: "https://y.com/v1", apiKey: "k2" },
  ],
});
check("custom-1 / custom-2", r2.providers.map((p) => p.id).join(",") === "custom,custom-2", JSON.stringify(r2.providers.map((p) => p.id)));

// 3. 幂等 / 已是 v2
console.log("\n▶ 幂等");
const r3 = migrateConfigV1(cfg);
check("二次迁移不变", JSON.stringify(r3.providers) === JSON.stringify(cfg.providers) && r3.models.every((m: any) => !m.provider));
const r4 = migrateConfigV1({ version: 2, providers: [{ id: "x", name: "X", kind: "custom" }], models: [{ id: "m", name: "M", providerId: "x", model: "m1" }] });
check("已是 v2 原样返回", r4.providers?.length === 1 && r4.models[0].providerId === "x");

// 4. 校验失败
console.log("\n▶ 校验失败");
const r5 = parseInfuConfig({ models: [{ id: "", name: "x", model: "y" }] });
check("非法配置报错", !r5.ok && r5.error.length > 0);

// 5. 同供应商后出现的 key 补充
console.log("\n▶ key 补充");
const r6 = migrateConfigV1({
  models: [
    { id: "a", name: "A", provider: "deepseek", model: "a" },
    { id: "b", name: "B", provider: "deepseek", model: "b", apiKey: "late-key" },
  ],
});
check("首个无 key 时取后出现的 key", r6.providers[0].apiKey === "late-key");

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
