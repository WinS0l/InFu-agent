# Disaster Recovery

This guide explains how to restore InFu after a disk failure, Windows reset, or lost computer.

## What Can Be Restored

The clean source archive restores:

- InFu source code and build scripts
- Bundled `browser-use`, `control-browser`, `web-gui-tester`, and `skill-creator` extensions
- Dependency lockfile, documentation, license, and release notes

It intentionally does not contain personal information:

- API keys and provider configuration
- Sessions and chat history
- Attachments, logs, recovery snapshots, and local indexes
- User-installed plugins and skills
- Git credentials and SSH keys

## Restore From the Source Archive

1. Extract `InFu-1.0.1-source.zip` to a writable folder.
2. Install Node.js 22.5 or later.
3. Install Rust and the MSVC C++ Build Tools if you need to build the Windows native sandbox.
4. Open PowerShell in the extracted folder.
5. Run:

   ```powershell
   npm install
   npm run build
   npm run build -w @infu/web
   npm run start -w @infu/desktop
   ```

6. Run `npm run config` to configure a model provider again.

## Restore From the Portable Build

1. Extract the full portable ZIP to a writable folder.
2. Keep `InFu.exe`, `resources`, `locales`, DLLs, and all adjacent files together.
3. Run `InFu.exe`.
4. Configure a model if private data was not restored.

## Back Up Personal InFu Data

The active InFu data directory normally is:

```text
~/.infu
```

Before backing it up, check whether this redirect file exists:

```text
~/.infu-redirect.json
```

If it exists, the file points to the actual active data directory. Back up both the redirect file and the directory it points to.

The data directory may contain API keys, private session history, logs, attachments, and recovery copies. Store it only in an encrypted archive or a trusted encrypted backup service. Do not add it to Git, GitHub Releases, or an unencrypted shared cloud folder.

## Restore Personal Data

1. Install or extract InFu first.
2. Exit every running InFu process.
3. Restore the encrypted data archive to the same Windows user profile.
4. If a custom data directory was used, restore `~/.infu-redirect.json` too.
5. Start InFu and verify model configuration, sessions, projects, and skills.

If private data is unavailable, InFu remains usable. Configure a model again and start with empty local sessions.

## Git and SSH Keys

GitHub already stores pushed commits and tags. For unpushed branches or a full offline Git history, create a private bundle:

```powershell
git bundle create InFu-full-history.bundle --all
```

Do not copy an SSH private key into ordinary cloud storage. If a computer is lost, revoke the old GitHub SSH key and create a new key on the replacement computer.
