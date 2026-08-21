# InFu

InFu is a local coding agent for Windows. Give it a task in plain language and it can inspect a repository, make a plan, edit files, run tests, and leave a session record you can continue later.

It is built for local projects. Model credentials, sessions, logs, attachments, and recovery snapshots stay on the machine unless you explicitly use a model provider or a network-enabled tool.

## What It Includes

- Streaming agent loop with tool calls, retries, fallback models, context compression, token accounting, and task budgets.
- File, Git, shell, search, symbol, TypeScript navigation, browser, screenshot, OCR, memory, and scheduling tools.
- Session persistence in SQLite, rewind, recovery copies for file changes, and worktree-based task isolation.
- A React workbench with approvals, task history, code review, terminal, browser, desktop controls, and session trace.
- Windows desktop application built with Electron, including native window controls, tray integration, embedded browser tabs, and computer-use tools.
- MCP clients, JavaScript plugins, and `SKILL.md` skills. The bundled open-source extensions are `browser-use` and `skill-creator`.

## Requirements

- Windows 10 or later
- Node.js 22.5 or later
- Rust and the MSVC C++ toolchain only when building the native sandbox from source

The desktop installer is the easiest way to run InFu. To work from source, clone the repository and install dependencies:

```powershell
git clone https://github.com/WinS0l/InFu-agent.git
Set-Location InFu-agent
npm install
npm run build
```

## Configure a Model

Run the configuration wizard:

```powershell
npm run config
```

It writes local configuration to `~/.infu/config.json`. API keys are not stored in the repository. InFu supports OpenAI-compatible endpoints as well as OpenAI, Anthropic, Google, DeepSeek, Zhipu, Qwen, Kimi, Ollama, and custom compatible providers.

## Run It

### Desktop application

```powershell
npm run build -w @infu/web
npm run start -w @infu/desktop
```

For a portable Windows build:

```powershell
npm run pack -w @infu/desktop
```

See [docs/RELEASE.md](docs/RELEASE.md) for portable archive use and the unsigned-binary notice.

### Command line

```powershell
npm run infu -- "Analyze this repository and explain the test setup" --root .
npm run infu -- "Fix the failing test and run the relevant checks" --root . -y
npm run infu -- sessions
```

### Local server

```powershell
npm run start -w @infu/agent
```

The local service listens on `127.0.0.1:4317` by default and selects another port if needed.

## Safety Model

InFu is designed for local development, not for executing unknown code without review.

- API access uses a per-process local token.
- Sensitive locations such as `.ssh`, `.aws`, `.infu`, and credential files are protected.
- File operations enforce project boundaries and resolve symbolic-link or junction escapes.
- Dangerous commands, outbound network commands, and configurable tool risks go through the approval policy.
- The Windows native sandbox uses restricted tokens and Job Objects when available.
- Existing file edits create session-scoped recovery copies. Restore is available through `file_ops restore`.

`full` approval mode is intentionally powerful. It still cannot bypass protected paths, path boundaries, SSRF checks, or explicitly disabled tools. Use it only for repositories and instructions you trust.

## Extensions

Plugins execute inside the Agent process, so treat them as trusted code. MCP servers and local skills can be managed from the application or CLI.

```powershell
npm run infu -- plugin list
npm run infu -- mcp list
npm run infu -- skill list
npm run infu -- skill template list
```

See [docs/PLUGINS.md](docs/PLUGINS.md), [docs/MCP.md](docs/MCP.md), and [docs/SUBAGENTS.md](docs/SUBAGENTS.md) for details.

## Development Checks

```powershell
npm test
npm run build
npm run build -w @infu/web
npm run lint
```

The GitHub Actions workflow runs the Windows build, Chromium-backed production E2E checks, type checks, Rust checks, lint, and the full test suite.

## Documentation

- [Desktop architecture and packaging](docs/DESKTOP.md)
- [Sandbox and security boundaries](docs/SANDBOX.md)
- [MCP integration](docs/MCP.md)
- [Plugin and skill system](docs/PLUGINS.md)
- [Subagents and background tasks](docs/SUBAGENTS.md)
- [Technical choices](docs/TECHNICAL-SELECTION.md)
- [Roadmap and release history](docs/ROADMAP.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
