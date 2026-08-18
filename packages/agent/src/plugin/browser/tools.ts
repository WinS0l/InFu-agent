/**
 * browser-use 插件工具（v3.0 批 8 定稿：宿主注入架构）
 * 工具：navigate / snapshot / click / type / fill / screenshot / close / tabs / tab_new / tab_select / viewport
 * 安全（v2.10 批 5 对齐主流）：浏览器操作降 low 自动执行；snapshot/screenshot/close 只读/收尾 → low。
 * 截图存文件（InFu 文本模型读不了图，交给用户查看）；AX 树快照是 Agent 主要"看"页面的方式。
 *
 * 批 8 修复（根因均来自「Bing搜索InFu失败」会话 916 条事件还原）：
 *  - browser_eval：Runtime.evaluate replMode（DevTools 控制台语义）——语句/表达式/函数
 *    三态通吃（旧实现只接受函数表达式：const 语句 SyntaxError、表达式 fn is not a function）
 *  - browser_fill：页面内多级匹配（CSS → placeholder/aria-label/name/title → label → 可见兜底）
 *    ——旧实现只有 CSS/text，placeholder「输入搜索词」找不到
 *  - browser_click：编号定位失败时自动重新快照（页面变化后编号失效）
 */
import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolDef, ToolContext } from "@infu/shared";
import { isPrivateHostText } from "@infu/shared";
import { guard, clip } from "../../tools/util.js";
import { getPage, closeBrowser, desktopSetViewport, type BrowserTab } from "./runtime.js";

/** 技能目录（control-browser / web-gui-tester，随插件分发） */
const skillDir = (name: string) => fileURLToPath(new URL(`./skills/${name}`, import.meta.url));

const NET_TIMEOUT = 30000;

/**
 * v4.0 审计修复（H4）：浏览器导航 SSRF 门禁——与 webfetch 防护对齐。
 * 浏览器携带用户登录会话（Cookie），信息价值远高于 webfetch：云元数据
 * （169.254.169.254）/内网管理页（192.168/10/172.16）/本机服务（127.0.0.1）的
 * IP 直写形式直接拒绝；localhost/127.0.0.1/[::1] 显式白名单（本地开发预览是
 * 浏览器工具核心用途，桌面端导航守卫同语义）。域名不做 DNS 复查（系统解析，
 * 通用 SSRF DNS-rebinding TOCTOU 局限，与 webfetch 一致）。返回 null = 允许。
 */
function ssrfBlockReason(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "URL 无效";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "仅支持 http/https";
  const host = u.hostname;
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  const r = isPrivateHostText(host);
  if (r !== null && r.private) {
    if (host === "127.0.0.1" || host === "::1" || /^127\./.test(host)) return null; // 回环显式白名单
    return `目标地址 ${host} 是内网/本机地址，浏览器导航已拦截（防 SSRF——浏览器携带你的登录会话；仅允许公网地址或 localhost/127.0.0.1）`;
  }
  return null;
}

/**
 * 页面快照（v3.0 批 5：AI 可访问性树 = 单一来源——交互节点带 [n] 编号，
 * click 编号与快照一致，根治编号错位；对齐 主流/InFu domSnapshot 工作流）
 */
async function snapshot(tab: BrowserTab): Promise<string> {
  const [title, url, ax, bodyText] = await Promise.all([
    tab.title().catch(() => ""),
    tab.url().catch(() => ""),
    tab.axSnapshot(),
    tab.bodyText().catch(() => ""),
  ]);
  return (
    `标题：${title}
URL：${url}

[页面结构（AI 可访问性树——click 用 [编号]，fill/type 用可访问名或 CSS 选择器）]：
` +
    (ax?.text ?? "（可访问性树不可用）") +
    `

[页面文本]：
${clip(bodyText.trim(), 4000) || "（无文本内容）"}`
  );
}

