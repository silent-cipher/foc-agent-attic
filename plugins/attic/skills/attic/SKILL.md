---
name: attic
description: Back up, list, or restore Claude Code and Codex sessions with encrypted Filecoin Onchain Cloud storage, or set up Attic and check its version.
---

Run the bundled CLI with Node 24 or newer. Resolve `../../dist/attic.mjs` relative to this skill's directory (the plugin root is two directories above this file's directory). Use the installed skill's location, not the current working directory. Quote the resolved absolute path.

Use the operation the user requested:

- Version: `node "<plugin root>/dist/attic.mjs" --version`
- Setup: `node "<plugin root>/dist/attic.mjs" setup`, adding `--grant <Grant>` only when the user supplies a Grant.
- Backup: `node "<plugin root>/dist/attic.mjs" backup <session id>` with a 10-minute timeout.
- List backups: `node "<plugin root>/dist/attic.mjs" sessions`
- Restore: `node "<plugin root>/dist/attic.mjs" restore <session id>` with a 5-minute timeout.

Ask for a session ID if backup or restore was requested without one. The CLI searches Claude Code's home and Codex's `CODEX_HOME` (default `~/.codex`); it selects the restore destination from the backup's agent. It needs no agent flag.

Show progress and errors as printed. Exit 0 means success, including an unchanged backup or identical existing restore. Exit 2 means the owner has a console action to complete: show the checklist and links exactly as printed, then wait for the user. Exit 1 means failure; show the error. After a timeout, show the last progress and any transaction hash; don't claim success.

For setup, ask the user to open the printed console link, approve the session key with their wallet, and paste the Grant (`fgr1_…`). Then rerun setup with that Grant. The session key stays the same on renewal. If setup rebuilds the index, show its session count and any skipped pieces. Suggest listing sessions afterward.

After restore, show the resume command exactly as printed (`codex resume <id>` or `claude --resume <id>`). If a local file differs, never move or delete it yourself; explain the CLI's error and let the user decide. A newer local session can be backed up instead.

The CLI's `/attic:setup` and other `/attic:…` hints name Claude Code commands. In Codex, offer the corresponding operation through this skill, such as `$attic setup` or `$attic backup <id>`.

Never print `~/.attic/session.env` or ask for the wallet's private key. If the CLI bundle is missing, report that the plugin needs `pnpm install` and `pnpm build` in its source checkout before installation; don't download or execute a substitute.
