/**
 * 审批策略（v2.4 设置界面）：全局档位 + 工具级覆盖 + 命令白名单
 *
 * 档位语义：
 *  - auto：非 requireExplicit 场景全自动放行（等价 CLI -y；联网放行/自注册等安全线永不豁免）
 *  - smart：低风险自动、中/高人工（v2.4 前的历史行为，默认）
 *  - confirm：全部人工确认（low 也弹窗）
 *
 * 工具覆盖：精确名 > 前缀* 通配 > 默认（按声明顺序首个命中生效；与 MCP riskOverrides 同模式）
 * 命令白名单：整命令 glob 匹配（* = 任意字符序列）；命中白名单的命令跳过高危命令审批；
 *            requireExplicit（联网放行）永不豁免——白名单不是网络放行
 */

import type { ApprovalMode, InfuConfig, RiskLevel, ToolRiskOverride } from "@infu/shared";
import { loadConfig } from "../providers/registry.js";

/** 解析后的完整策略（字段全部就位，调用方无 undefined 处理） */
export interface ResolvedApprovalPolicy {
  mode: ApprovalMode;
  toolOverrides: ToolRiskOverride[];
  commandAllowlist: string[];
}

/** 默认策略：smart 档位（low 自动、medium/high 人工）——历史行为 */
export const DEFAULT_POLICY: ResolvedApprovalPolicy = {
  mode: "smart",
  toolOverrides: [],
  commandAllowlist: [],
};

/**
 * v2.10 批 9 内置默认命令白名单（对齐主流 只读命令自动放行启发式）：
 * 只读查询 / git 只读 / 版本查询——绝对无副作用的子集（不放 cat/grep 读任意文件类，
 * 防 root 外信息泄露；不放写/网络/提交/代码执行）。用户配置追加合并（默认项不可删）。
 */
export const DEFAULT_COMMAND_ALLOWLIST: string[] = [
  // 元数据/查询
  "ls*", "pwd", "date", "whoami", "id", "uname*", "hostname", "which*", "type*", "env", "echo*", "df -h", "du*",
  // git 只读（分支/配置写操作不放——git branch 创建删除、git config 写 ~/.gitconfig 均走审批）
  "git status*", "git diff*", "git log*", "git show*", "git branch -a*", "git branch -r*",
  "git branch --show-current*", "git branch -l*", "git remote -v*", "git ls-files*",
  "git rev-parse*", "git blame*", "git stash list*", "git tag -l*", "git check-ignore*",
  "git config --get*", "git config --list*", "git config -l*", "git config --global --get*",
  // 版本查询（无网络/无副作用）
  "node --version*", "npm --version*", "pnpm --version*", "yarn --version*", "python --version*",
  "python3 --version*", "tsc --version*", "go version*", "cargo --version*", "rustc --version*", "java -version*",
  // 包本地查询（npm view 等联网查询仍被断网门禁拦截，不放）
  // v3.0 审计修复（S4）：npm run* 移除——`npm run <script>` 执行 package.json 任意脚本
  // （脚本可联网/任意代码），不再免审批；仅保留 `npm run`（无参数 = 只列出脚本，无副作用）
  "npm ls*", "pnpm ls*", "yarn list*", "pip list*", "pip show*", "go list*", "npm run",
];

/**
 * v2.13：shell 组合符检测（白名单放行的前提 = 单条只读命令）——
 * `git status && rm -rf x` 命中 git status* 白名单但实际执行 rm：组合符让"放行这条命令"
 * 变成"放行命令及其链式结果"，超出信任面 → 含组合符退回正常审批。
 */
const SHELL_COMBINATORS = /&&|\|\||;|\||>|<|`|\$\(|\n/;
export function hasShellCombinators(command: string): boolean {
  return SHELL_COMBINATORS.test(command);
}

/** 从配置解析审批策略（缺省节/字段回退默认值；v2.10 默认白名单与用户配置合并） */
export function resolveApprovalPolicy(cfg: InfuConfig | null | undefined): ResolvedApprovalPolicy {
  const p = cfg?.approvalPolicy;
  return {
    mode: p?.mode ?? DEFAULT_POLICY.mode,
    toolOverrides: p?.toolOverrides ?? [],
    commandAllowlist: [...DEFAULT_COMMAND_ALLOWLIST, ...(p?.commandAllowlist ?? [])],
  };
}

/** 当前配置的审批策略（每次读取——config 小文件，热生效；无配置 = 默认） */
export function currentApprovalPolicy(): ResolvedApprovalPolicy {
  return resolveApprovalPolicy(loadConfig());
}

/**
 * 档位决策：true=自动放行；null=需人工确认（不存在自动拒绝——拒绝只来自工具禁用）。
 * requireExplicit（联网放行/自注册等安全线）任何档位下都需人工——绝不自动放行。
 */
export function shouldAutoApprove(
  policy: ResolvedApprovalPolicy,
  risk: RiskLevel,
  requireExplicit?: boolean
): boolean | null {
  if (requireExplicit) return null;
  switch (policy.mode) {
    case "auto":
      return true;
    case "smart":
      return risk === "low" ? true : null;
    default: // confirm：全部人工（low 也人工）
      return null;
  }
}

/** 按声明顺序首个命中的覆盖项（精确名 或 前缀* 通配） */
export function matchOverride(
  tool: string,
  overrides: ToolRiskOverride[]
): ToolRiskOverride | undefined {
  return overrides.find((o) => {
    const p = o.tool.trim();
    return p === tool || (p.endsWith("*") && tool.startsWith(p.slice(0, -1)));
  });
}

/** 工具是否被策略禁用（对全部工具含 MCP/插件生效；loop 执行段统一拦截） */
export function isToolDisabled(tool: string, overrides: ToolRiskOverride[]): boolean {
  return matchOverride(tool, overrides)?.disabled === true;
}

/** 覆盖后的风险（未命中保留基础风险） */
export function resolveToolRisk(
  tool: string,
  baseRisk: RiskLevel,
  overrides: ToolRiskOverride[]
): RiskLevel {
  return matchOverride(tool, overrides)?.risk ?? baseRisk;
}

/** glob 模式 → 正则（仅支持 * 通配符，其余字符转义；大小写不敏感） */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** 命令是否命中白名单（整命令匹配，支持 * 通配符；空命令不命中） */
export function isCommandAllowed(command: string, allowlist: string[]): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  return allowlist.some((p) => {
    const pattern = p.trim();
    return pattern.length > 0 && globToRegExp(pattern).test(cmd);
  });
}
