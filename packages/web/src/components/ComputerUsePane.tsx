import { useEffect, useMemo, useState } from "react";
import { Monitor, MonitorUp, MousePointerClick, Keyboard, Move, AppWindow, ImageOff, ChevronDown } from "lucide-react";
import { useStore } from "../store";
import { apiFetch, apiUrl } from "../api";

const EMPTY_TRACE: import("@infu/shared").StoredEvent[] = [];

/**
 * computer-use 面板（v3.0 批 11：vision 底座 UI 落地）
 *  - 截图流：项目 .infu/screenshots/ 目录实时扫描，缩略图网格（点击放大查看）
 *  - 操作日志：当前会话的 screen_* 工具调用（截图/点击/输入）
 *  - 桌面版专属（Web 版无屏幕通道，显示提示）
 */
export default function ComputerUsePane() {
  const desktop = window.infuDesktop;
  const [shots, setShots] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  // Zustand selectors must return a stable empty value; allocating [] here causes React's
  // useSyncExternalStore snapshot loop and blanks the entire desktop-operation tab.
  const trace = useStore((s) => s.activeSessionId ? s.traceBySession[s.activeSessionId] ?? EMPTY_TRACE : EMPTY_TRACE);
  // v3.3 补 9：截图事件标记（screen_capture tool-result 到达 +1）+ 当前会话（切换会话也刷新）
  const shotTick = useStore((s) => s.screenShotTick);
  const activeSessionId = useStore((s) => s.activeSessionId);

  // 「有截图才刷新」——无轮询：面板打开/会话切换/Agent 实际截屏（screen_capture 完成事件）时
  // 各拉一次截图列表；没有截图就不做任何轮询（省资源）
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
    return () => { alive = false; };
  }, [desktop, shotTick, activeSessionId]);

  // The event ledger is durable. Show only the current task, starting from its last user message.
  const ops = useMemo(() => {
    const start = trace.map((row) => row.event.type).lastIndexOf("user-message");
    return trace.slice(start < 0 ? 0 : start + 1).flatMap(({ event }) => event.type === "tool-result" && event.tool.startsWith("screen_") ? [{ tool: event.tool, summary: event.summary, status: event.ok ? "ok" : "error" }] : []).map((item, index) => ({ ...item, round: index + 1 }));
  }, [trace]);
  const screenshotRounds = ops.filter((op) => op.tool === "screen_capture").map((op) => op.round);
  const openShot = (name: string) => {
    const root = useStore.getState().root;
    useStore.getState().openRightTab({
      id: `desktop-shot:${name}`,
      kind: "attachment",
      label: name,
      attachment: { name, kind: "image", preview: apiUrl(`/api/screenshots/file?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`) },
    });
    useStore.getState().setDetailsOpen(true);
  };

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
          本任务的桌面操作和截图证据。全权放行（full）档已自动允许 screen_* 操作。
        </div>
      </div>

      {/* 操作日志：折叠时只流动显示最近一条，展开后保留固定高度滚动区。 */}
      <div className="shrink-0 px-3 pt-2">
        <button className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-left text-xs font-medium text-sub hover:bg-hover" onClick={() => setLogsOpen((value) => !value)}>
          <span className="shrink-0">操作日志</span>
          {!logsOpen && ops.at(-1) && <span className="min-w-0 flex-1 truncate font-normal text-caption">第 {ops.at(-1)!.round} 步 · {ops.at(-1)!.tool} · {ops.at(-1)!.summary.slice(0, 44)}</span>}
          <ChevronDown className={`ml-auto h-3.5 w-3.5 transition-transform ${logsOpen ? "rotate-180" : ""}`} />
        </button>
        {ops.length === 0 ? (
          <div className="rounded-lg border border-line bg-hover/40 px-2.5 py-2 text-xs text-caption">
            暂无桌面操作（让 Agent 用 screen_capture 截图开始）
          </div>
        ) : logsOpen ? (
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-line bg-hover/25 p-1.5">
            {ops.slice().reverse().map((op) => (
              <div key={op.round} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-hover/60">
                {op.tool === "screen_capture" ? (
                  <MonitorUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                ) : op.tool === "screen_click" ? (
                  <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                ) : op.tool === "screen_move" ? (
                  <Move className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                ) : op.tool === "screen_drag" ? (
                  <Move className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                ) : op.tool === "screen_windows" ? (
                  <AppWindow className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                ) : op.tool === "screen_scroll" ? (
                  <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                ) : (
                  <Keyboard className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                )}
                <span className="min-w-0 flex-1 truncate text-sub">
                  <span className="mr-1 font-mono text-caption">{op.round}.</span><span className="font-medium text-text">{op.tool}</span> {op.summary.slice(0, 80)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* 截图流：紧凑纵向证据带，与 screen_capture 对应的操作轮次并列。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <div className="mb-1 text-xs font-medium text-sub">截图流（{shots.length}）</div>
        {shots.length === 0 ? (
          <div className="rounded-lg border border-line bg-hover/40 px-2.5 py-2 text-xs text-caption">
            暂无截图——Agent 调用 screen_capture 后自动出现在这里
          </div>
        ) : (
          <div className="space-y-1.5">
            {shots.map((name, index) => {
              const round = screenshotRounds[screenshotRounds.length - 1 - index];
              return (
              <button
                key={name}
                className="group flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg border border-line bg-hover/40 p-1 transition-colors hover:border-info/60"
                onClick={() => openShot(name)}
                title={name}
              >
                {/* v3.4 审计修复：apiUrl 拼 token query（生产模式裸 /api 被本地令牌 401——
                    此前桌面打包版截图预览全部失效）；加载失败显示占位，不挂空图 */}
                <ScreenshotThumb name={name} root={useStore.getState().root} />
                <span className="min-w-0 flex-1 text-left"><span className="block text-[11px] font-medium text-text">{round ? `第 ${round} 步截图` : "桌面截图"}</span><span className="block truncate text-[10px] text-caption">点击在工作区预览</span></span>
              </button>
            ); })}
          </div>
        )}
      </div>

    </div>
  );
}

/** 截图缩略图（加载失败显示占位图标——此前裸 /api img 失败时显示破图/空框） */
function ScreenshotThumb({ name, root }: { name: string; root: string }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
        <div className="flex h-11 w-16 shrink-0 items-center justify-center bg-hover/40">
        <ImageOff className="h-5 w-5 text-caption" />
      </div>
    );
  }
  return (
    <img
      src={apiUrl(`/api/screenshots/file?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`)}
      className="h-11 w-16 shrink-0 rounded object-cover"
      alt={name}
      loading="lazy"
      onError={() => setErr(true)}
    />
  );
}
