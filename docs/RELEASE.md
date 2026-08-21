# Release Guide

## Windows Portable Build

The portable archive contains the complete Electron application. Download
`InFu-1.0.0-win-x64-portable.zip`, extract the whole archive to a writable
folder, and run `InFu.exe` from that folder.

Do not copy only `InFu.exe`. Electron also requires the adjacent `resources`,
`locales`, DLLs, and Chromium files included in the archive.

InFu stores user configuration, sessions, logs, attachments, and recovery data
in the current Windows user's `~/.infu` directory. They are not stored beside
the portable executable and are not bundled in the archive.

The portable build has the same features as the desktop build started from
source: the local Agent service, workbench, embedded browser, bundled
`browser-use` skills, bundled `skill-creator`, native sandbox when available,
and local session persistence.

## Windows Security Notice

The first public Windows binary is unsigned. Smart App Control may block
unsigned applications and does not offer a per-application exception. Do not
disable system protection solely for InFu. If Windows blocks the portable build,
use the source build instead.

```powershell
git clone https://github.com/WinS0l/InFu-agent.git
Set-Location InFu-agent
npm install
npm run build
npm run build -w @infu/web
npm run start -w @infu/desktop
```

## Release Assets

Publish these files for version 1.0.0:

- `InFu-1.0.0-win-x64-portable.zip`
- `InFu-1.0.0-win-x64-portable.zip.sha256`

The NSIS installer may be retained for local testing, but is not recommended
for public distribution until a trusted signing process is available.
