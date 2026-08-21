# InFu Roadmap

## Current Release: 1.0.0

InFu 1.0.0 is a local Windows coding agent with a React workbench and Electron desktop application.

Completed capabilities:

- Local model configuration, streaming chat, fallback models, retries, context compression, and token budgets.
- File, Git, shell, test, search, symbol, TypeScript navigation, browser, OCR, desktop, memory, and scheduling tools.
- Session persistence, rewind, recovery copies, worktrees, subagents, background jobs, MCP, plugins, and `SKILL.md` skills.
- Windows restricted-token and Job Object sandbox support, local API token protection, path boundaries, SSRF filtering, command review, and recovery data.
- GitHub Actions verification on Windows: build, Chromium-backed production E2E, type checks, Rust checks, lint, and the full test suite.

The open-source distribution is Apache-2.0. It includes the `browser-use` and `skill-creator` extensions. Document-processing skills with restrictive development-time licenses are intentionally excluded from source and release artifacts.

## Maintenance Policy

The project is in a stability phase. Changes should be driven by reproducible issues from real use:

1. Security, data-loss, or boundary failures.
2. Failed or unrecoverable agent tasks.
3. CI, build, packaging, or installation regressions.
4. High-frequency usability or performance issues.

Each fix should include focused regression coverage and pass the full release checks.

## Conditional Work

These are not active milestones. Revisit them only when their condition is met.

| Area | Trigger |
|---|---|
| Team features | A second real user or an explicit collaboration requirement |
| Stronger execution isolation | Untrusted code, multi-tenant use, or hosted execution |
| Linux / WSL sandbox | A supported cross-platform execution requirement |
| Automatic updates | A stable installer distribution channel and signing plan |
| Localization | A confirmed audience and supported language plan |
