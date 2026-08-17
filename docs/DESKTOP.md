# InFu 桌面端（Electron）

> v3.0 桌面化（2026-08-15 立项，用户拍板：Electron + 壳 + 嵌入式真浏览器）
> 嵌入式浏览器架构 v3.0 批 8 定稿（2026-08-16）：**webview 元素 UI + 主进程 CDP 桥**
> ——对齐 ZCode「宿主注入」：宿主持有浏览器对象（guest webContents），Agent 通过主进程桥直发 CDP。

## 架构

```
Electron 主进程（packages/desktop，ESM）
├── 后端宿主：import { startServer } from "@infu/agent/dist/server.js"
│   ├── Hono /api/*（4317，冲突自动递增；仅监听 127.0.0.1）
│   ├── 静态托管（opts.staticDir：同端口托管 web dist → 前端相对路径 fetch 零改动）
│   └── CORS 放开（dev 模式前端 vite 5199 跨域直连；生产同源不受影响）
├── 主窗口 BrowserWindow：无边框自定义标题栏（titleBarStyle hidden + titleBarOverlay）
│   ├── React UI（dev = vite 5199?infuAgentPort=<端口>；prod = http://127.0.0.1:<端口>/）
│   └── 渲染进程：TitleBar + RightRail（浏览器面板常驻不卸载）
├── 嵌入式真浏览器（<webview> DOM 元素架构，v3.0 批 8 定稿）
│   ├── UI：每个 tab 一个 <webview> 元素（DOM 层叠——圆角/阴影/菜单自然盖在浏览器
│   │   之上，即用户拍板「infu 覆盖浏览器」）；自由尺寸 = 元素 CSS（无需主进程 bounds）
│   ├── 生命周期：面板常驻（webview 元素从 DOM 移除即销毁 guest → 面板只能显隐
│   │   不能卸载）；销毁只发生在用户显式关闭浏览器 tab（×）或 Agent 显式 browser_close
│   ├── 主进程注册表：did-attach-webview → Map<webContents.id, WebContents>（渲染进程
│   │   webview.getWebContentsId() 天然一致）+ debugger.attach("1.3")（每个 guest 独占）
│   ├── CDP 桥（Agent 与主进程同进程 → 全局函数直接调用）：
│   │   __infuCdpSend(tabId, method, params) / __infuCdpOn(tabId, event, cb)
│   │   __infuBrowserTabs（tab 注册表） / __infuOpenEmbeddedBrowser / __infuSelectBrowserTab
│   └── browser-use 插件：runtime 桌面模式全走 CDP 桥（不经 playwright；无端口无 target
│       发现——playwright connectOverCDP 初始列表过滤 webview 类型 = 批 4-6 灾难根源）
├── 托盘（仅「显示主窗口/退出」）
└── 单实例锁 + 窗口状态持久化（~/.infu/desktop-window.json）
```

## 启动

```bash
# 终端 1：桌面 dev 专用 vite（5199，与 Web 版常驻 5174 错开）
npm run dev:desktop -w @infu/web

# 终端 2：构建主进程并启动（自动 rebuild agent dist 依赖项需先 npm run build 全量）
npm run build -w @infu/agent
npm run start -w @infu/desktop     # = build + electron（INFU_DESKTOP_DEV=1）
```

生产形态（未打包阶段）：`INFU_DESKTOP_DEV` 不设 → 主窗口加载 agent 服务同端口
（静态托管 web dist），此时需先 `npm run build -w @infu/web` 产出 dist。

## 关键设计决策

