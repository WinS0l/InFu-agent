/**
 * 网络地址判定工具（@infu/shared）— SSRF / loopback 防护共享底座
 *
 * 背景（2026-08 审计修复）：原 isPrivateIp（tools/web.ts）与 isLoopbackTarget
 * （desktop main.ts）只识别 `::ffff:a.b.c.d` 点分形式与少数 IPv6 前缀正则，
 * 十六进制 IPv4-mapped（`::ffff:7f00:1` = 127.0.0.1）、IPv4-compatible
 * （`::7f00:1`，RFC 4291 弃用但主流解析器仍接受）、完整形式回环
 * （`0:0:0:0:0:0:0:1` = ::1）全部漏判 → SSRF 与 webview 导航守卫可被变体绕过。
 *
 * 修复思路：不做正则猜测——把 IPv6 文本**完整解包**为 8 组 u16（支持 `::`
 * 压缩与内嵌 IPv4），再按地址族语义判定；无法解析一律 fail-closed（保守拦截）。
 * 前端（agent webfetch SSRF）与桌面端（嵌入式浏览器导航守卫）共用同一实现，
 * agent 的测试套件可同时覆盖两处逻辑。
 */

/** IPv4 段判定：由 4 段数值判断是否私有/本机（0.x / 回环 / 10/8 / 172.16/12 /
 *  192.168/16 / 链路本地 / CGNAT / 组播保留） */
export function isPrivateV4Parts(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * IPv4 简写归一化：`127.1`（=127.0.0.1）、`2130706433`（32 位十进制）、
 * `127.0.1` 等系统解析器可解析的形式 → 4 段数值；无法解析返回 null。
 * 规则（RFC 相关简写）：单段 = 32 位、两段 = 8+24、三段 = 8+8+16、四段 = 8×4。
 * 前导零八进制变体（`0177.0.0.1`）fail-closed——parseInt 按十进制解析为 177
 * （判公网放行），而系统 inet_addr 按八进制解析为 127.0.0.1（SSRF 到本机）。
 */
export function normalizeV4(input: string): number[] | null {
  const parts = input.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const vals: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,10}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith("0")) return null; // 前导零八进制变体
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

const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

/**
 * 解析 IPv6 文本为 8 组 u16；失败返回 null。
 * 支持：`::` 压缩（单次）、内嵌 IPv4 尾部（`::ffff:127.0.0.1` → 展开为 2 组）、
 * 带方括号（`[::1]`）。无法解析（非法组/多个 `::`/组数不对）→ null。
 */
export function parseIpv6Groups(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":")) return null; // 不是 IPv6

  // 内嵌 IPv4 尾部（如 ::ffff:127.0.0.1 / ::ffff:7f00:1 的十进制尾部）→ 展开为两个 hex 组
  const v4m = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4m) {
    const parts = v4m[1].split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    const hi = (parts[0] << 8) | parts[1];
    const lo = (parts[2] << 8) | parts[3];
    s = s.slice(0, v4m.index) + hi.toString(16) + ":" + lo.toString(16);
  }

  const double = s.indexOf("::");
  if (double !== -1) {
    if (s.indexOf("::", double + 1) !== -1) return null; // 多个 ::
    const left = s.slice(0, double).split(":").filter((g) => g !== "");
    const right = s.slice(double + 2).split(":").filter((g) => g !== "");
    if (!left.every((g) => HEX_GROUP.test(g)) || !right.every((g) => HEX_GROUP.test(g))) return null;
    const l = left.map((g) => parseInt(g, 16));
    const r = right.map((g) => parseInt(g, 16));
    const pad = 8 - l.length - r.length;
    if (pad < 1) return null;
    return [...l, ...new Array<number>(pad).fill(0), ...r];
  }

  const groups = s.split(":");
  if (groups.length !== 8 || !groups.every((g) => HEX_GROUP.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * IPv6 是否内嵌 IPv4（IPv4-mapped `::ffff:a.b.c.d` / IPv4-compatible `::a.b.c.d`，
 * RFC 4291——后者已弃用但主流解析器仍接受，必须按 IPv4 复查）。
 * 返回内嵌的 IPv4 四段；非内嵌形式返回 null。
 */
export function ipv6EmbeddedV4(groups: number[]): number[] | null {
  // v3.8 审计修复：IPv6 回环（::1 及完整形式 0:0:0:0:0:0:0:1）低 32 位为 1，
  // 位模式上命中 IPv4-compatible 分支——但语义是 IPv6 回环地址而非内嵌 IPv4，
  // 必须排除（原实现使 net.test.ts「::1 非内嵌」断言失败，套件自创建起一直红）。
  // 消费者 isPrivateIpv6/isLoopbackHostText 均先查回环再查内嵌，此特判不改变行为。
  if (isLoopbackIpv6(groups)) return null;
  const v4 = (g6: number, g7: number): number[] => [
    (g6 >>> 8) & 0xff, g6 & 0xff,
    (g7 >>> 8) & 0xff, g7 & 0xff,
  ];
  // IPv4-mapped：前 80 位全 0，第 5-6 组 = 0xffff
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && groups[5] === 0xffff
  ) return v4(groups[6], groups[7]);
  // IPv4-compatible：前 96 位全 0（低 32 位即内嵌 IPv4）
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && groups[5] === 0) return v4(groups[6], groups[7]);
  return null;
}

