/**
 * 设置 API 自测（v2.4：GET/PUT /api/config）
 * 运行：npx tsx packages/agent/tests/settings-api.test.ts
 *
 * 覆盖：
 *  - GET /api/config：缺省空节 + defaultModelId + 沙箱可用性检测字段
 *  - PUT /api/config：白名单四节 + defaultModelId 设置/清除
 *  - 拒绝写 providers/models/apiKey 等非白名单节（防提权）
 *  - 校验失败 400（非法档位/非法节值）
 *  - strip：未知字段不落盘
 *  - 落盘验证：读回 config.json 断言（数据目录重定向隔离）
 */
import { createApp } from "../src/server.js";
import { configPath, loadConfig, saveConfig } from "../src/providers/registry.js";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirForTest } from "../src/data-dir.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 设置 API 自测（v2.4）===\n");

// v3.6：数据目录重定向到临时目录（原备份/恢复真实 ~/.infu/config.json 崩溃即污染用户数据）
const tmpData = mkdtempSync(join(tmpdir(), "infu-test-"));
setDataDirForTest(tmpData);
// 测试期间从干净配置开始（configPath 跟随重定向目录）
const CONFIG = configPath();
saveConfig({ models: [] });

const app = createApp({ localToken: "test-token" });
const get = (url: string) => app.request(url, { headers: { "x-infu-token": "test-token" } });
const put = (url: string, body: unknown) =>
  app.request(url, { method: "PUT", headers: { "content-type": "application/json", "x-infu-token": "test-token" }, body: JSON.stringify(body) });

