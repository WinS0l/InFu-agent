/**
 * v3.6 网络地址判定回归测试（@infu/shared net.ts）
 * 覆盖：IPv4 简写归一化 / IPv6 完整解包（IPv4-mapped hex、IPv4-compatible、
 * 完整形式回环）/ hex-octal fail-closed / isLoopbackHostText 与 isPrivateHostText 语义差异。
 * 运行：npx tsx packages/agent/tests/net.test.ts
 */
import {
  normalizeV4,
  parseIpv6Groups,
  isPrivateHostText,
  isLoopbackHostText,
  ipv6EmbeddedV4,
  isLoopbackIpv6,
} from "@infu/shared";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("\n=== 网络地址判定（net.ts）自测 ===\n");

// ── normalizeV4：IPv4 简写归一化 ──
console.log("▶ normalizeV4（IPv4 简写）");
check("127.0.0.1 原样", JSON.stringify(normalizeV4("127.0.0.1")) === JSON.stringify([127, 0, 0, 1]));
check("127.1 简写（=127.0.0.1）", JSON.stringify(normalizeV4("127.1")) === JSON.stringify([127, 0, 0, 1]));
check("2130706433 单段 32 位十进制（=127.0.0.1）", JSON.stringify(normalizeV4("2130706433")) === JSON.stringify([127, 0, 0, 1]));
check("0x7f000001 十六进制拒绝（非数字）", normalizeV4("0x7f000001") === null);
check("0177.0.0.1 前导零八进制拒绝（fail-closed）", normalizeV4("0177.0.0.1") === null);
check("127.0.1 三段简写（=127.0.0.1）", JSON.stringify(normalizeV4("127.0.1")) === JSON.stringify([127, 0, 0, 1]));
check("192.168.1.1", JSON.stringify(normalizeV4("192.168.1.1")) === JSON.stringify([192, 168, 1, 1]));
check("非法段 999.1.1.1 拒绝", normalizeV4("999.1.1.1") === null);
check("非 IP 文本拒绝", normalizeV4("example.com") === null);

// ── parseIpv6Groups：IPv6 完整解包 ──
console.log("\n▶ parseIpv6Groups（IPv6 解包）");
check("::1 解包", JSON.stringify(parseIpv6Groups("::1")) === JSON.stringify([0, 0, 0, 0, 0, 0, 0, 1]));
check("完整形式回环 0:0:0:0:0:0:0:1", JSON.stringify(parseIpv6Groups("0:0:0:0:0:0:0:1")) === JSON.stringify([0, 0, 0, 0, 0, 0, 0, 1]));
check("带括号 [::1]", JSON.stringify(parseIpv6Groups("[::1]")) === JSON.stringify([0, 0, 0, 0, 0, 0, 0, 1]));
check("::ffff:7f00:1（hex IPv4-mapped）", JSON.stringify(parseIpv6Groups("::ffff:7f00:1")) === JSON.stringify([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x1]));
check("::7f00:1（IPv4-compatible）", JSON.stringify(parseIpv6Groups("::7f00:1")) === JSON.stringify([0, 0, 0, 0, 0, 0, 0x7f00, 0x1]));
check("::ffff:127.0.0.1（点分内嵌）", JSON.stringify(parseIpv6Groups("::ffff:127.0.0.1")) === JSON.stringify([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x1]));
check("fe80::1 解包", JSON.stringify(parseIpv6Groups("fe80::1")) === JSON.stringify([0xfe80, 0, 0, 0, 0, 0, 0, 1]));
check("多个 :: 拒绝", parseIpv6Groups("1::2::3") === null);
check("非法组拒绝", parseIpv6Groups("gggg::1") === null);
check("组数不对拒绝", parseIpv6Groups("1:2:3") === null);

