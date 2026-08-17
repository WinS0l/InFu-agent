/**
 * v2.6 收尾新增联网工具（主流 coding agent 标配：主流 WebFetch/WebSearch、
 * Gemini web_fetch/google_web_search、主流 webfetch/websearch）
 *
 * 网络策略（与 run_command network=true 同门禁）：
 *   - 默认断网：本机网络出站是软控制（net-policy.ts），联网 = 用户显式授权
 *   - 每次调用走 guard high + requireExplicit（-y 不自动放行；auto/smart 档位也不豁免）
 *   - 审计：工具调用本身全量落库（tool-start/tool-result），无需额外命令审计
 *
 * v2.10 批 4 更新：只读联网（webfetch/web_search）降为 low——smart 档自动放行（对齐主流），
 * confirm 档仍确认；断网策略不豁免（默认仍断网，首次联网需用户放行，见上面门禁语义）。
 * SSRF 防护（v2.13）：初始 URL 与每个重定向目标均拒绝内网/回环/链路本地/云元数据地址。
 *
 * v2.10 修复 web_search「经常搜不到」根因：原 DuckDuckGo Instant Answer API 只返回
 * 「即时答案」卡片（绝大多数查询为空）→ 改为 **DuckDuckGo HTML 搜索端点**（真实结果
 * 列表，免 Key，社区标配），失败自动降级回退 Instant Answer；设 INFU_TAVILY_API_KEY
 * 时仍优先 Tavily（质量最高）。
 */
import { z } from "zod";
import type { ToolDef } from "@infu/shared";
import { guard, clip } from "./util.js";
import { lookup } from "node:dns/promises";

const NET_TIMEOUT = 20000;
const MAX_BODY = 1024 * 1024; // 1MB 响应体上限
/** 真实浏览器 UA（DDG HTML 端点反爬要求；Instant Answer API 不需要） */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * v3.1 审计修复：IPv4 简写归一化——`127.1`（=127.0.0.1）、`2130706433`（32 位十进制）、
 * `0x7f000001`（十六进制）、`127.0.1` 等系统解析器可解析的形式，原 isPrivateTarget 的
 * `/^[\d.]+$/` 分支把它们当 IP 直传 isPrivateIp → 段数 ≠4 走 IPv6 分支 → 判为公网放行。
 * 规则（RFC 相关简写）：单段 = 32 位、两段 = 8+24、三段 = 8+8+16、四段 = 8×4。
 */
export function normalizeV4Shorthand(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const vals: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,10}$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    vals.push(n);
  }
  if (vals.length === 1) {
    const n = vals[0];
    if (n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  if (vals.length === 2) {
    const [a, b] = vals;
    if (a > 255 || b > 0xffffff) return null;
    return [a, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff];
  }
  if (vals.length === 3) {
    const [a, b, c] = vals;
    if (a > 255 || b > 255 || c > 0xffff) return null;
    return [a, b, (c >>> 8) & 0xff, c & 0xff];
  }
  const [a, b, c, d] = vals;
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  return [a, b, c, d];
}

/** 由 4 段归一化数值判断是否私有（含 0.x / 回环 / 10/8 / 172.16/12 / 192.168/16 / 链路本地 / CGNAT / 组播保留） */
function isPrivateV4Parts(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** v2.13：SSRF 防护——IP 是否私有/内网（回环/私网/链路本地/CGNAT/组播/文档段） */
function isPrivateIp(ip: string): boolean {
  const raw = ip.trim();
  // IPv6 规范化去括号
  const norm = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  // IPv4-mapped（::ffff:127.0.0.1 等）与 IPv4-compatible（::127.0.0.1）——提取尾部 v4 段复查
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(norm);
  if (mapped) {
    const parts = mapped[1].split(".").map(Number);
    return isPrivateV4Parts(parts);
  }
  if (!norm.includes(":")) {
    // IPv4：支持简写归一化（127.1 / 2130706433 / 0x7f000001 等）
    const parts = normalizeV4Shorthand(norm);
    if (parts) return isPrivateV4Parts(parts);
    // 非纯数字（含十六进制段 0x7f.0.0.1 / 八进制 0177.0.0.1）→ 保守拦截（fail-closed）
    if (/^[0-9a-fx.]+$/i.test(norm) && /\./.test(norm)) return true;
    return false;
  }
  // IPv6：未指定/回环 ::1/链路本地 fe80::/10/ULA fc00::/7/组播 ff00::/8
  return /^::$/.test(norm) || /^::1$/.test(norm) || /^fe80:/i.test(norm) || /^f[cd][0-9a-f]{2}:/i.test(norm) || /^ff[0-9a-f]{2}:/i.test(norm);
}

/** v2.13：URL 目标是否可访问（SSRF 防护——webfetch 为 low 自动放行，内网探测必须拦截；导出供测试） */
export async function isPrivateTarget(url: string): Promise<{ ok: boolean; reason: string }> {
  // 测试专用豁免（本地 HTTP mock 场景；默认不设）
  if (process.env.INFU_ALLOW_PRIVATE_URL === "1") return { ok: true, reason: "" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "URL 无效" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "仅支持 http/https URL" };
  // v3.1 审计修复：hostname 去 IPv6 括号；IPv4 简写（127.1/2130706433 等）本地归一化直接判定，
  // 不再依赖系统解析器（各平台 getaddrinfo 对简写支持不一致，且直传 isPrivateIp 曾漏检）
  const host = u.hostname;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  try {
    let ips: string[];
    if (!bare.includes(":") && normalizeV4Shorthand(bare)) {
      ips = [bare];
    } else {
      // lookup 需 { all: true } 才返回地址数组（否则单对象）
      ips = /^[\d.]+$/.test(bare) ? [bare] : (await lookup(bare, { all: true })).map((r) => r.address);
    }
    if (!ips.length) return { ok: false, reason: `无法解析主机名 ${host}` };
    for (const ip of ips) {
      if (isPrivateIp(ip)) return { ok: false, reason: `拒绝访问内网/本机地址（SSRF 防护）：${host}` };
    }
    return { ok: true, reason: "" };
  } catch {
    return { ok: false, reason: `无法解析主机名 ${host}` };
  }
}

/**
 * v2.10 重写 HTML → 纯文本：块级标签转换行（段落/标题/列表/表格/区块保持结构），
 * 行内标签转空格；实体解码；去多余空行——正文不再挤成一坨。
 */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr|li|tr|td|th|p|div|h[1-6]|table|ul|ol|section|article|header|footer|nav|blockquote|pre|form|dt|dd)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(Number(n)));
  return s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * v2.10 正文提取（readability 启发式）：优先 <article>/<main> 容器，
 * 其次 id/class 含 content|main|post|article|body 的 <div>，否则整页段落化。
 * 导航/页脚/侧栏混入问题大幅缓解。
 */