try {
  // ── 1. GET /api/config ──
  console.log("▶ GET /api/config（缺省态）");
  {
    const res = await get("/api/config");
    const data = await res.json();
    check("200", res.status === 200, String(res.status));
    check("approvalPolicy 空对象", typeof data.approvalPolicy === "object" && data.approvalPolicy.mode === undefined);
    check("sandbox 空对象", typeof data.sandbox === "object" && data.sandbox.mode === undefined);
    check("general 空对象", typeof data.general === "object");
    check("appearance 空对象", typeof data.appearance === "object");
    check("defaultModelId null", data.defaultModelId === null);
    check("sandbox 含 dockerAvailable 布尔", typeof data.sandbox.dockerAvailable === "boolean", JSON.stringify(data.sandbox));
    check("sandbox 含 winRestrictedOk 布尔", typeof data.sandbox.winRestrictedOk === "boolean");
  }

  // ── 2. PUT 合法写入 ──
  console.log("▶ PUT /api/config：合法写入");
  {
    const res = await put("/api/config", {
      approvalPolicy: { mode: "confirm", toolOverrides: [{ tool: "git*", risk: "low" }], commandAllowlist: ["npm run build", "git*"] },
      sandbox: { mode: "restricted" },
      general: { defaultRoot: "E:\\workspace\\demo" },
      appearance: { fontSize: "base", streamCursor: false },
    });
    const data = await res.json();
    check("200 ok", res.status === 200 && data.ok === true, JSON.stringify(data));

    const cfg = loadConfig()!;
    check("mode 落盘", cfg.approvalPolicy?.mode === "confirm");
    check("toolOverrides 落盘", cfg.approvalPolicy?.toolOverrides?.length === 1 && cfg.approvalPolicy.toolOverrides[0].risk === "low");
    check("commandAllowlist 落盘", cfg.approvalPolicy?.commandAllowlist?.length === 2);
    check("sandbox.mode 落盘", cfg.sandbox?.mode === "restricted");
    check("general.defaultRoot 落盘", cfg.general?.defaultRoot === "E:\\workspace\\demo");
    check("appearance 落盘", cfg.appearance?.fontSize === "base" && cfg.appearance.streamCursor === false);
    check("models 不受影响（空数组）", Array.isArray(cfg.models));
  }

  // ── 3. 白名单：拒绝非设置节 ──
  console.log("▶ PUT /api/config：白名单拒绝");
  {
    const res = await put("/api/config", { providers: [{ id: "evil", name: "evil", kind: "custom", apiKey: "hack" }] });
    const data = await res.json();
    check("写 providers → 400", res.status === 400 && data.ok === false, JSON.stringify(data));
    check("错误信息点名 providers", data.message.includes("providers"), data.message);

    const res2 = await put("/api/config", { models: [{ id: "m", name: "m", model: "m" }] });
    check("写 models → 400", res2.status === 400);

    const res3 = await put("/api/config", { apiKey: "hack" });
    check("写 apiKey → 400", res3.status === 400);

    const res4 = await put("/api/config", { roles: { planner: "x" } });
    check("写 roles → 400", res4.status === 400);

    const res5 = await put("/api/config", { mcpServers: [] });
    check("写 mcpServers → 400", res5.status === 400);

    // 拒绝后原配置不受影响
    const cfg = loadConfig()!;
    check("拒绝后无 providers 残留", (cfg.providers ?? []).length === 0);
    check("拒绝后无 models 残留", cfg.models.length === 0);
  }

  // ── 4. 校验失败 400 ──
  console.log("▶ PUT /api/config：校验失败");
  {
    const res = await put("/api/config", { approvalPolicy: { mode: "evil" } });
    check("非法档位 → 400", res.status === 400, JSON.stringify(await res.json()));
    const res2 = await put("/api/config", { sandbox: { mode: "nope" } });
    check("非法沙箱档 → 400", res2.status === 400);
    const res3 = await put("/api/config", { appearance: { fontSize: "xl" } });
    check("非法字号 → 400", res3.status === 400);
    const res4 = await put("/api/config", { approvalPolicy: { toolOverrides: [{ tool: "" }] } });
    check("空工具名 → 400", res4.status === 400);
    const res5 = await put("/api/config", "not-json");
    check("非对象请求体 → 400", res5.status === 400);
  }

  // ── 5. strip：未知字段不落盘 ──
  console.log("▶ PUT /api/config：strip 未知字段");
  {
    const res = await put("/api/config", { approvalPolicy: { mode: "auto", apiKey: "hack", sneaky: true } });
    check("200（未知字段被剥离而非拒绝）", res.status === 200, JSON.stringify(await res.json()));
    const cfg = loadConfig()!;
    check("apiKey 未落盘", (cfg.approvalPolicy as Record<string, unknown>).apiKey === undefined);
    check("sneaky 未落盘", (cfg.approvalPolicy as Record<string, unknown>).sneaky === undefined);
    check("mode 正常落盘", cfg.approvalPolicy?.mode === "auto");
  }

  // ── 6. defaultModelId 设置/清除 ──
  console.log("▶ PUT /api/config：defaultModelId");
  {
    // 先放一个模型（直接写配置）
    const before = loadConfig()!;
    before.models = [{ id: "demo-model", name: "Demo", model: "demo" }];
    saveConfig(before);

    const res = await put("/api/config", { defaultModelId: "demo-model" });
    check("设置默认模型 200", res.status === 200, JSON.stringify(await res.json()));
    check("defaultModelId 落盘", loadConfig()?.defaultModelId === "demo-model");

    const res2 = await put("/api/config", { defaultModelId: null });
    check("null 清除 200", res2.status === 200);
    check("defaultModelId 已清除", loadConfig()?.defaultModelId === undefined, JSON.stringify(loadConfig()?.defaultModelId));

    const res3 = await put("/api/config", { defaultModelId: "" });
    check("空串清除 200", res3.status === 200);
    check("空串后无残留", loadConfig()?.defaultModelId === undefined);
  }

  // ── 7. 部分更新不丢既有节 ──
  console.log("▶ PUT /api/config：部分更新");
  {
    await put("/api/config", { approvalPolicy: { mode: "confirm" }, general: { defaultRoot: "X:\\root" } });
    const res = await put("/api/config", { sandbox: { mode: "off" } });
    check("200", res.status === 200);
    const cfg = loadConfig()!;
    check("既有 approvalPolicy 保留", cfg.approvalPolicy?.mode === "confirm");
    check("既有 general 保留", cfg.general?.defaultRoot === "X:\\root");
    check("新 sandbox 生效", cfg.sandbox?.mode === "off");
  }

  // ── 8. 落盘文件可被 parseInfuConfig 读回（schema 往返）──
  console.log("▶ 落盘往返");
  {
    const raw = JSON.parse(readFileSync(CONFIG, "utf-8"));
    check("version 字段存在", typeof raw.version === "number");
    check("JSON 合法", typeof raw.approvalPolicy === "object");
  }

  // ── 9. browser 节 + /api/browser/status + /api/memory（v2.7）──
  console.log("▶ browser 节 + 浏览器/记忆端点");
  {
    const res = await put("/api/config", { browser: { headless: false, executablePath: "C:\\chromium\\chrome.exe" } });
    check("browser 节写入 200", res.status === 200, JSON.stringify(await res.json()));
    const cfg = loadConfig()!;
    check("browser.headless 落盘", cfg.browser?.headless === false);
    check("browser.executablePath 落盘", cfg.browser?.executablePath === "C:\\chromium\\chrome.exe");

    const bs = await (await get("/api/browser/status")).json();
    check("browser status 含 available 布尔", typeof bs.available === "boolean", JSON.stringify(bs));
    check("browser status 反映 headless=false", bs.headless === false);
    check("browser status 反映 executablePath", bs.executablePath === "C:\\chromium\\chrome.exe");
    check("browser status pluginEnabled 布尔", typeof bs.pluginEnabled === "boolean");

    const mem = await (await get("/api/memory")).json();
    check("memory 含 globalDir", typeof mem.globalDir === "string");
    check("memory 含 global 数组", Array.isArray(mem.global));
    check("memory 含 project 数组", Array.isArray(mem.project));

    // memory 节（自动沉淀开关）
    const mres = await put("/api/config", { memory: { autoSediment: false } });
    check("memory.autoSediment 写入 200", mres.status === 200, JSON.stringify(await mres.json()));
    check("memory.autoSediment 落盘", loadConfig()?.memory?.autoSediment === false);

    // v2.7 使用统计 + 索引库端点
    const stats = await (await get("/api/stats?days=7")).json();
    check("stats 含 tokens 数字", typeof stats.tokens === "number", JSON.stringify(stats));
    check("stats 含 sessions/messages/activeDays", typeof stats.sessions === "number" && typeof stats.messages === "number" && typeof stats.activeDays === "number");
    check("stats 含 modelUsage 数组", Array.isArray(stats.modelUsage));
    check("stats 含 dailyTrend 数组", Array.isArray(stats.dailyTrend));
    const idx = await (await get("/api/index/status")).json();
    check("index status 含 built 布尔", typeof idx.built === "boolean", JSON.stringify(idx));
  }
} finally {
  // v3.6：无需恢复——config 已重定向到临时数据目录，随 tmpData 一并清理
}

// 清理临时数据目录（v3.6：只删测试自己的临时目录，绝不动用户 ~/.infu）
try { rmSync(tmpData, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
