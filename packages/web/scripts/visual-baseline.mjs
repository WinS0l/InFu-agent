/**
 * Lightweight visual baseline runner. Requires INFU_CHROMIUM_PATH or a local
 * Chromium executable and a running Web preview (INFU_PREVIEW_URL).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const url = process.env.INFU_PREVIEW_URL ?? "http://127.0.0.1:5174/?infuAgentPort=4317&infuAgentToken=dev-preview-token";
const outputDir = process.env.INFU_VISUAL_OUTPUT_DIR ?? "artifacts/visual-baseline";
const referenceDir = process.env.INFU_VISUAL_REFERENCE_DIR;
const threshold = Number(process.env.INFU_VISUAL_THRESHOLD ?? "0.001");
const executablePath = process.env.INFU_CHROMIUM_PATH;
const chromiumArgs = executablePath ? { executablePath } : {};
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ ...chromiumArgs, headless: true });
for (const theme of ["light", "dark"]) {
  for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "narrow", width: 900, height: 760 }]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: join(outputDir, `${theme}-${viewport.name}.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();

if (referenceDir) {
  const files = await readdir(outputDir);
  const failures = [];
  for (const file of files.filter((name) => name.endsWith(".png"))) {
    const referencePath = join(referenceDir, file);
    try {
      const [actual, expected] = await Promise.all([readFile(join(outputDir, file)), readFile(referencePath)]);
      const a = PNG.sync.read(actual); const e = PNG.sync.read(expected);
      if (a.width !== e.width || a.height !== e.height) { failures.push(`${file}: 尺寸变化`); continue; }
      const diff = new PNG({ width: a.width, height: a.height });
      const changed = pixelmatch(e.data, a.data, diff.data, a.width, a.height, { threshold: 0.1 });
      const ratio = changed / (a.width * a.height);
      await writeFile(join(outputDir, `diff-${file}`), PNG.sync.write(diff));
      if (ratio > threshold) failures.push(`${file}: ${(ratio * 100).toFixed(3)}% > ${(threshold * 100).toFixed(3)}%`);
    } catch { failures.push(`${file}: 缺少基线`); }
  }
  if (failures.length) { console.error("视觉回归超过阈值:\n" + failures.join("\n")); process.exitCode = 1; }
}
