import { FileText, Image as ImageIcon, X } from "lucide-react";

/** v3.1 附件草稿（发送前状态；File 对象仅内存，不持久化） */
export interface AttachmentDraft {
  id: string;
  name: string;
  /** 显示路径（文件夹内文件带目录结构 webkitRelativePath；单文件 = 文件名） */
  rel: string;
  size?: number;
  file?: File;
  /** 图片预览（dataURL；图片附件发送走视觉） */
  dataUrl?: string;
  /** v3.0 批 12：桌面版真实路径引用（系统对话框选择；不复制内容） */
  path?: string;
}

function fmtSize(n?: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 附件选择限制（对齐主流：单文件 2MB、文件夹内文件同样限；图片 5MB） */
export const ATTACH_LIMITS = {
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  MAX_FILES: 20,
} as const;

/**
 * v3.1 附件预览条（输入卡上方）：文件卡片（图标+路径+大小）与图片缩略图，
 * hover 显示移除；发送后清空，历史重放时由消息内附件行展示（非本组件）。
 */
export default function AttachmentRail({
  items,
  onRemove,
}: {
  items: AttachmentDraft[];
  onRemove: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mx-auto mb-2 flex max-w-[780px] flex-wrap items-center gap-1.5">
      {items.map((a) => (
        <div
          key={a.id}
          className="group flex max-w-[260px] items-center gap-1.5 rounded-xl border border-line bg-elevated py-1 pl-1.5 pr-1 text-[13px] text-text"
          title={a.rel}
        >
          {a.dataUrl ? (
            <img src={a.dataUrl} alt={a.name} className="h-6 w-6 shrink-0 rounded-md object-cover" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0 text-sub" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {a.rel}
            {a.size ? <span className="ml-1 text-xs text-caption">{fmtSize(a.size)}</span> : null}
          </span>
          <button
            className="shrink-0 cursor-pointer rounded-md p-0.5 text-caption opacity-0 transition-opacity hover:bg-hover hover:text-danger group-hover:opacity-100"
            onClick={() => onRemove(a.id)}
            title="移除附件"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 附件行渲染（消息内：重放/实时附件展示） */
export function AttachmentLine({ items }: { items: Array<{ name: string; kind: string; size?: number }> }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1.5">
      {items.map((a, i) => (
        <span
          key={i}
          className="flex items-center gap-1 rounded-md bg-hover/70 px-1.5 py-0.5 text-xs text-sub"
          title={a.kind === "image" ? "图片（已发送给模型查看）" : ""}
        >
          {a.kind === "image" ? (
            <ImageIcon className="h-3 w-3 shrink-0 text-info" />
          ) : (
            <FileText className="h-3 w-3 shrink-0 text-sub" />
          )}
          <span className="max-w-[220px] truncate">{a.name}</span>
        </span>
      ))}
    </div>
  );
}