export const browserTools: ToolDef[] = [
  {
    name: "browser_navigate",
    description:
      "打开/导航到一个 URL（http/https 或 localhost）。打开后自动返回页面快照。何时用：当前标签页需要打开/跳转目标页。何时不用：目标页已存在于某个标签页时优先 browser_tab_select 切换复用（避免重复打开堆积）；需要与当前页并存对比时才 browser_tab_new。",
    // v2.10 批 5：浏览器导航降 low（只读联网，对齐 web 工具自动执行）
    risk: "low",
    schema: z.object({ url: z.string().describe("目标 URL") }),
    async execute(args, ctx) {
      if (typeof args.url !== "string" || !/^https?:\/\//i.test(args.url)) {
        return "错误：url 必须是 http/https 地址";
      }
      // v4.0 审计修复（H4）：SSRF 门禁（内网/云元数据 IP 直写拒绝）
      const ssrf = ssrfBlockReason(args.url);
      if (ssrf) return `错误：${ssrf}`;
      if (!(await guard(ctx, "browser_navigate", "low", `浏览器访问：${args.url}`))) {
        return "用户拒绝：未联网访问（InFu 默认断网，联网需人工审批放行）";
      }
      try {
        const tab = await getPage();
        await tab.goto(args.url as string, NET_TIMEOUT);
        return `已打开 ${await tab.url()}\n\n${await snapshot(tab)}`;
      } catch (e) {
        return `浏览器导航失败：${(e as Error).message}`;
      }
    },
  },
  {
    name: "browser_snapshot",
    description:
      "读取当前页面：AI 可访问性树（带 [编号] 的交互元素——点击/定位用）+ 页面文本。何时用：刚导航后理解页面结构、或需要最新定位事实（编号/可访问名）时。何时不用：只验证标题/简单状态用 browser_eval（更便宜）；页面无变化时复用上一次快照。注意：快照编号会随页面变化，操作前若页面可能已变请重新快照。",
    risk: "low",
    schema: z.object({}),
    async execute(_args, _ctx) {
      try {
        const tab = await getPage();
        return await snapshot(tab);
      } catch (e) {
        return `浏览器快照失败：${(e as Error).message}`;
      }
    },
  },
  {
    name: "browser_eval",
    description:
      "在页面中执行 JavaScript（读取/修改页面状态），返回执行结果。何时用：验证交互效果（如 document.title、按钮文案、元素计数）、读取 DOM 状态、复杂定位——这是最便宜的观察手段，优先于全量 snapshot。code 支持三类写法：表达式（document.title）、语句（const x = 1; x + 1）、函数体（() => document.querySelectorAll('a').length）。仅页面上下文执行，无 Node 能力，不可读写本地文件。",
    risk: "low",
    schema: z.object({
      code: z.string().describe("要执行的 JavaScript（表达式/语句/函数体均可，如 document.title 或 const x = 1; x）"),
      arg: z.string().optional().describe("传给函数体的参数（JSON 字符串；函数体形如 (p) => …）"),
    }),
    async execute(args, ctx) {
      const code = args.code as string;
      if (typeof code !== "string" || !code.trim()) return "错误：code 必填";
      if (!(await guard(ctx, "browser_eval", "low", `浏览器执行 JS：${code.slice(0, 40)}`))) return "用户拒绝：未执行";
      try {
        const tab = await getPage();
        let arg: unknown;
        if (typeof args.arg === "string" && args.arg.trim()) {
          try { arg = JSON.parse(args.arg); } catch { arg = args.arg; }
        }
        const result = await tab.evaluate(code, arg);
        return "执行结果：" + clip(JSON.stringify(result ?? null), 4000);
      } catch (e) {
        return `执行失败：${(e as Error).message}`;
      }
    },
  },
  {
    name: "browser_click",
    description: "点击页面元素。target 优先用 browser_snapshot 的 [编号]（如 3，与快照单一来源最可靠）；其次 text=可访问名（如 text=登录）；CSS 选择器最后（仅当快照无法表达）。点击后自动返回新快照。",
    // v2.10 批 5：浏览器交互降 low（已授权使用浏览器，对齐主流不逐次弹窗）
    risk: "low",
    schema: z.object({ target: z.string().describe("快照编号（如 3）或 CSS/文本选择器") }),
    async execute(args, ctx) {
      const target = args.target as string;
      if (typeof target !== "string" || !target.trim()) return "错误：target 必填";
      if (!(await guard(ctx, "browser_click", "low", `浏览器点击：${target}`))) return "用户拒绝：未点击";
      try {
        const tab = await getPage();
        let out: string;
        if (/^\d+$/.test(target.trim())) {
          // 同一份 snapshot：编号展示与点击定位同源（动态页面两次快照编号会漂移）
          const ax = await tab.axSnapshot();
          out = await tab.clickByIndex(Number(target.trim()), ax);
          // 编号失效（页面变化）→ 提示重新快照（不再静默失败导致 Agent 反复重试）
          if (out.startsWith("错误") || out.startsWith("点击失败")) {
            return out + "\n（页面可能已变化——请 browser_snapshot 获取最新编号后重试）";
          }
        } else {
          out = await tab.clickSelector(target);
          if (out.startsWith("错误")) {
            return out + "\n（可 browser_snapshot 确认可访问名/编号）";
          }
        }
        await tab.waitForLoad(5000).catch(() => {});
        return out + "\n\n" + (await snapshot(tab));
      } catch (e) {
        return `点击失败：${(e as Error).message}（请重新 browser_snapshot 确认编号/选择器）`;
      }
    },
  },
  {
    name: "browser_type",
    description: "在当前聚焦元素（先 click 定位）输入文本。",
    // v2.10 批 5：同 click
    risk: "low",
    schema: z.object({ text: z.string().describe("要输入的文本") }),
    async execute(args, ctx) {
      const text = args.text as string;
      if (typeof text !== "string") return "错误：text 必填";
      if (!(await guard(ctx, "browser_type", "low", `浏览器输入：${text.slice(0, 40)}`))) return "用户拒绝：未输入";
      try {
        const tab = await getPage();
        // 纯 JS 注入 activeElement（不依赖键盘焦点——焦点解耦，根治输入污染）
        return await tab.typeText(text);
      } catch (e) {
        return `输入失败：${(e as Error).message}`;
      }
    },
  },
  {
    name: "browser_fill",
    description: "定位输入框并填入值（等价 click+clear+type）。selector 优先用快照中的可访问名（如 text=用户名）或 placeholder 文本（如 输入搜索词）；CSS 选择器仅当快照无法表达。",
    // v2.10 批 5：同 click
    risk: "low",
    schema: z.object({
      selector: z.string().describe("输入框 CSS 选择器、placeholder 或可访问名"),
      value: z.string().describe("填入的值"),
    }),
    async execute(args, ctx) {
      const { selector, value } = args as { selector: string; value: string };
      if (typeof selector !== "string" || typeof value !== "string") return "错误：selector/value 必填";
      if (!(await guard(ctx, "browser_fill", "low", `浏览器填写 ${selector} = ${value.slice(0, 40)}`))) return "用户拒绝：未填写";
      try {
        const tab = await getPage();
        return await tab.fill(selector, value);
      } catch (e) {
        return `填写失败：${(e as Error).message}`;
      }
    },
  },
  {
    name: "browser_screenshot",
    description: "截图当前页面并保存为 PNG 文件，返回文件路径（供用户查看；InFu 文本模型读不了图）。用于视觉验证。",
    risk: "low",
    schema: z.object({ name: z.string().optional().describe("文件名（不含扩展名，默认带时间戳）") }),
    async execute(args, ctx) {
      try {
        const tab = await getPage();
        const dir = join(ctx.root, ".infu", "browser");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        // v3.5 数据生命周期：文件名带会话前缀（会话删除时联动清理该会话的浏览器截图）
        const sid = (ctx.sessionId ?? "cli").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8);
        const name = (typeof args.name === "string" && args.name.trim() ? args.name.trim() : "shot") + "-" + Date.now().toString(36);
        const file = join(dir, `${sid}-${name}.png`);
        const buf = await tab.screenshot();
        writeFileSync(file, buf);
        return `截图已保存：${file}`;
      } catch (e) {
        return `截图失败：${(e as Error).message}`;
      }
    },
  },
  {
    name: "browser_close",
    description:
      "关闭浏览器。⚠️ 几乎不要调用：即使任务完成也绝不主动关闭（用户可能继续查看页面；嵌入式浏览器 tab 除非显式关闭永不销毁，对齐主流）；只有用户明确说出「关闭浏览器」时才使用。任务完成直接总结即可。",
    risk: "low",
    schema: z.object({}),
    async execute() {
      await closeBrowser();
      return "浏览器已关闭";
    },
  },
  {
    name: "browser_tabs",
    description:
      "列出当前嵌入式浏览器的全部标签页（编号/标题/URL/是否活跃）。何时用：多页面任务开始时了解现状、决定「复用已有 tab 还是新开」；页面状态不确定时确认活跃页。发现已有符合目标的 tab 或空白 tab 时优先 browser_tab_select 复用，避免堆积。",
    risk: "low",
    schema: z.object({}),
    async execute() {
      const tabs = (globalThis as Record<string, unknown>).__infuBrowserTabs as
        | Array<{ id: number | string; url: string; title: string; active: boolean }>
        | undefined;
      if (!tabs || !tabs.length) return "当前没有打开的标签页（可用 browser_navigate 打开新页）";
      const lines = tabs.map((t, i) => {
        const title = t.title || (t.url ? t.url.slice(0, 40) : "新标签页");
        return `${t.active ? "▶" : " "} [${i + 1}] ${title}${t.url ? " — " + t.url.slice(0, 60) : ""}`;
      });
      return "标签页列表（browser_tab_select 用编号选择）：\n" + lines.join("\n");
    },
  },
  {
    name: "browser_tab_new",
    description:
      "新开一个标签页并加载指定 URL（对齐主流 tabs.new + goto）。url 可选——不传则开空白页。用于多页面场景（对比页面、分别保留状态）。新标签页直接加载目标 URL，无需再 browser_navigate。",
    risk: "low",
    schema: z.object({ url: z.string().optional().describe("要加载的 URL（可选，不传则空白页）") }),
    async execute(args, ctx) {
      const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : undefined;
      if (url && !/^https?:\/\//i.test(url)) return "错误：url 必须是 http/https 地址";
      // v4.0 审计修复（H4）：SSRF 门禁（与 browser_navigate 同款）
      if (url) {
        const ssrf = ssrfBlockReason(url);
        if (ssrf) return `错误：${ssrf}`;
      }
      if (!(await guard(ctx, "browser_tab_new", "low", "浏览器新开标签页" + (url ? "：" + url : "")))) return "用户拒绝：未新开";
      const g = globalThis as Record<string, unknown>;
      const openFn = g.__infuOpenEmbeddedBrowser as ((url?: string) => void) | undefined;
      if (typeof openFn !== "function") return "错误：桌面模式不可用（browser_tab_new 仅桌面版支持）";
      const before = new Set((g.__infuBrowserTabs as Array<{ id: string | number }>)?.map((t) => String(t.id)) ?? []);
      openFn(url);
      // 等新 tab 注册（渲染进程 dom-ready → 主进程注册表；加固环境初始化慢，轮询最长 20s）
      let ready = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const now = (g.__infuBrowserTabs as Array<{ id: string | number }>) ?? [];
        if (now.some((t) => !before.has(String(t.id)))) { ready = true; break; }
      }
      if (ready) await new Promise((r) => setTimeout(r, 1200)); // 新页初始化
      return ready
        ? "已新开标签页" + (url ? "并加载 " + url : "")
        : "已新开标签页，但新页尚未就绪（初始化较慢，稍后可 browser_snapshot 确认）";
    },
  },
  {
    name: "browser_tab_select",
    description:
      "切换到指定标签页（编号来自 browser_tabs 输出）。切换后 browser_snapshot 等工具作用于新活跃 tab。",
    risk: "low",
    schema: z.object({ index: z.number().describe("browser_tabs 输出的编号（从 1 开始）") }),
    async execute(args, ctx) {
      const idx = args.index as number;
      if (typeof idx !== "number" || idx < 1) return "错误：index 必须是正整数";
      if (!(await guard(ctx, "browser_tab_select", "low", `浏览器切换标签页 #${idx}`))) return "用户拒绝：未切换";
      const g = globalThis as Record<string, unknown>;
      const tabs = g.__infuBrowserTabs as
        | Array<{ id: number | string; url: string; title: string; active: boolean }>
        | undefined;
      const target = tabs?.[idx - 1];
      if (!target) return `错误：编号 ${idx} 不存在（先 browser_tabs 查看）`;
      if (target.active) return "该标签页已是活跃页";
      const select = g.__infuSelectBrowserTab as ((id: number | string) => void) | undefined;
      if (typeof select === "function") select(target.id);
      // 等主进程活跃标记切到目标（注册表广播）
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const now = g.__infuBrowserTabs as Array<{ id: string | number; active: boolean }> | undefined;
        if (now?.find((t) => t.active)?.id === target.id) break;
      }
      await new Promise((r) => setTimeout(r, 600));
      const label = target.title || target.url.slice(0, 40) || "空白页";
      return `已切换到标签页 #${idx}：${label}`;
    },
  },
  {
    name: "browser_viewport",
    description:
      "设置当前标签页的视口尺寸（对齐主流 viewport）：width/height 指定设备尺寸（如 375×812 手机模拟），fit=true 恢复适应窗口。设置后面板自动贴合该尺寸。",
    risk: "low",
    schema: z.object({
      width: z.number().optional().describe("视口宽度（像素，如 375）"),
      height: z.number().optional().describe("视口高度（像素，如 812）"),
      fit: z.boolean().optional().describe("true = 恢复适应窗口（清除视口覆盖）"),
    }),
    async execute(args, ctx) {
      const { width, height, fit } = args as { width?: number; height?: number; fit?: boolean };
      if (!fit && (!width || !height)) return "错误：需提供 width+height（设备尺寸）或 fit=true（恢复）";
      if (!(await guard(ctx, "browser_viewport", "low", `浏览器视口 ${fit ? "适应窗口" : width + "×" + height}`))) {
        return "用户拒绝：未设置";
      }
      try {
        await desktopSetViewport(fit ? { fit: true } : { width, height });
        return fit ? "已恢复适应窗口" : `已设置视口 ${width}×${height}（面板已贴合）`;
      } catch (e) {
        return `视口设置失败：${(e as Error).message}`;
      }
    },
  },
];

/** 插件定义（PluginDef）——plugin add browser-use 引用本模块即可获得工具 */
export default {
  id: "browser-use",
  name: "browser-use",
  description:
    "浏览器自动化：打开/导航网页、AI 可访问性树快照（主流 domSnapshot 同款）、点击/输入/填表/页面 JS 执行、截图视觉验证。用于 Web 前端测试、渲染页面抓取、交互验证（对齐主流 browser-use）。",
  version: "0.2.0",
  tools: browserTools,
  skills: [skillDir("control-browser"), skillDir("web-gui-tester")],
};
