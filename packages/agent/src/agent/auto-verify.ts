/**
 * v6.0（P1 S1）写后自动验证——写工具成功改动后自动运行测试，结果附在工具结果回填模型。
 *
 * 设计（与 run_test 语义对齐）：
 *  - 触发工具：write_file / edit_file / file_ops（改代码的动作；read/命令类不触发）
 *  - 自动检测测试框架（与 run_test 同款检测顺序：npm test / pytest / go test / cargo test）
 *  - 按「会话+根目录」去抖 60s：一次任务里连续多次写文件只跑一次，不拖慢节奏
 *  - 阶段限定 Executor / 直接模式（Planner/Reviewer 只读阶段不触发）
 *  - 开关 general.autoVerify（缺省 true；设置 → 常规 → 任务与通知）
 *  - 断网策略与 run_test 同门禁：外传命令按 egress 策略拦截（full 档放行，审计照常）
 *  - 失败静默（验证本身报错不阻塞写操作）；命令审计走 auditCommand（auto-verify 标记）
 */
import fs from "node:fs";
import path from "node:path";
import { execLocal, clip } from "../tools/util.js";
import { loadConfig } from "../providers/registry.js";
import { currentApprovalPolicy } from "../approval/policy.js";
import { detectEgress, egressBlockedMessage } from "../sandbox/net-policy.js";
import { isEgressAllowed } from "../egress-allow.js";
import { auditCommand } from "../sandbox/index.js";

/** 去抖窗口（ms）：同一会话同一根内写工具连续触发只跑一次 */
const DEBOUNCE_MS = 60_000;
/** 触发验证的写工具 */
const WRITE_TOOLS = new Set(["write_file", "edit_file", "file_ops"]);
/** 测试运行超时（与 run_test 一致） */
const VERIFY_TIMEOUT_MS = 300_000;
/** 验证结果回填裁剪（防止结果撑爆上下文） */
const VERIFY_RESULT_LIMIT = 3000;

interface VerifyState { at: number; cmd: string; }

/** 会话级去抖状态（v6.0：任务结束不清理——跨任务连续写仍受 60s 去抖保护，防短任务间重复跑） */
const verifyState = new Map<string, VerifyState>();

/** 测试框架自动检测（与 run_test 检测顺序一致；返回 null = 无框架） */
export function detectTestCommand(root: string): string | null {
  if (fs.existsSync(path.join(root, "package.json"))) return "npm test";
  if (
    fs.existsSync(path.join(root, "pyproject.toml")) ||
    fs.existsSync(path.join(root, "requirements.txt"))
  ) return "python -m pytest -q";
  if (fs.existsSync(path.join(root, "go.mod"))) return "go test ./...";
  if (fs.existsSync(path.join(root, "Cargo.toml"))) return "cargo test";
  return null;
}

/** 测试专用：清空去抖状态 */
export function resetAutoVerifyState(): void {
  verifyState.clear();
}

export interface AutoVerifyInput {
  tool: string;
  ok: boolean;
  /** 工具返回文本（错误文本跳过验证） */
  out: string;
  root: string;
  sessionId?: string;
  phase?: string;
  abortSignal?: AbortSignal;
}

export interface AutoVerification {
  command: string;
  status: "passed" | "failed";
  output: string;
}

export interface AutoVerifyResult {
  out: string;
  verification?: AutoVerification;
}

/**
 * 写后自动验证入口（loop.ts 工具执行后调用；返回原工具输出与真实验证记录）。
 * 判定条件不满足时保持原输出，且不生成验证记录。
 */
export async function maybeAutoVerify(input: AutoVerifyInput): Promise<AutoVerifyResult> {
  const cfg = loadConfig();
  // 缺省开；显式关才停
  if (cfg?.general?.autoVerify === false) return { out: input.out };
  if (!input.ok) return { out: input.out };
  if (!WRITE_TOOLS.has(input.tool)) return { out: input.out };
  // 写失败/被拒的结果文本不触发（工具以文本形式返回错误）
  if (/^(错误|用户拒绝|任务已停止)/.test(input.out)) return { out: input.out };
  if (input.phase === "planner" || input.phase === "reviewer") return { out: input.out };

  const key = `${input.sessionId ?? "cli"}::${path.resolve(input.root)}`;
  const now = Date.now();
  const state = verifyState.get(key);
  if (state && now - state.at < DEBOUNCE_MS) return { out: input.out };

  const cmd = detectTestCommand(input.root);
  if (!cmd) return { out: input.out };
  // 先占位再执行：验证耗时 > 去抖窗口也不会重入
  verifyState.set(key, { at: now, cmd });

  // 断网策略与 run_test 同门禁（外传测试命令拦截；full 档放行照常审计）
  const egress = detectEgress(cmd);
  if (egress) {
    if (currentApprovalPolicy().mode === "full") {
      auditCommand(input.root, cmd, true, "full 档全自主：写后自动验证断网放行", "egress-allowed-full");
    } else if (isEgressAllowed(input.sessionId ?? "")) {
      auditCommand(input.root, cmd, true, "会话级临时联网放行", "egress-allowed-temp");
    } else {
      auditCommand(input.root, cmd, false, egressBlockedMessage(egress), "egress-blocked");
      return { out: `${input.out}\n\n[自动验证] 测试命令含网络外传已被断网策略拦截（${egressBlockedMessage(egress)}），未执行` };
    }
  }

  try {
    const r = await execLocal(cmd, input.root, VERIFY_TIMEOUT_MS, input.abortSignal);
    auditCommand(input.root, cmd, r.ok, r.out, r.sandbox);
    const status = r.ok ? "通过" : "失败";
    const hint = r.ok
      ? ""
      : "（写后自动验证失败——请优先修复测试，设置 → 常规 → 任务与通知可关闭自动验证）";
    return {
      out: `${input.out}\n\n[自动验证] 已自动运行 ${cmd}：${status}${hint}\n${clip(r.out, VERIFY_RESULT_LIMIT)}`,
      verification: { command: cmd, status: r.ok ? "passed" : "failed", output: r.out },
    };
  } catch (e) {
    // 验证本身异常静默（不阻塞写操作结果）
    return { out: input.out };
  }
}
