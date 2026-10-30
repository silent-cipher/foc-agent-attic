---
description: List the Claude Code sessions Attic has backed up, and how the last backup run ended
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" sessions)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" sessions`

Show the table above exactly as printed, with the full session IDs: `/attic:restore <session id>` takes them. Then show how the last run ended, and any ✗ or ⚠ line about the session key; if one says to run `/attic:setup`, suggest it.

If it says the index is empty on a machine that has backups elsewhere, suggest `/attic:setup`: on a machine without an index, it rebuilds it from the backups on chain.

Never print the contents of `~/.attic/session.env`.