| 项 | 决策 | 理由 |
|---|---|---|
| 壳选型 | Electron 43 | ZCode Desktop 3.7.6 本机实证同为 electron-builder 生态；Node 后端零改造宿主；嵌入式浏览器 = 连接应用自身 Chromium |
| 嵌入式浏览器 | `<webview>` 元素（DOM 层叠） | 用户拍板「不是浏览器覆盖 infu，而是 infu 覆盖浏览器」；圆角/阴影/菜单自然盖浏览器之上，根治 WebContentsView 原生层盖 DOM 的覆盖问题 |
| **webview 命门** | `webpreferences="sandbox=no"` 必须显式设置 | webview guest 默认 sandbox 渲染——本机加固环境渲染进程 0x80000003 崩溃（= 批 4-6 render-process-gone 根源）；WebContentsView 的 sandbox:false 同理 |
| Agent 驱动 | **主进程 CDP 桥**（webContents.debugger.attach + sendCommand 注入全局） | playwright connectOverCDP 初始 target 列表过滤 webview 类型 → tab 不可见/空白堆积/输入污染/失败循环（批 4-6 灾难）；桥 = 宿主注入（对齐 ZCode「宿主持有浏览器对象暴露给 Agent」），无端口无发现过程，Agent 页面即用户页面天然成立 |
| 浏览器关闭语义 | 只有用户显式关闭才销毁 | 面板常驻 RightRail（卸载 = webview 元素移除 = guest 销毁）；loadSession 清 rightTabs 只切显隐；Agent browser_close 描述「绝不主动关闭」（ZCode 语义） |
| 输入注入 | 页面内 JS（activeElement/value setter + input 事件） | 与键盘焦点完全解耦——根治「Agent 文字进用户输入框」污染（CDP 键盘输入在 webview 未聚焦时落到主窗口聚焦元素） |
| 窗口形态 | 无边框：`titleBarStyle: hidden` + `titleBarOverlay` | 保留系统拖拽/贴边/双击最大化；按钮颜色随主题联动（`theme:set` IPC） |
| 关闭行为 | 关闭窗口 = 退出应用（后端同进程一并退出） | 用户拍板 |
| API 地址 | 生产同源（静态托管）；dev 用 query `?infuAgentPort=` → 绝对地址 + CORS | 常驻 Web 版占用 4317/5174，桌面 server 可能递增到 4318 → 前端动态取端口 |

## Agent 侧浏览器工具（browser-use 插件，批 8 修复链）

- `cdp.ts`：CDP 客户端抽象（桌面 = 主进程桥；Web = playwright CDPSession）+
  `cdpEvaluate`（`Runtime.evaluate replMode`——语句/表达式/函数三态通吃，绕开页面 CSP）
- `ax.ts`：AI 可访问性树（Accessibility.getFullAXTree，Codex domSnapshot 同技术）+
  交互节点 [n] 编号 → backendDOMNodeId 映射 + clickByIndex（CDP 定位点击）
- `runtime.ts`：BrowserTab 抽象（桌面 CDP 桥 / Web playwright 双实现）——
  navigate（Page.navigate + readyState 轮询）/ snapshot / click / fill / type / eval /
  screenshot / viewport（Emulation + __infuNotifyViewport 面板贴合）
- 定位纪律（对齐 ZCode）：fill 页面内多级匹配（CSS → placeholder/aria-label/name/title
  → label → 可见兜底）；click 用与展示同一份 snapshot 的 indexMap（动态页面两次快照
  编号漂移 → describeNode nodeId=0 的根因）

## 本机 GPU 适配（Windows 25H2 加固系统）

现象：Chromium GPU 子进程反复崩溃（exit_code=0x80000003 断点异常，6 次后 FATAL
退出）；`sandbox: true` 渲染进程无法启动（「操作不被支持」）；`ready-to-show`
因首帧合成失败永不触发（窗口不显示）。

最终配置（main.ts）：
- `app.disableHardwareAcceleration()` + `--in-process-gpu`（GPU 线程并入主进程，
  不创建子进程 → 加固系统不再拦截）——**in-process-gpu 需搭配 sandbox:false**，
  sandbox:true 时渲染进程 CDP/导航无响应
- `--disable-gpu-process-crash-limit` + `--enable-unsafe-swiftshader` 兜底
- 窗口 `ready-to-show` 加 2s 超时兜底 show

**注意**：以上是纯软件渲染路径（合成/截图可用，实测通过）。若迁移到正常 GPU 环境，
可移除这些开关并恢复 `sandbox: true`。

## 嵌入式浏览器安全边界

- 仅本机监听：agent 服务 127.0.0.1；**无 CDP 远程调试端口**（批 8 移除——桥在主进程
  内，不对外暴露）
- 导航白名单：`navUrl` 只允许 http/https/about:blank（裸域名自动补 https）
- `setWindowOpenHandler`：应用内外链交给系统浏览器；嵌入式页内 window.open → 视图内导航
- 嵌入式页与主窗口隔离：webview contextIsolation + 无 nodeIntegration（sandbox=no
  仅为本机加固环境渲染进程可用性，会话隔离仍由 webview 元素边界保证）
- CDP 桥只对 Agent 自己的 tab（用户手动开的页面 Agent 不接管，对齐 ZCode 语义）
- Agent 端 browser_close：绝不主动关闭（描述强化 + 实现 no-op），浏览器常驻

## 已知限制 / 后续

- 打包（electron-builder NSIS）与正式图标：开发完成后进行
- browser_screenshot 桌面模式已随合成器恢复可用（CDP 截图实测通过）
- Web 版不受影响：无 `window.infuDesktop` → 无标题栏、浏览器 tab 保持原占位
- computer-use / read_image（vision 底座）：桌面化后续阶段
