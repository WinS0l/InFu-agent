# Desktop Application

InFu Desktop is a Windows Electron application. It starts the local Agent service and loads the built Web workbench from the same process.

## Run From Source

```powershell
npm install
npm run build
npm run build -w @infu/web
npm run start -w @infu/desktop
```

Normal startup uses `packages/web/dist`. It does not require a Vite server.

For HMR development, start the desktop Vite server first and then set `INFU_DESKTOP_DEV=1` before launching Electron:

```powershell
npm run dev:desktop -w @infu/web
$env:INFU_DESKTOP_DEV = "1"
npm run start -w @infu/desktop
```

## Architecture

```text
Electron main process
├─ local Agent service on loopback HTTP
├─ native window controls, tray, notifications, and file dialogs
├─ embedded browser guest contents
└─ restricted desktop input bridge

Renderer
├─ React workbench
├─ sessions, approvals, review, terminal, and settings
└─ embedded browser tabs and browser controls
```

The main process owns browser guest contents and provides a constrained CDP bridge for browser automation. Browser tabs remain visible to the user and are closed only on an explicit close action.

## Security

- The local service listens on loopback only.
- Renderer APIs are exposed through a narrow preload bridge.
- IPC handlers validate the main renderer frame.
- Browser guests have Node integration disabled and are checked before attachment.
- The browser bridge is scoped to tabs created and managed by InFu.

## Package

Build a Windows NSIS installer with:

```powershell
npm run pack -w @infu/desktop
```

The package includes compiled Agent and Web assets, the native sandbox, browser automation skills, and skill authoring skills. It excludes local data, sessions, credentials, logs, launch scripts, screenshots, and restricted third-party content.