// ── ipv6EmbeddedV4：内嵌 IPv4 提取 ──
console.log("\n▶ ipv6EmbeddedV4（内嵌 IPv4）");
check("::ffff:7f00:1 → 127.0.0.1", JSON.stringify(ipv6EmbeddedV4(parseIpv6Groups("::ffff:7f00:1")!)) === JSON.stringify([127, 0, 0, 1]));
check("::7f00:1 → 127.0.0.1", JSON.stringify(ipv6EmbeddedV4(parseIpv6Groups("::7f00:1")!)) === JSON.stringify([127, 0, 0, 1]));
check("::ffff:8.8.8.8 → 8.8.8.8", JSON.stringify(ipv6EmbeddedV4(parseIpv6Groups("::ffff:8.8.8.8")!)) === JSON.stringify([8, 8, 8, 8]));
check("::1 非内嵌", ipv6EmbeddedV4(parseIpv6Groups("::1")!) === null);
check("fe80::1 非内嵌", ipv6EmbeddedV4(parseIpv6Groups("fe80::1")!) === null);

// ── isPrivateHostText：私有/本机判定（SSRF 语义）──
console.log("\n▶ isPrivateHostText（SSRF 私有判定）");
const priv = (h: string) => isPrivateHostText(h)?.private === true;
const pub = (h: string) => isPrivateHostText(h)?.private === false;
check("127.0.0.1 私有", priv("127.0.0.1"));
check("127.1 简写私有", priv("127.1"));
check("2130706433 十进制私有", priv("2130706433"));
check("0177.0.0.1 八进制 fail-closed 私有", priv("0177.0.0.1"));
check("0x7f.0.0.1 hex 段 fail-closed 私有", priv("0x7f.0.0.1"));
check("10.0.0.5 私有", priv("10.0.0.5"));
check("192.168.1.1 私有", priv("192.168.1.1"));
check("169.254.169.254 云元数据私有", priv("169.254.169.254"));
check("8.8.8.8 公网", pub("8.8.8.8"));
check("::1 私有", priv("::1"));
check("完整形式 0:0:0:0:0:0:0:1 私有", priv("0:0:0:0:0:0:0:1"));
check("::ffff:7f00:1（hex IPv4-mapped）私有", priv("::ffff:7f00:1"));
check("::7f00:1（IPv4-compatible）私有", priv("::7f00:1"));
check("::ffff:127.0.0.1 私有", priv("::ffff:127.0.0.1"));
check("fe80::1 链路本地私有", priv("fe80::1"));
check("fc00::1 ULA 私有", priv("fc00::1"));
check("ff02::1 组播私有", priv("ff02::1"));
check("公网 IPv6 2001:4860:4860::8888 非私有", pub("2001:4860:4860::8888"));
check("公网 IPv6 hex mapped ::ffff:8.8.8.8 非私有", pub("::ffff:8.8.8.8"));
check("域名返回 null（需 DNS）", isPrivateHostText("example.com") === null);

// ── isLoopbackHostText：回环/本机判定（桌面导航守卫语义）──
console.log("\n▶ isLoopbackHostText（回环判定，不含局域网）");
const lb = (h: string) => isLoopbackHostText(h) === true;
const nlb = (h: string) => isLoopbackHostText(h) === false;
check("localhost 回环", lb("localhost"));
check("sub.localhost 回环", lb("foo.localhost"));
check("127.0.0.1 回环", lb("127.0.0.1"));
check("127.1 简写回环", lb("127.1"));
check("0.0.0.0 回环语义", lb("0.0.0.0"));
check("::1 回环", lb("::1"));
check("完整形式 0:0:0:0:0:0:0:1 回环", lb("0:0:0:0:0:0:0:1"));
check("::ffff:7f00:1 回环（hex IPv4-mapped）", lb("::ffff:7f00:1"));
check("::7f00:1 回环（IPv4-compatible）", lb("::7f00:1"));
check("::ffff:127.0.0.1 回环", lb("::ffff:127.0.0.1"));
check("0x7f.0.0.1 hex 段 fail-closed 回环", lb("0x7f.0.0.1"));
check("192.168.1.1 非回环（局域网）", nlb("192.168.1.1"));
check("10.0.0.5 非回环", nlb("10.0.0.5"));
check("8.8.8.8 非回环", nlb("8.8.8.8"));
check("example.com 非回环（域名）", nlb("example.com"));
check("公网 IPv6 非回环", nlb("2001:4860:4860::8888"));

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed ? 1 : 0);
