import { useRef, useState } from "react";
import { FileText, Image as ImageIcon, Folder, HardDrive, Minus, Plus, RotateCcw } from "lucide-react";
import { useStore } from "../store";

function fmtSize(size?: number) {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** A sent attachment remains a first-class workspace tab without changing the empty workspace. */
export default function AttachmentPreviewPane() {
  const attachment = useStore((s) => s.rightTabs.find((tab) => tab.id === s.activeRightTab)?.attachment);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  if (!attachment) return null;
  const Icon = attachment.kind === "image" ? ImageIcon : attachment.kind === "dir" ? Folder : FileText;
  const resetImage = () => { setScale(1); setOffset({ x: 0, y: 0 }); };
  const changeScale = (delta: number) => setScale((current) => Math.max(0.25, Math.min(4, Number((current + delta).toFixed(2)))));
  return <div className="flex h-full min-h-0 flex-col bg-base">
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
      <Icon className="h-4 w-4 shrink-0 text-info" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text" title={attachment.name}>{attachment.name}</span>
      {attachment.size != null && <span className="shrink-0 text-[11px] text-caption">{fmtSize(attachment.size)}</span>}
    </div>
    {attachment.kind === "image" && attachment.preview ? (
      <div className="relative min-h-0 flex-1 overflow-hidden bg-code">
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-line bg-elevated/95 p-1 shadow-lv2">
          <button className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-sub hover:bg-hover hover:text-text" onClick={() => changeScale(-0.25)} title="缩小"><Minus className="h-3.5 w-3.5" /></button>
          <button className="min-w-12 cursor-pointer rounded-md px-1.5 py-1 text-[11px] text-sub hover:bg-hover hover:text-text" onClick={resetImage} title="重置缩放与位置">{Math.round(scale * 100)}%</button>
          <button className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-sub hover:bg-hover hover:text-text" onClick={() => changeScale(0.25)} title="放大"><Plus className="h-3.5 w-3.5" /></button>
          <button className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-sub hover:bg-hover hover:text-text" onClick={resetImage} title="重置"><RotateCcw className="h-3.5 w-3.5" /></button>
        </div>
        <div
          className={`flex h-full w-full items-center justify-center ${scale > 1 ? "cursor-grab" : "cursor-default"} ${drag.current ? "cursor-grabbing" : ""}`}
          onWheel={(event) => { event.preventDefault(); changeScale(event.deltaY < 0 ? 0.15 : -0.15); }}
          onPointerDown={(event) => {
            if (scale <= 1) return;
            drag.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            setOffset({ x: drag.current.offsetX + event.clientX - drag.current.x, y: drag.current.offsetY + event.clientY - drag.current.y });
          }}
          onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { drag.current = null; }}
        >
          <img src={attachment.preview} alt={attachment.name} draggable={false} className="max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] select-none rounded-lg border border-line object-contain shadow-lv2" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transition: drag.current ? "none" : "transform 120ms ease" }} />
        </div>
      </div>
    ) : attachment.kind === "file" && attachment.contentPreview != null ? (
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[12px] leading-5 text-text/85">{attachment.contentPreview}</pre>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-hover text-sub"><HardDrive className="h-5 w-5" /></span>
        <div className="text-[13px] font-medium text-text">{attachment.name}</div>
        <div className="max-w-[300px] text-xs leading-5 text-sub">{attachment.kind === "dir" ? "已附加文件夹。Agent 可在任务中读取其中的文件。" : "已附加文件。为保护本地文件内容，工作区仅显示元数据。"}</div>
      </div>
    )}
  </div>;
}
