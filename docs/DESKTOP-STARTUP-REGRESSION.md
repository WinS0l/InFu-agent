# 桌面启动白板回归检查

## 场景
运行 `npm run start -w @infu/desktop`，但没有运行 Vite 开发服务器。

## 期望
- 主窗口加载由 Agent 服务同端口托管的 `packages/web/dist`；
- 不请求 `http://localhost:5199`；
- 不出现 `ERR_CONNECTION_REFUSED`，`#root` 有 React 内容。

## 开发 HMR
需要 Vite HMR 时，先运行 `npm run dev:desktop -w @infu/web`，再显式设置 `INFU_DESKTOP_DEV=1` 启动 Electron。普通 `start` 不应依赖 Vite。
