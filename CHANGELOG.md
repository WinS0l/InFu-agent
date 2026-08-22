# Changelog

## 1.0.1 - 2026-08-22

Release-hardening update focused on dependable local agent execution.

### Agent reliability

- Added task-aware tool routing for large MCP/plugin registries while keeping built-in tools pinned and available.
- Added classified recovery guidance for path, permission, timeout, network, argument, and test failures.
- Added a source-edit verification gate so the agent cannot silently claim completion before obtaining test or validation evidence.
- Added structured run metrics for tool failures, recovery, validation, approvals, token use, and cache-hit rate.
- Improved rolling context pruning and token-usage calibration for long sessions.

### Browser and desktop automation

- Added explicit browser and desktop verification tools with compact evidence.
- Added optional atomic act-and-verify behavior to browser click/fill and desktop click/type operations.
- Strengthened high-impact browser approvals and sensitive input redaction.
- Preserved DPI-aware virtual-screen coordinates, window targeting, and UI Automation tree evidence.

### Product and release quality

- Added real read-edit-test-deliver and failure-recovery agent scenarios.
- Reduced the Web production entry chunk through lazy loading and removed all lint warnings.
- Added reproducible bundled-skill checks, desktop builds, full tests, production dependency audit, and zero-warning lint to `release:verify` and CI.

### Scope

- InFu remains a local Windows agent. Cross-platform support, cloud collaboration, and enterprise governance are intentionally outside this release.

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
