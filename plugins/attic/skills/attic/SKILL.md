---
name: attic
description: Back up, list, restore, or refresh Claude Code and Codex sessions with encrypted Filecoin Onchain Cloud storage, or set up Attic and check its version.
---

Run the bundled CLI with Node 24 or newer. Resolve `../../dist/attic.mjs` relative to this skill's directory (the plugin root is two directories above this file's directory). Use the installed skill's location, not the current working directory. Quote the resolved absolute path.

Use the operation the user requested:

- Version: `node "<plugin root>/dist/attic.mjs" --version`
- Setup: `node "<plugin root>/dist/attic.mjs" setup`, adding `--grant <Grant>` only when the user supplies a Grant.
- Backup: `node "<plugin root>/dist/attic.mjs" backup <session id>` with a 10-minute timeout.
- Back up this chat: `node "<plugin root>/dist/attic.mjs" backup --current` in Codex, using its inherited `CODEX_THREAD_ID`. In Claude Code, use `node "<plugin root>/dist/attic.mjs" backup "${CLAUDE_SESSION_ID}"`, which Claude Code substitutes with the invoking session's ID. If the substitution is empty or still literal, report that the current session ID is unavailable; never guess from file timestamps.
- List backups: `node "<plugin root>/dist/attic.mjs" sessions`
- Restore: `node "<plugin root>/dist/attic.mjs" restore <session id>` with a 5-minute timeout.
- Refresh: `node "<plugin root>/dist/attic.mjs" refresh` with a 5-minute timeout. It adds the sessions other machines backed up to this machine's index and never uploads.

If the requested operation isn't listed, say this Attic version doesn't support it and suggest updating the plugin; never run another operation in its place.

Ask for a session ID if restore was requested without one, or for a session ID or `--current` if backup was requested without either. Reject `--current` combined with a session ID; restore does not accept `--current`. The CLI searches Claude Code's home and Codex's `CODEX_HOME` (default `~/.codex`); it selects the restore destination from the backup's agent. It needs no agent flag.

Show progress and errors as printed. Exit 0 means success, including an unchanged backup or identical existing restore. Exit 2 means the owner has a console action to complete: show the checklist and links exactly as printed, then wait for the user. Exit 1 means failure; show the error. After a timeout, show the last progress and any transaction hash; don't claim success.

When setup requests authorization or the user wants to renew, ask them to open the printed console link, approve the session key with their wallet, and paste the Grant (`fgr1_…`). Then rerun setup with that Grant. The session key stays the same on renewal. If setup or refresh changes the index, show its `✓` line and any skipped pieces; the next refresh tries skipped pieces again. Suggest listing sessions afterward. When restore says a session is not in the index, offer a refresh, then restore again.

After restore, show the resume command exactly as printed (`codex resume <id>` or `claude --resume <id>`). If a local file differs, never move or delete it yourself; explain the CLI's error and let the user decide. A newer local session can be backed up instead.

The CLI's `/attic:setup` and other `/attic:…` hints name Claude Code commands. In Codex, offer the corresponding operation through this skill, such as `$attic setup`, `$attic backup <id>` or `$attic refresh`.

Never print `~/.attic/session.env` or ask for the wallet's private key. If the CLI bundle is missing, report that the plugin needs `pnpm install` and `pnpm build` in its source checkout before installation; don't download or execute a substitute.
