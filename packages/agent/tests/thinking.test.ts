/**
 * 思考级别自测（v2 模型管理：4 档 UI → 每模型实际级别自动映射 + provider 参数注入）
 * 运行：npx tsx packages/agent/tests/thinking.test.ts
 *
 * 覆盖：mapThinkingLevel（N=1/2/3/4 全映射，含 DeepSeek 2 级用户例子）/
 *      buildThinkingParams（8 家参数）/ resolveThinkingLevels（显式 > 模板 > 1）
 */
import { mapThinkingLevel, buildThinkingParams, buildThinkingParamsForModel, resolveThinkingLevels } from "../src/providers/registry.js";
import type { ModelConfig } from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 思考级别自测 ===\n");

// 1. 映射算法
console.log("▶ mapThinkingLevel");
// N=2（DeepSeek）：1→1（非思考）、2-4→2（深度思考）——用户明确例子
check("N=2: UI1→1", mapThinkingLevel(1, 2) === 1);
check("N=2: UI2→2", mapThinkingLevel(2, 2) === 2);
check("N=2: UI3→2", mapThinkingLevel(3, 2) === 2);
check("N=2: UI4→2", mapThinkingLevel(4, 2) === 2);
// N=1（无思考模型）
check("N=1: 恒 1", mapThinkingLevel(1, 1) === 1 && mapThinkingLevel(4, 1) === 1);
// N=3（deepseek-v4-pro）
check("N=3: 1,2,3,3", [1, 2, 3, 4].map((u) => mapThinkingLevel(u, 3)).join(",") === "1,2,3,3");
// N=4（直通）
check("N=4: 直通", [1, 2, 3, 4].map((u) => mapThinkingLevel(u, 4)).join(",") === "1,2,3,4");
// 越界保护
check("越界输入收敛", mapThinkingLevel(0, 4) === 1 && mapThinkingLevel(9, 4) === 4);

// 2. 参数注入
console.log("\n▶ buildThinkingParams");
const dsOff = buildThinkingParams("deepseek", 1, 2);
check("deepseek 1 级 = thinking disabled", JSON.stringify(dsOff) === '{"thinking":{"type":"disabled"}}', JSON.stringify(dsOff));
const dsOn = buildThinkingParams("deepseek", 2, 2);
check("deepseek 2 级 = thinking enabled", JSON.stringify(dsOn) === '{"thinking":{"type":"enabled"}}', JSON.stringify(dsOn));
const dsMax = buildThinkingParams("deepseek", 3, 3);
check("deepseek 3 级（pro）= enabled + max", (dsMax as any).reasoning_effort === "max" && (dsMax as any).thinking.type === "enabled");
check("openai 2 级 = reasoning_effort medium", JSON.stringify(buildThinkingParams("openai", 2, 4)) === '{"reasoning_effort":"medium"}');
check("openai 4 级 = xhigh", (buildThinkingParams("openai", 4, 4) as any).reasoning_effort === "xhigh");
check("anthropic 3 级 = high", (buildThinkingParams("anthropic", 3, 4) as any).reasoning_effort === "high");
const zhipuOn = buildThinkingParams("zhipu", 2, 4);
check("zhipu 2 级 = thinking + medium", (zhipuOn as any).thinking.type === "enabled" && (zhipuOn as any).reasoning_effort === "medium");
check("qwen 1 级 = enable_thinking false", JSON.stringify(buildThinkingParams("qwen", 1, 2)) === '{"enable_thinking":false}');
check("qwen 2 级 = enable_thinking true", JSON.stringify(buildThinkingParams("qwen", 2, 2)) === '{"enable_thinking":true}');
const g = buildThinkingParams("google", 3, 4);
check("google 3 级 = thinkingLevel medium", JSON.stringify(g) === '{"thinkingConfig":{"thinkingLevel":"medium"}}', JSON.stringify(g));
check("ollama 不注入", buildThinkingParams("ollama", 2, 2) === undefined);
check("custom 不注入（无通用参数）", buildThinkingParams("custom", 2, 3) === undefined);

// 3. resolveThinkingLevels（显式 > 模板 > 1）
console.log("\n▶ resolveThinkingLevels");
const cfg: any = {
  version: 2,
  providers: [{ id: "deepseek", name: "D", kind: "deepseek" }, { id: "qwen", name: "Q", kind: "qwen" }],
  models: [],
};
const m1: ModelConfig = { id: "a", name: "A", providerId: "deepseek", model: "deepseek-v4-flash", thinkingLevels: 3 };
check("显式配置优先", resolveThinkingLevels(cfg, m1) === 3);
const m2: ModelConfig = { id: "b", name: "B", providerId: "deepseek", model: "deepseek-v4-flash" };
check("模板默认（deepseek=3，V4 三档）", resolveThinkingLevels(cfg, m2) === 3);
const m3: ModelConfig = { id: "c", name: "C", providerId: "qwen", model: "qwen3-coder-plus" };
check("模板默认（qwen=1）", resolveThinkingLevels(cfg, m3) === 1);
const m4: ModelConfig = { id: "d", name: "D", provider: "ollama", model: "x" };
check("v1 遗留按 kind 兜底（ollama=1）", resolveThinkingLevels(null, m4) === 1);

// 4. thinkingOverride（小众模型自定义每档参数）
console.log("\n▶ buildThinkingParamsForModel（override 优先）");
const ov: Array<Record<string, unknown> | null> = [
  { custom_flag: "off" },
  { custom_flag: "on", deep: 1 },
  null, // 第 3 级不注入
];
check("override 命中第 1 档", JSON.stringify(buildThinkingParamsForModel("custom", 1, 3, ov)) === '{"custom_flag":"off"}');
check("override 命中第 2 档", (buildThinkingParamsForModel("custom", 2, 3, ov) as any).deep === 1);
check("override null = 该档不注入", buildThinkingParamsForModel("custom", 3, 3, ov) === undefined);
check("override 越界回退协议映射（custom 无通用 → undefined）", buildThinkingParamsForModel("custom", 4, 3, ov) === undefined);
check("无 override 走协议映射（deepseek 2 级思考）", JSON.stringify(buildThinkingParamsForModel("deepseek", 2, 2)) === '{"thinking":{"type":"enabled"}}');
check("override 仅 2 项第 3 档回退协议（deepseek）", JSON.stringify(buildThinkingParamsForModel("deepseek", 3, 3, [{ a: 1 }, { b: 2 }])) === '{"thinking":{"type":"enabled"},"reasoning_effort":"max"}');

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
