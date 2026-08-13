import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import { fetchModels, sendChat, fetchSessions, fetchSessionEvents, maybeMigrateV1, fetchConfig } from "./api";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import DiffPanel from "./components/DiffPanel";
import SubagentViewer from "./components/SubagentViewer";
import ApprovalModal from "./components/ApprovalModal";
import { RefreshCw, AlertTriangle, Cog } from "lucide-react";
import SettingsModal from "./components/SettingsModal";
import TerminalPanel, { TerminalToggleButton } from "./components/TerminalPanel";

const SVG_LOGO = (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 2L3 7v10l9 5 9-5V7l-9-5z" strokeLinejoin="round" />
    <path d="M12 22V12" strokeLinecap="round" />
    <path d="M3 7l9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function App() {
  const { models, modelId, setModelId, root, setRoot, running, messages, fontSize, streamCursor, setAppearance } = useStore();
  const [modelError, setModelError] = useState("");
  // v2.4 信息架构升级：扩展/MCP/模型管理全部并入设置弹窗（顶栏仅保留「设置」入口）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const loaded = useRef(false);

  // v2.4 外观即时应用（html data 属性 → index.css 规则）
  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize;
    document.documentElement.dataset.streamCursor = streamCursor ? "on" : "off";
  }, [fontSize, streamCursor]);

  const loadModels = useCallback(async () => {
    try {
      await fetchModels();
      setModelError("");
    } catch (e) {
      setModelError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    loadModels();
    // v2.4 设置：应用外观（字号/流式光标）与默认根目录（仅当输入框仍是默认值时）
    fetchConfig()
      .then((cfg) => {
        const st = useStore.getState();
        setAppearance({
          fontSize: cfg.appearance.fontSize ?? "sm",
          streamCursor: cfg.appearance.streamCursor ?? true,
        });
        if (cfg.general.defaultRoot && st.root === "E:\\InFu(test)") {
          st.setRoot(cfg.general.defaultRoot);
        }
      })
      .catch(() => {});
    // v2.1 会话：v1 localStorage 数据迁移 + 加载会话列表 + 恢复上次会话
    (async () => {
      try {
        await maybeMigrateV1();
        await fetchSessions();
        const st = useStore.getState();
        if (st.activeSessionId) {
          // 恢复上次会话（服务端已删除时回到空态）
          try {
            const { events } = await fetchSessionEvents(st.activeSessionId);
            st.loadSession(events);
          } catch {
            st.newSession();
          }
        }
      } catch {
        /* 会话服务未就绪时静默，5 秒重试（与模型加载同一节奏） */
      }
    })();
    // Agent 服务可能尚未就绪：每 5 秒自动重试直到模型加载成功
    const timer = setInterval(() => {
      if (useStore.getState().models.length === 0) loadModels();
    }, 5000);
    return () => clearInterval(timer);
  }, [loadModels]);

  return (
    <div className="flex h-full flex-col bg-ink">
      {/* 顶栏：Logo + 模型选择 + 项目根目录 */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <div className="flex items-center gap-2 text-accent">
          {SVG_LOGO}
          <span className="text-sm font-semibold tracking-wide">InFu</span>
        </div>
        <div className="text-xs text-sub">软件工程智能体</div>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-sub">模型</label>
          {models.length > 0 ? (
            <select
              className="h-8 cursor-pointer rounded-md border border-line bg-muted px-2 text-xs text-text transition-colors hover:border-accent"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              disabled={running}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {!m.apiKey && !m.baseURL ? "（未配 Key）" : ""}
                </option>
              ))}
            </select>
          ) : modelError ? (
            <span className="flex items-center gap-1.5 text-xs text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              模型加载失败
              <button
                className="flex cursor-pointer items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-text transition-colors hover:border-accent hover:text-accent"
                onClick={() => { setModelError(""); loadModels(); }}
                title={modelError}
              >
                <RefreshCw className="h-3 w-3" />
                重试
              </button>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-sub">
              <RefreshCw className="h-3 w-3 animate-spin" />
              模型加载中…
            </span>
          )}
          <input
            className="h-8 w-64 rounded-md border border-line bg-muted px-2 font-mono text-xs text-text placeholder:text-sub/60"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="项目根目录"
            spellCheck={false}
          />
          {running && (
            <span className="flex items-center gap-1 text-xs text-accent">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              运行中
            </span>
          )}
          <button
            className="flex h-8 cursor-pointer items-center gap-1 rounded-md border border-line bg-muted px-2 text-xs text-text transition-colors hover:border-accent hover:text-accent"
            onClick={() => setSettingsOpen(true)}
            title="设置（基础设置 / Agent 能力 / 数据与统计：模型·MCP·插件·技能·命令等全部在此管理）"
          >
            <Cog className="h-3.5 w-3.5" />
            设置
          </button>
        </div>
      </header>

      {/* 三栏主体 */}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        <ChatPanel />
        <DiffPanel />
        {/* v2.5 子智能体详情弹窗（右侧滑出；点击对话流中的子智能体条目打开） */}
        <SubagentViewer />
      </div>

      {/* v2.4 批 2：Web 交互式终端（底部通栏） */}
      {terminalOpen && <TerminalPanel />}
      <TerminalToggleButton open={terminalOpen} onClick={() => setTerminalOpen(!terminalOpen)} />

      <ApprovalModal />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
