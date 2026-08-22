/**
 * OCR 截图文字兜底自测（v6.0 B5：Windows.Media.Ocr 零依赖）
 * 运行：npx tsx packages/agent/tests/ocr.test.ts
 *
 * 覆盖：
 *  - 工具注册：ocr_image（low）+ 只读白名单
 *  - 边界：越界路径/不存在/非图片类型 → 明确报错
 *  - 真实 OCR：PowerShell System.Drawing 绘制含文字的 PNG → ocr_image 识别出文本
 *  - path 省略 → 自动用 .infu/screenshots/ 最新截图
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ocrImageFile } from "../src/tools/vision.js";
import { TOOLS, getReadOnlyTools } from "../src/tools/index.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

const base = mkdtempSync(join(tmpdir(), "infu-ocr-"));
const root = join(base, "proj");
mkdirSync(join(root, ".infu", "screenshots"), { recursive: true });

/** 用 PowerShell System.Drawing 生成带文字的 PNG */
function makeTextPng(file: string, text: string): boolean {
  const ps = `Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 720, 180
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font("Arial", 48, [System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
$g.DrawString("${text}", $font, $brush, 20, 50)
$bmp.Save("${file.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf-8", timeout: 60000 });
  return r.status === 0;
}

(async () => {
  console.log("══ OCR 截图文字兜底（v6.0 B5）══");

  // ── 1. 注册 ──
  console.log("\n▶ 工具注册");
  const t = TOOLS.ocr_image;
  check("ocr_image 注册且 low", !!t && t.risk === "low");
  check("进只读白名单", getReadOnlyTools().ocr_image !== undefined);

  // ── 2. 边界 ──
  console.log("\n▶ 边界");
  const ctx = { root } as never;
  const b1 = await t.execute({ path: "../secret.png" }, ctx);
  check("越界路径拒绝", typeof b1 === "string" && b1.includes("越界"), String(b1));
  const b2 = await t.execute({ path: "nope.png" }, ctx);
  check("不存在文件拒绝", typeof b2 === "string" && b2.includes("不存在"), String(b2));
  writeFileSync(join(root, "note.md"), "# hi\n");
  const b3 = await t.execute({ path: "note.md" }, ctx);
  check("非图片类型拒绝", typeof b3 === "string" && b3.includes("仅支持"), String(b3));
  const b4 = await ocrImageFile(join(base, "missing.png"));
  check("绝对路径不存在拒绝", !b4.ok && b4.message.includes("不存在"), b4.message);

  // ── 3. 真实 OCR ──
  console.log("\n▶ 真实 OCR（Windows.Media.Ocr）");
  if (process.platform !== "win32") {
    console.log("  ⏭ 非 Windows 平台，跳过真实 OCR");
    check("非 Windows 明确报错", !(await ocrImageFile(join(root, "x.png"))).ok);
  } else {
    const img = join(root, "ocr-test.png");
    const okGen = makeTextPng(img, "HELLO123");
    check("测试图片生成", okGen && existsSync(img));
    const r = await ocrImageFile(img);
    check("OCR 识别成功", r.ok && !!r.text, r.message);
    const hit = r.ok ? /HELL[O0]123/.test((r.text ?? "").replace(/\s+/g, "")) : false;
    check("识别内容含绘制文字（HELLO123，O/0 容错）", hit, `got=${JSON.stringify(r.text)}`);
    const viaTool = await t.execute({ path: "ocr-test.png" }, ctx);
    check("工具路径识别同样命中", typeof viaTool === "string" && /HELL[O0]123/.test(String(viaTool).replace(/\s+/g, "")), String(viaTool).slice(0, 120));
  }

  // ── 4. path 省略 → 最新截图 ──
  console.log("\n▶ 省略 path（最新截图）");
  const r4 = await t.execute({}, ctx);
  check("无截图时提示先截图", typeof r4 === "string" && r4.includes("screenshots"), String(r4));
  const shot = join(root, ".infu", "screenshots", "shot-1.png");
  const okShot = makeTextPng(shot, "VERSION42");
  check("生成截图文件", okShot && existsSync(shot));
  const r5 = await t.execute({}, ctx);
  check("省略 path 识别最新截图", typeof r5 === "string" && /VERS[lI][O0]N42/.test(String(r5).replace(/\s+/g, "")), String(r5).slice(0, 120));

  try { rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