export function extractMain(html: string): string {
  for (const tag of ["article", "main"]) {
    const m = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "i").exec(html);
    if (m) return htmlToText(m[0]); // article/main 语义即正文，无需长度门槛
  }
  const divM = /<div[^>]*(?:id|class)=["'][^"']*(?:content|main|post|article|body)[^"']*["'][^>]*>[\s\S]*?<\/div>/i.exec(html);
  if (divM && divM[0].length > 500) return htmlToText(divM[0]);
  return htmlToText(html);
}

/** 联网门禁（v2.10 批 4：只读联网降 low——smart 档自动放行；confirm 档仍确认） */
async function netGuard(ctx: Parameters<typeof guard>[0], tool: string, desc: string): Promise<boolean> {
  return guard(ctx, tool, "low", desc);
}

/**
 * 单次 HTTP 抓取（超时/大小上限/状态校验；v2.10 编码探测——GBK/GB2312 中文页不再乱码）。
 * v3.0 审计修复（S5）：redirect 改手动逐跳跟踪——每跳重定向目标可经 checkRedirect 复查
 * （SSRF 防护只查初始 URL 曾被重定向绕过：https://公网 → http://127.0.0.1 或云元数据）。
 */
export async function fetchText(
  url: string,
  signal?: AbortSignal,
  opts?: { checkRedirect?: (url: string) => Promise<{ ok: boolean; reason?: string }> }
): Promise<{ ok: boolean; text: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let current = url;
  try {
    for (let hop = 0; hop < 6; hop++) {
      const resp = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": "InFu-Agent/1.0 (local; +https://github.com/infu)" },
        signal: controller.signal,
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) return { ok: false, text: "", error: `重定向缺少 Location（HTTP ${resp.status}）` };
        current = new URL(loc, current).href;
        if (opts?.checkRedirect) {
          const r = await opts.checkRedirect(current);
          if (!r.ok) return { ok: false, text: "", error: `重定向目标被拦截（SSRF 防护）：${r.reason}` };
        }
        continue;
      }
      if (!resp.ok) return { ok: false, text: "", error: `HTTP ${resp.status} ${resp.statusText}` };
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_BODY) return { ok: false, text: "", error: `响应过大（>${MAX_BODY >> 10}KB），已放弃抓取` };
      // 编码探测：Content-Type header 优先，其次 HTML <meta charset>；非 UTF-8 按声明解码（GBK 中文页）
      const ct = resp.headers.get("content-type") ?? "";
      let charset = /charset=([\w-]+)/i.exec(ct)?.[1] ?? null;
      if (!charset) {
        const head = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf).subarray(0, 4096));
        charset = /<meta[^>]*charset=["']?([\w-]+)/i.exec(head)?.[1] ?? null;
      }
      const enc = charset && !/utf-?8/i.test(charset) ? (charset.toLowerCase().includes("gb") ? "gbk" : charset) : "utf-8";
      const text = new TextDecoder(enc, { fatal: false }).decode(buf);
      return { ok: true, text };
    }
    return { ok: false, text: "", error: "重定向次数过多（>5）" };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "请求超时或已中止" : String(e?.message ?? e);
    return { ok: false, text: "", error: msg };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * v2.10 Bing RSS 搜索（免 Key 主后端——实测本网络环境 DuckDuckGo 全家不可达、Bing HTML
 * 含反爬 challenge 页，而 Bing `format=rss` 返回标准 XML 稳定可用）：
 * 解析 <item> 块（title/link/description），实体解码后纯文本化。
 */
