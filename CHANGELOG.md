# Changelog

## 1.0.0 - 2026-08-21

First public release of InFu.

### Highlights

- Local coding agent with a React workbench and Windows Electron application.
- Persistent sessions, recovery copies, worktrees, code review, terminal, embedded browser, OCR, and desktop controls.
- MCP, plugins, local skills, background jobs, subagents, scheduling, and TypeScript symbol navigation.
- Local API token protection, path and credential safeguards, SSRF filtering, command approval, and Windows restricted-token sandbox support.
- Apache-2.0 source distribution and a Windows NSIS installer.

### Distribution Notes

- The bundled open-source extensions are `browser-use` and `skill-creator`.
- Document-processing skills that had restrictive development-time licenses are not included in the source repository or installer.
- Local configuration, sessions, logs, attachments, build artifacts, screenshots, and launcher scripts are excluded from release artifacts.
