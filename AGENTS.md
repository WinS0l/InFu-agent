# InFu Contributor Notes

## Project Scope

InFu is a local coding agent for Windows. It is a npm-workspaces monorepo:

- `packages/shared`: shared types and transport helpers
- `packages/agent`: local server, CLI, tools, sessions, plugins, and sandbox policy
- `packages/web`: React workbench
- `packages/desktop`: Electron desktop application
- `packages/sandbox-rs`: Windows N-API sandbox module

## Development

```powershell
npm install
npm test
npm run build
npm run build -w @infu/web
npm run lint
```

The desktop application loads `packages/web/dist` in normal mode. For HMR, start the desktop Vite server first and set `INFU_DESKTOP_DEV=1` before launching Electron.

## Safety Rules

- Do not add API keys, session databases, attachments, logs, `.infu` directories, screenshots, or local launcher files to Git.
- Keep API credentials in `~/.infu/config.json` or environment variables.
- Preserve protected-path, root-boundary, SSRF, approval, and recovery checks when changing tools.
- Add a regression test for behavior changes in the agent, sandbox, persistence, or desktop bridge.
- Keep external plugins and MCP servers treated as trusted code.

## Release Checks

Before a release, run the full test suite, source builds, Web production build, desktop package build, and GitHub Actions CI. The NSIS package must contain the compiled browser-use and skill-creator skills, but not local data or restricted third-party content.