/** IPv6 是否回环（::1 及其完整展开形式，如 0:0:0:0:0:0:0:1） */
export function isLoopbackIpv6(groups: number[]): boolean {
  return groups.slice(0, 7).every((n) => n === 0) && groups[7] === 1;
}

/** IPv6 是否未指定（::） */
export function isUnspecifiedIpv6(groups: number[]): boolean {
  return groups.every((n) => n === 0);
}

/** IPv6（解包后）私有/本机判定：未指定 / 回环 / 内嵌 IPv4 复查 / ULA fc00::/7 / 组播 ff00::/8 / 链路本地 fe80::/10 */
export function isPrivateIpv6(groups: number[]): boolean {
  if (isUnspecifiedIpv6(groups) || isLoopbackIpv6(groups)) return true;
  const v4 = ipv6EmbeddedV4(groups);
  if (v4) return isPrivateV4Parts(v4);
  const first = groups[0];
  return (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00 || (first & 0xffc0) === 0xfe80;
}

/** IPv6 文本 → 私有/本机判定；解析失败 fail-closed（保守拦截） */
export function isPrivateIpv6Text(input: string): boolean {
  const g = parseIpv6Groups(input);
  if (!g) return true;
  return isPrivateIpv6(g);
}

/**
 * 主机名/IP 文本 → 私有/本机判定（IPv4 简写归一化、IPv6 完整解包、hex/octal 段
 * fail-closed）。返回 null 表示无法判定（域名——需由调用方 DNS 解析后逐 IP 复查）。
 * `parts` 供调用方展示/测试用。
 */
export function isPrivateHostText(host: string): { private: boolean; parts?: number[] } | null {
  // v3.9 审计修复（M2）：FQDN 根标记尾点归一——`localhost.` / `127.0.0.1.` 与无尾点
  // 等价（系统解析器接受），原实现漏判导致桌面导航守卫/SSRF 可被 `localhost.` 绕过
  const h = host.trim().replace(/\.+$/, "");
  if (!h) return null;
  if (h.includes(":")) {
    // IPv6（含内嵌 IPv4 / 完整形式回环；解析失败 fail-closed）
    const g = parseIpv6Groups(h);
    if (!g) return { private: true };
    return { private: isPrivateIpv6(g) };
  }
  const parts = normalizeV4(h);
  if (parts) return { private: isPrivateV4Parts(parts), parts };
  // 非纯数字但含十六进制/八进制段（0x7f.0.0.1 / 0177.0.0.1）→ 保守拦截（fail-closed）
  // 仅含 hex 字符并不意味着数字 IP：例如合法域名 dead.beef。
  // 仍拦截明确的 hex/octal IPv4 形式。允许每段混用基数是系统解析器常见行为，
  // 因此 `0x7f.0.0.1` 与 `0177.0.0.1` 也必须 fail-closed；但 dead.beef 仍是域名。
  const labels = h.split(".");
  const hexV4 = labels.length >= 2 && labels.length <= 4 && labels.some((part) => /^0x[0-9a-f]+$/i.test(part)) && labels.every((part) => /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(part));
  const octalV4 = labels.length >= 2 && labels.length <= 4 && labels.some((part) => /^0[0-7]+$/.test(part)) && labels.every((part) => /^[0-9]+$/.test(part));
  if (hexV4 || octalV4) return { private: true };
  return null; // 域名
}

function isLoopbackV4(parts: number[]): boolean {
  return parts[0] === 127 || parts[0] === 0;
}

/**
 * 主机名/IP 文本是否回环/本机（127.0.0.0/8、0.0.0.0、::1、::、内嵌 IPv4 回环
 * （::ffff:7f00:1 / ::7f00:1 / ::ffff:127.0.0.1）、完整形式回环（0:0:0:0:0:0:0:1）、
 * localhost）。与 isPrivateHostText 的区别：不含局域网段（192.168/10/172.16 等）。
 * hex/octal 段（0x7f.0.0.1）无法判定 → fail-closed 视为回环。域名（非 localhost）→ false。
 */
export function isLoopbackHostText(host: string): boolean {
  // v3.9 审计修复（M2）：FQDN 根标记尾点归一（`localhost.` = localhost、`127.0.0.1.` = 127.0.0.1）
  const h = host.trim().toLowerCase().replace(/\.+$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.includes(":")) {
    const g = parseIpv6Groups(h);
    if (!g) return false; // 解析失败：非明确回环（调用方按自身策略决定 fail-open/closed）
    if (isUnspecifiedIpv6(g) || isLoopbackIpv6(g)) return true;
    const v4 = ipv6EmbeddedV4(g);
    return !!v4 && isLoopbackV4(v4);
  }
  const parts = normalizeV4(h);
  if (parts) return isLoopbackV4(parts);
  // hex/octal 段（0x7f.0.0.1 / 0177.0.0.1）→ 保守视为回环（fail-closed，与 isPrivateHostText 一致）
  if (/^[0-9a-fx.]+$/i.test(h) && h.includes(".")) return true;
  return false;
}
