---
description: List the Claude Code sessions Attic has backed up, and how the last backup run ended
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" sessions)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" sessions`

Show the table above exactly as printed, with the full session IDs: `/attic:restore <session id>` takes them. Then show how the last run ended, and any ✗ or ⚠ line about the session key; if one says to run `/attic:setup`, suggest it.

If a session the user expects is missing, or the index is empty, suggest `/attic:refresh`: it adds the sessions other machines backed up. On a machine that isn't set up yet, suggest `/attic:setup`.

Never print the contents of `~/.attic/session.env`.
