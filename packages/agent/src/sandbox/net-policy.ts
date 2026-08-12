/**
 * 网络出站软控制策略（M6 收尾版）
 *
 * 背景：本机实测 OS 级按进程断网全部路线不可行（WFP 引擎拒绝 ALE_USER_ID、
 * LSA 特权数据库被加固删除 SeImpersonate/SeAssignPrimaryToken 且授不回去、
 * AppContainer 低盒 WithTokenW 1314、SYSTEM 辅助触发通道全被硬化封死、未装 Docker），
 * 详细结论见 docs/ROADMAP.md。M6 落地为应用层命令审计：
 *   - 外传命令（curl/wget/nc/ssh 等）默认拦截，提示改用 network=true 经人工审批放行
 *   - 该层可被绕过（非内核强制），属风险降低措施；OS 级断网请用 Docker L2（--network none）
 *
 * 语义：断网策略只在"命令级"生效——沙箱本体（受限令牌 + Job）仍是 OS 级（M5）。
 */

/** 外传工具（整词匹配；命令串中出现即视为外传意图） */
const EGRESS_TOOLS = [
  "curl",
  "wget",
  "wget2",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "sftp",
  "scp",
  "ftp",
  "rsync",
  "ssh",
  "socat",
  "aria2c",
  "axel",
  "openssl", // 仅 s_client/s_server 组合命中（见 EGRESS_PATTERNS）
];

/** 语言/脚本网络调用的高置信组合（避免单个工具名误报） */
const EGRESS_PATTERNS: RegExp[] = [
  /openssl\s+s_(client|server)/i,
  /(powershell|pwsh).{0,120}(Invoke-WebRequest|Invoke-RestMethod|DownloadFile|DownloadString|Net\.WebClient|WebRequest|Start-BitsTransfer|System\.Net\.Sockets)/i,
  /(python|py)(\s+-c|\s+-m\s+http|\s+[a-zA-Z_]+\.py).{0,120}(urllib|requests|http\.client|socket|ftplib|paramiko)/i,
  /(node|npx).{0,120}(\bhttps?\b|\bnet\b|\bhttp\b|\bws\b)\.(get|request|createConnection|connect)/i,
];

/** 转义正则元字符（工具名来自固定白名单，防御性处理） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 检测命令是否含外传意图。命中返回命中的工具/模式说明（供审计与提示），否则 null。
 * 匹配规则：工具名整词（前面是命令边界：空格/管道/分号/&&/||/括号），
 * 如 `git push` 不受影响（无 curl 等工具名），`echo curl` 会命中（保守）。
 */
export function detectEgress(command: string): string | null {
  for (const tool of EGRESS_TOOLS) {
    if (tool === "openssl") continue; // 仅组合模式（本地密钥操作不应误伤）
    // 整词 + 排除工具变体前缀（ssh-keygen/ssh-add 等）：词尾不能紧跟连字符
    const re = new RegExp(`(^|[\\s&|;>([])${escapeRe(tool)}\\b(?!-)`, "i");
    if (re.test(command)) return tool;
  }
  for (const p of EGRESS_PATTERNS) {
    if (p.test(command)) return `模式 ${p.source.slice(0, 60)}`;
  }
  return null;
}

/** 断网拦截提示（统一文案，审计与展示共用） */
export function egressBlockedMessage(tool: string): string {
  return `⚠ 出站网络被断网策略拦截（检测到外传工具：${tool}）。确需联网请用 network=true 经人工审批放行（该命令未执行）`;
}
