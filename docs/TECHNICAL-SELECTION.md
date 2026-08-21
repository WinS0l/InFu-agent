# Technical Overview

## Architecture

InFu is a local-first application. The Agent service runs on the local machine and exposes a loopback HTTP API. The Web application consumes that API; the Electron application hosts both the service and the built Web assets in one desktop process.

| Layer | Technology | Role |
|---|---|---|
| Workspace | npm workspaces | Shared package management and builds |
| Agent | Node.js, TypeScript, Hono | Streaming API, CLI, tools, sessions, plugins |
| Web | React, Vite, Tailwind, Zustand | Workbench, sessions, approvals, settings, review |
| Desktop | Electron | Native window, tray, embedded browser, desktop input bridge |
| Native sandbox | Rust, napi-rs | Restricted tokens and Job Objects on Windows |
| Storage | SQLite and local JSON registries | Sessions, events, configuration, projects, schedules |

## Model Transport

The provider layer supports OpenAI-compatible endpoints and provider-specific request parameters. It handles retries, fallback chains, first-byte and idle timeouts, context-window management, and usage accounting.

## Security Boundaries

- The local API uses a per-process token and loopback Origin/Host checks.
- Tools validate project roots and reject symbolic-link or junction escapes.
- Sensitive credential locations are protected from agent reads and writes.
- Network tools reject private, loopback, link-local, and cloud metadata targets.
- Commands pass through approval, danger detection, outbound-network policy, and sandbox dispatch.
- The Electron bridge exposes a narrow preload API and validates the sender frame for IPC handlers.

## Packaging

`electron-builder` produces a Windows NSIS installer. The package includes compiled Agent and Web assets, the native sandbox module, `browser-use`, and `skill-creator`. Local sessions, model keys, build caches, test fixtures, launch scripts, screenshots, and restricted third-party content are excluded.