export async function bingSearch(query: string, max: number): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT);
  try {
    const resp = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${max}`, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/rss+xml, text/xml, */*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await resp.text();
    const out: Array<{ title: string; url: string; text: string }> = [];
    const items = xml.split("<item>").slice(1);
    for (const it of items) {
      if (out.length >= max) break;
      const t = /<title>([\s\S]*?)<\/title>/.exec(it);
      const l = /<link>([\s\S]*?)<\/link>/.exec(it);
      const d = /<description>([\s\S]*?)<\/description>/.exec(it);
      const title = t ? htmlToText(t[1]).slice(0, 200) : "";
      const url = (l ? l[1].replace(/&amp;/g, "&").trim() : "").slice(0, 500);
      const text = d ? htmlToText(d[1]).slice(0, 500) : "";
      if (title || url) out.push({ title, url, text });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** DuckDuckGo Instant Answer（免 Key 保底）：返回 [{title, url, text}] */
export async function duckduckgoSearch(query: string, max: number): Promise<Array<{ title: string; url: string; text: string }>> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const r = await fetchText(url);
  if (!r.ok) throw new Error(r.error ?? "DuckDuckGo 搜索失败");
  try {
    const data = JSON.parse(r.text);
    const out: Array<{ title: string; url: string; text: string }> = [];
    const push = (t: any) => {
      if (out.length >= max) return;
      const title = t?.Text?.split(" - ")[0] ?? t?.FirstURL ?? "";
      const text = t?.Text ?? "";
      const link = t?.FirstURL ?? "";
      if (title || text) out.push({ title: String(title).slice(0, 200), url: String(link), text: String(text).slice(0, 500) });
    };
    // Abstract（信息卡）
    if (data?.AbstractText) out.push({ title: data.Abstract, url: data.AbstractURL ?? "", text: data.AbstractText });
    // RelatedTopics（含嵌套）
    const walk = (topics: any[]) => {
      for (const t of topics ?? []) {
        if (t?.Topics) walk(t.Topics);
        else if (t?.Text) push(t);
        if (out.length >= max) return;
      }
    };
    walk(data?.RelatedTopics ?? []);
    return out.slice(0, max);
  } catch {
    throw new Error("DuckDuckGo 返回无法解析");
  }
}

/**
 * v2.10 DuckDuckGo HTML 搜索（免 Key 真实结果）：解析 .result 块（标题/链接/摘要），
 * 链接为 DDG 重定向 → 解出真实 URL。反爬对策：浏览器 UA + Accept 头。
 * 这是社区免 Key 搜索的标配端点（duck-duck-scrape 同款）；Instant Answer 仅作保底。
 */
export async function duckduckgoHtmlSearch(query: string, max: number): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT);
  try {
    const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    const out: Array<{ title: string; url: string; text: string }> = [];
    // 结果块按 class="result 切分（DDG HTML 结构稳定多年）
    const blocks = html.split('class="result').slice(1);
    for (const b of blocks) {
      if (out.length >= max) break;
      const titleM = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
      if (!titleM) continue;
      let href = titleM[1].replace(/&amp;/g, "&");
      // DDG 重定向解包（//duckduckgo.com/l/?uddg=<url>）
      const uddg = /uddg=([^&]+)/.exec(href);
      if (uddg) {
        try { href = decodeURIComponent(uddg[1]); } catch { /* 保留原样 */ }
      }
      if (!/^https?:\/\//i.test(href)) continue;
      const title = htmlToText(titleM[2]).slice(0, 200);
      const snipM = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(b);
      const text = snipM ? htmlToText(snipM[1]).slice(0, 500) : "";
      if (title || href) out.push({ title, url: href, text });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** Tavily（质量更好；需 INFU_TAVILY_API_KEY） */
export async function tavilySearch(query: string, max: number, apiKey: string): Promise<Array<{ title: string; url: string; text: string }>> {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: max, search_depth: "basic" }),
    signal: AbortSignal.timeout(NET_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}`);
  const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    text: (r.content ?? "").slice(0, 500),
  }));
}

