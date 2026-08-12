import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";

/** 思考过程折叠块（Claude Code 式：默认收起，点击展开完整推理） */
export default function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").slice(0, 60);

  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-line/60 bg-muted/30">
      <button
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-sub" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-sub" />
        )}
        <Brain className="h-3.5 w-3.5 shrink-0 text-warn" />
        <span className="text-[11px] font-medium text-sub">思考</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-sub/70">
            {preview}
            {text.length > 60 ? "…" : ""}
          </span>
        )}
        {text.length > 60 && (
          <span className="shrink-0 text-[10px] text-sub/50">{text.length} 字</span>
        )}
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-line/50 px-3 py-2 text-[11px] leading-relaxed text-sub/90 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
