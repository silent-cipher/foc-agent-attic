---
description: Restore a backed-up Claude Code session from Filecoin Onchain Cloud
argument-hint: "<session id>"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" restore:*)
---

Arguments: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" restore <session id>` with the session ID from the arguments, and a 5-minute timeout. If the arguments hold no session ID, ask for one and stop.

Then, by exit code:

- **0:** say the session is restored, or was already here, and show the `claude --resume <id>` command exactly as printed. It resumes the session from any folder.
- **1:** show the error. Nothing was written. If the local session is newer than the backup, it needs no restore: offer to back up the newer version with `/attic:backup <session id>`. If a file already exists and differs otherwise, the user can move it away and run restore again; never move or delete it yourself.

Never print the contents of `~/.attic/session.env`.