export const webTools: Record<string, ToolDef> = {
  webfetch: {
    name: "webfetch",
    description:
      "抓取一个网页/URL 的内容（转为纯文本，自动提取正文——导航/页脚会被过滤；中文页面自动识别编码）。用于查文档、看 API 说明、读取在线资源。只读操作自动执行（confirm 档位下需确认）。",
    // v2.10 批 4：只读拉取降 low（对齐 主流/主流自动执行）
    risk: "low",
    schema: z.object({
      url: z.string().describe("要抓取的 URL（http/https，公网地址）"),
      max_chars: z.number().int().min(500).max(20000).optional().describe("返回文本上限（默认 8000 字符）"),
    }),
    async execute(args, ctx) {
      // 执行端参数防御（模型可能传错类型——友好报错让模型自纠）
      if (typeof args.url !== "string" || !args.url.trim()) {
        return "错误：url 参数必须是字符串。请重新调用并给出要抓取的 URL。";
      }
      const url = args.url as string;
      if (!/^https?:\/\//i.test(url)) return "错误：仅支持 http/https URL";
      // v2.13：SSRF 防护——拒绝内网/回环/链路本地地址（127.0.0.0/8、10/8、172.16/12、
      // 192.168/16、169.254/16、::1、fc00::/7 等）；webfetch 为 low 自动放行，内网探测
      // 与云元数据（169.254.169.254）必须拦截
      const ssrf = await isPrivateTarget(url);
      if (!ssrf.ok) return `错误：${ssrf.reason}`;
      const maxChars = (typeof args.max_chars === "number" && args.max_chars >= 500 ? args.max_chars : 8000);
      if (!(await netGuard(ctx, "webfetch", `🌐 联网访问网页：${url}`))) {
        return "用户拒绝：未联网访问（InFu 默认断网，联网需人工审批放行）";
      }
      const r = await fetchText(url, ctx.abortSignal, {
        // v3.0 审计修复（S5）：重定向目标逐跳复查 SSRF（防 https://公网 → 内网/云元数据 绕过）
        checkRedirect: async (u) => isPrivateTarget(u),
      });
      if (!r.ok) return `抓取失败：${r.error}`;
      // v2.10：正文提取（article/main/content 容器优先；块级换行保持段落结构）
      const text = extractMain(r.text);
      if (!text) return "抓取成功但页面无可读文本内容（可能是 JS 渲染页面或纯图片）";
      return clip(`网页 ${url}：\n${text}`, maxChars);
    },
  },

  web_search: {
    name: "web_search",
    description:
      "搜索网络获取当前信息（超出训练数据截止时间/查找最新资料时用）。返回标题+链接+摘要列表。" +
      "只读操作自动执行（confirm 档位下需确认）。需要已知 URL 的内容时用 webfetch 更直接。",
    // v2.10 批 4：只读搜索降 low（对齐 主流/主流自动执行）
    risk: "low",
    schema: z.object({
      query: z.string().min(1).describe("搜索关键词（简洁聚焦）"),
      max_results: z.number().int().min(1).max(10).optional().describe("返回结果数（默认 5）"),
    }),
    async execute(args, ctx) {
      // 执行端参数防御（模型可能传错类型——友好报错让模型自纠）
      if (typeof args.query !== "string" || !args.query.trim()) {
        return "错误：query 参数必须是字符串。请重新调用并给出搜索关键词。";
      }
      const query = args.query as string;
      const max = (typeof args.max_results === "number" && args.max_results >= 1 ? Math.min(args.max_results, 10) : 5);
      if (!(await netGuard(ctx, "web_search", `🌐 联网搜索：${query}`))) {
        return "用户拒绝：未联网搜索（InFu 默认断网，联网需人工审批放行）";
      }
      try {
        const tavilyKey = process.env.INFU_TAVILY_API_KEY;
        let results: Array<{ title: string; url: string; text: string }> = [];
        if (tavilyKey?.trim()) {
          results = await tavilySearch(query, max, tavilyKey.trim());
        } else {
          // v2.10 后端链：Bing HTML（免 Key 主后端，本网络实测可达）→ DDG HTML → DDG Instant Answer 保底
          try {
            results = await bingSearch(query, max);
          } catch {
            try {
              results = await duckduckgoHtmlSearch(query, max);
            } catch {
              results = await duckduckgoSearch(query, max);
            }
          }
        }
        if (!results.length) return `未找到与 "${query}" 相关的结果（可尝试换关键词或加引号精确匹配）`;
        const lines = results.map((r, i) => `${i + 1}. ${r.title || "(无标题)"}\n   ${r.url}\n   ${r.text}`);
        return `搜索结果（${results.length} 条）：\n${lines.join("\n\n")}`;
      } catch (e) {
        return `搜索失败：${(e as Error).message}`;
      }
    },
  },
};
