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
  // v3.1 审计修复：补全绕过面——Windows 自带下载器 / DNS 外传 / 云存储同步。
  // python3/py 不加入工具名单（本地脚本运行会误报），由 EGRESS_PATTERNS 组合模式覆盖
  "certutil",
  "bitsadmin",
  "mshta",
  "regsvr32",
  "nslookup",
  "rclone",
  "s3cmd",
  "gsutil",
  "azcopy",
  "iperf",
  "iperf3",
  "lwp-request",
  "lwp-download",
  // v3.5 审计修复（H7 收口）：PowerShell 别名 iwr/irm（Invoke-WebRequest/RestMethod
  // 的最短写法，此前 `iwr http://x` 完全绕过断网策略）
  "iwr",
  "irm",
];

/** 语言/脚本网络调用的高置信组合（避免单个工具名误报） */
const EGRESS_PATTERNS: RegExp[] = [
  /openssl\s+s_(client|server)/i,
  /(powershell|pwsh)[\s\S]*(Invoke-WebRequest|Invoke-RestMethod|DownloadFile|DownloadString|Net\.WebClient|WebRequest|Start-BitsTransfer|System\.Net\.Sockets|curl|wget)/i,
  /(python|python3|py)(\s+-c|\s+-m\s+http|\s+[a-zA-Z_]+\.py)[\s\S]*(urllib|requests|http\.client|socket|ftplib|paramiko)/i,
  /(node|npx|deno|bun)[\s\S]*(\bhttps?\b|\bnet\b|\bhttp\b|\bws\b)\.(get|request|createConnection|connect)/i,
  // v3.9 审计修复（M4）：补版本管理/包管理器/wsl 外传面——git push/fetch/clone 直连远程、
  // npm/pip install 拉包、wsl 启动 Linux 环境联网、PowerShell -enc 编码命令（可隐藏
  // 任意网络调用）此前全部漏检。git status/diff 等本地只读操作不受影响（组合模式只
  // 匹配 push/fetch/clone 等外传动词）
  // v4.0 审计修复：参数位置绕过——`git -C <dir> push` / `git --git-dir=/x fetch` /
  // `npm --prefix /x install` 的动词不紧贴工具名，原模式漏检。改为允许任意 `-flag [值]`
  // 选项前缀（非 -flag 的普通参数不吞，`git status` / `npm run` 不受影响）
  /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*(push|fetch|clone|pull|remote\s+add|submodule\s+update)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(?:-\S+(?:\s+\S+)?\s+)*(install|add|ci|update|publish)\b/i,
  /\b(pip|pip3|pipx)\s+(?:-\S+(?:\s+\S+)?\s+)*install\b/i,
  /\b(powershell|pwsh)[\s\S]*-enc/i,
  /\bwsl\b/i,
  // v3.5 审计修复（H7）：裸 fetch( / Invoke-* 全称无前缀组合（node fetch 全局 /
  // PS 全名与别名无 powershell 前缀的直呼写法）——断网策略保守侧（echo 类文本命中可接受）
  /fetch\s*\(/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b/i,
  // Windows 内置下载/外传通道（v3.1 补全）
  /certutil\s+-(urlcache|decode\s+-f|download)/i,
  /bitsadmin\s+\/transfer/i,
  /regsvr32\s+\/(s|i):?https?:/i,
  /mshta\s+https?:/i,
  /curl\.exe|wget\.exe|powershell\.exe/i,
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
  // cmd.exe permits caret escaping (`c^url`) and quoted executable names.
  // Normalize only those shell spellings before applying conservative detection.
  const normalized = command.replace(/\^(.)/g, "$1").replace(/["']/g, "");
  for (const tool of EGRESS_TOOLS) {
    if (tool === "openssl") continue; // 仅组合模式（本地密钥操作不应误伤）
    // 整词 + 排除工具变体前缀（ssh-keygen/ssh-add 等）：词尾不能紧跟连字符
    const re = new RegExp(`(^|[\\s&|;>([])${escapeRe(tool)}\\b(?!-)`, "i");
    if (re.test(normalized)) return tool;
  }
  for (const p of EGRESS_PATTERNS) {
    if (p.test(normalized)) return `模式 ${p.source.slice(0, 60)}`;
  }
  return null;
}

/** 断网拦截提示（统一文案，审计与展示共用） */
export function egressBlockedMessage(tool: string): string {
  return `⚠ 出站网络被断网策略拦截（检测到外传工具：${tool}）。确需联网请用 network=true 经人工审批放行（该命令未执行）`;
}
