import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, X } from "lucide-react";

/* ═══ v3 UI 打磨：共享原语（对齐 deepseek-主流 的 Button/Modal/Toggle/StateDot/DisclosureRow/CodeBlock）═══ */

/** 复制到剪贴板（带 1.5s 成功反馈） */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* 剪贴板不可用时静默 */
        }
      }}
      title="复制"
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/**
 * 统一弹窗：遮罩（主题遮罩 + blur2px）+ r24 卡片 + 头部（标题/副标题/关闭）+ 底部胶囊按钮行。
 * 默认 Esc 关闭；遮罩点击关闭可关（审批类传入 maskClosable=false）。
 */
export function Modal({
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  width = 420,
  height,
  maskClosable = true,
  escClose = true,
  showClose = true,
}: {
  onClose: () => void;
  title?: ReactNode;
  subtitle?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** 固定高度（如 "min(720px, 90vh)"；缺省自适应内容） */
  height?: string;
  maskClosable?: boolean;
  /** Esc 关闭（审批类关键操作可关闭，防止误触） */
  escClose?: boolean;
  /** 头部关闭按钮 */
  showClose?: boolean;
}) {
  useEffect(() => {
    if (!escClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, escClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "var(--mask)" }}
      onMouseDown={(e) => {
        if (maskClosable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[calc(100vh-48px)] flex-col overflow-hidden rounded-3xl border border-line bg-elevated shadow-lv3"
        style={{ width: `min(${width}px, 92vw)`, ...(height ? { height } : {}) }}
      >
        {title !== undefined && (
          <div className="flex items-center gap-3 px-6 pb-3 pt-5">
            {icon}
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-medium leading-6 text-text">{title}</div>
              {subtitle && <div className="text-xs leading-[18px] text-sub">{subtitle}</div>}
            </div>
            {showClose && (
              <button
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sub transition-colors hover:bg-hover hover:text-text"
                onClick={onClose}
                title={escClose ? "关闭（Esc）" : "关闭"}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

/** 胶囊按钮（主流 规格：md h36 r18 / sm h28 r14；主按钮 = 中性灰近墨/近白） */
const BTN_SIZE = {
  md: "h-9 rounded-[18px] px-3.5 text-sm gap-1.5",
  sm: "h-7 rounded-[14px] px-2.5 text-[13px] gap-1",
};
const BTN_VARIANT = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  ghost: "text-text hover:bg-hover",
  outline: "border border-line bg-transparent text-text hover:bg-hover",
  danger: "border border-line bg-transparent text-danger hover:border-danger/50 hover:bg-danger-soft",
  dangerPrimary: "bg-danger text-white hover:brightness-110",
};
export function CapsuleButton({
  variant = "ghost",
  size = "md",
  disabled,
  className = "",
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BTN_VARIANT;
  size?: keyof typeof BTN_SIZE;
}) {
  return (
    <button
      disabled={disabled}
      className={`inline-flex cursor-pointer items-center justify-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BTN_SIZE[size]} ${BTN_VARIANT[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** 开关（主流 中性灰：开 = 主色轨道，关 = 边框色轨道） */
export function Toggle({
  checked,
  onChange,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-8 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-primary" : "bg-line"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full transition-all ${
          checked ? "left-[18px] bg-primary-fg" : "left-0.5 bg-sub"
        }`}
      />
    </button>
  );
}

/** 状态点（主流：实心核 + 0.1 透明度光晕；ongoing 可脉冲） */
const DOT_STYLE: Record<string, string> = {
  success: "bg-success",
  error: "bg-danger",
  warn: "bg-warn",
  ongoing: "bg-ongoing",
  stop: "bg-sub",
};
export function StateDot({ status, pulse }: { status: keyof typeof DOT_STYLE; pulse?: boolean }) {
  return (
    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
      <span className={`absolute inset-0 rounded-full opacity-10 ${DOT_STYLE[status] ?? DOT_STYLE.stop}`} />
      <span className={`h-2 w-2 rounded-full ${DOT_STYLE[status] ?? DOT_STYLE.stop} ${pulse ? "animate-pulse" : ""}`} />
    </span>
  );
}

/**
 * 折叠行（主流 DisclosureRow）：24px 高——图标 + 标题 + 2×2 点分隔 + 省略摘要 + 展开箭头。
 * 运行中自动扫光（glare-sweep）；展开内容按 22px 缩进。思考/工具/上下文行共用。
 */
export function DisclosureRow({
  icon,
  title,
  summary,
  running,
  open,
  onToggle,
  children,
  indent = 0,
}: {
  icon?: ReactNode;
  title: string;
  summary?: string;
  running?: boolean;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
  indent?: number;
}) {
  return (
    <div className={running ? "glare-sweep rounded-md" : ""}>
      <button
        className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md text-left transition-colors hover:bg-hover"
        style={{ paddingLeft: indent * 22, paddingRight: 4 }}
        onClick={onToggle}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-sub transition-transform ${open ? "rotate-90" : ""}`}
        />
        {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center text-sub">{icon}</span>}
        <span className="shrink-0 text-sm font-medium leading-6 text-text">{title}</span>
        {summary && (
          <>
            <span className="dot-sep mx-0.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm leading-6 text-sub">{summary}</span>
          </>
        )}
      </button>
      {open && <div className="ml-[22px]">{children}</div>}
    </div>
  );
}

/** 代码/输出卡片（主流 CodeBlock：r12 无边框 + 粘性标签头 + 等宽滚动体） */export function CodeBlock({
  label,
  text,
  maxHeight = 160,
  className = "",
}: {
  label?: string;
  text: string;
  maxHeight?: number;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden rounded-xl bg-code-block ${className}`}>
      {label !== undefined && (
        <div className="sticky top-0 z-10 flex items-center justify-between bg-code-banner px-3.5 py-2">
          <span className="min-w-0 truncate font-mono text-xs leading-[18px] text-text">{label}</span>
          <CopyButton
            text={text}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sub transition-colors hover:text-text"
          />
        </div>
      )}
      <pre
        className="overflow-auto whitespace-pre-wrap break-all px-4 pb-4 font-mono text-[13px] leading-[22px] text-text"
        style={{ maxHeight }}
      >
        {text}
      </pre>
    </div>
  );
}
