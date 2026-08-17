import { useEffect, useState } from "react";
import { Monitor, MonitorUp, MousePointerClick, Keyboard, X } from "lucide-react";
import { useStore } from "../store";
import { apiFetch } from "../api";

/**
 * computer-use 面板（v3.0 批 11：vision 底座 UI 落地）
 *  - 截图流：项目 .infu/screenshots/ 目录实时扫描，缩略图网格（点击放大查看）
 *  - 操作日志：当前会话的 screen_* 工具调用（截图/点击/输入）
 *  - 桌面版专属（Web 版无屏幕通道，显示提示）
 */
export default function ComputerUsePane() {
  const desktop = window.infuDesktop;
  const [shots, setShots] = useState<string[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const messages = useStore((s) => s.messages);

  // 实时扫描截图目录（每 2s；Agent 截图后自动出现）
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    const scan = async () => {
      try {
        const res = await apiFetch(`/api/screenshots?root=${encodeURIComponent(useStore.getState().root)}`);
        if (!res.ok) return;
        const list = (await res.json()) as string[];
        // 批 12：截图按会话对应——文件名带 <sid8>- 前缀，过滤当前会话；无前缀（旧/无会话）不显示
        const sid = useStore.getState().activeSessionId;
        const prefix = sid ? sid.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8) + "-" : "__none__";
        const mine = list.filter((n) => n.startsWith(`screen-${prefix}`));
        if (alive) setShots(mine);
      } catch { /* 目录不存在/未就绪 */ }
    };
    scan();
    const t = setInterval(scan, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [desktop]);

  // 大图查看：Esc 关闭
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  // 当前会话的 screen_* 操作日志
  const ops = messages.flatMap((m) =>
    (m.tools ?? []).filter((t) => t.tool.startsWith("screen_")).map((t) => ({
      tool: t.tool,
      summary: t.summary ?? "",
      status: t.status,
    }))
  );

  if (!desktop) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Monitor className="h-8 w-8 text-sub" />
        <div className="text-[13px] font-medium text-text">computer-use</div>
        <div className="text-xs leading-5 text-caption">
          Agent 操控桌面的能力（截图 → 视觉理解 → 点击/输入）。
          <br />
          将在桌面版提供——当前 Web 版无屏幕访问通道。
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pt-3">
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-text">
          <Monitor className="h-4 w-4 text-info" />
          computer-use
        </div>
        <div className="mt-0.5 text-xs leading-5 text-caption">
          Agent 通过 screen_capture 截图观察桌面，screen_click / screen_type 执行操作（每次操作需审批）
        </div>
      </div>

      {/* 操作日志 */}
      <div className="shrink-0 px-3 pt-2">
        <div className="mb-1 text-xs font-medium text-sub">操作日志</div>
        {ops.length === 0 ? (
          <div className="rounded-lg border border-line bg-hover/40 px-2.5 py-2 text-xs text-caption">
            暂无桌面操作（让 Agent 用 screen_capture 截图开始）
          </div>
        ) : (
          <div className="space-y-1">
            {ops.slice(-6).reverse().map((op, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg border border-line bg-hover/40 px-2.5 py-1.5 text-xs">
                {op.tool === "screen_capture" ? (
                  <MonitorUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                ) : op.tool === "screen_click" ? (
                  <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                ) : (
                  <Keyboard className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                )}
                <span className="min-w-0 flex-1 truncate text-sub">
                  <span className="font-medium text-text">{op.tool}</span> {op.summary.slice(0, 60)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 截图流 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <div className="mb-1 text-xs font-medium text-sub">截图流（{shots.length}）</div>
        {shots.length === 0 ? (
          <div className="rounded-lg border border-line bg-hover/40 px-2.5 py-2 text-xs text-caption">
            暂无截图——Agent 调用 screen_capture 后自动出现在这里
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {shots.map((name) => (
              <button
                key={name}
                className="group cursor-pointer overflow-hidden rounded-lg border border-line bg-hover/40 transition-colors hover:border-info/60"
                onClick={() => setViewing(name)}
                title={name}
              >
                <img src={`/api/screenshots/file?root=${encodeURIComponent(useStore.getState().root)}&name=${encodeURIComponent(name)}`} className="h-20 w-full object-cover" alt={name} />
                <div className="truncate px-1.5 py-0.5 text-[10px] text-caption">{name.replace(/^screen-/, "").replace(/\.png$/, "")}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 大图查看（点击遮罩/×/Esc 关闭） */}
      {viewing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
          onClick={() => setViewing(null)}
        >
          <button
            className="absolute right-4 top-4 flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-white/20 bg-black/50 text-white/90 transition-colors hover:bg-black/70"
            onClick={() => setViewing(null)}
            title="关闭（Esc）"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={`/api/screenshots/file?root=${encodeURIComponent(useStore.getState().root)}&name=${encodeURIComponent(viewing)}`}
            className="max-h-full max-w-full rounded-xl border border-line shadow-lv3"
            alt={viewing}
          />
        </div>
      )}
    </div>
  );
}
