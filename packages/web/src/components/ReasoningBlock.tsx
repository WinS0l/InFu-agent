import { useState } from "react";
import { Brain } from "lucide-react";

/**
 * 思考过程折叠行（v2.14 批 2 对齐 主流 ReasoningRow）：
 *  - 折叠态：图标 + 「思考」+ 摘要（第一行；运行中跟随最新一行）+ 扫光
 *  - 展开态：标题行**摘要消失**（只剩图标 + 标题），全文从下一行开始
 *  - hover：漂浮放大感（微上浮 + 放大 + 阴影）而非整行选中背景；图标颜色加深
 */
export default function ReasoningBlock({ text, running }: { text: string; running?: boolean }) {
  const [open, setOpen] = useState(false);
  const visible = text.trimEnd();
  const firstLine = visible.split("\n")[0] ?? "";
  const lastLine = visible.slice(visible.lastIndexOf("\n") + 1);
  const summary = running ? lastLine : firstLine;

  return (
    <div className={`my-1.5 rounded-lg ${running ? "glare-sweep" : ""}`} data-variant="think" data-state={running ? "running" : "ok"}>
      <button
        className="group/row flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-lg px-1 text-left transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-sub transition-all duration-150 group-hover/row:-translate-y-px group-hover/row:text-info">
          <Brain className="h-3.5 w-3.5" />
        </span>
        <span className="shrink-0 text-[14px] leading-6 text-text transition-all duration-150 group-hover/row:-translate-y-px group-hover/row:text-text">思考</span>
        <span className="dot-sep mx-2 shrink-0" />
        {/* v2.14 批 2：展开态摘要消失（全文在下一行）；折叠态保留一行摘要。
            hover：文字本身飘起（上浮 + 颜色加深）——命名组 group/row 防祖先 group 串扰（多行一起飘） */}
        {!open ? (
          <span className={`min-w-0 flex-1 truncate text-[14px] leading-6 transition-all duration-150 group-hover/row:-translate-y-px group-hover/row:text-text ${running ? "text-ongoing" : "text-sub"}`}>{summary}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
      </button>
      {open && (
        <div className="ml-[22px] max-h-64 overflow-y-auto whitespace-pre-wrap border-l border-line py-1 pl-3 text-[14px] leading-6 text-sub">
          {text}
        </div>
      )}
    </div>
  );
}
