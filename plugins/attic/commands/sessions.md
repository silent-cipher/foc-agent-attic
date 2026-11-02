---
description: List the Claude Code sessions Attic has backed up, or those matching some words, and how the last backup run ended
argument-hint: "[words]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" sessions:*)
---

Arguments: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" sessions`, adding each word from the arguments, if any, as its own quoted argument. With words, it lists only the sessions whose title, first prompt, project or branch contain every word, ignoring case.

Show the table exactly as printed, with the full session IDs: `/attic:restore <session id>` takes them. Then show how the last run ended, and any ✗ or ⚠ line about the session key; if one says to run `attic setup`, suggest `/attic:setup`.

If a session the user expects is missing, or the index is empty, suggest `/attic:refresh`: it adds the sessions other machines backed up. On a machine that isn't set up yet, suggest `/attic:setup`.

Never print the contents of `~/.attic/session.env`.
