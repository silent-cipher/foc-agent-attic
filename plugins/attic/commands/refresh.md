---
description: Add the sessions other machines backed up to this machine's Attic index
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" refresh)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" refresh` with a 5-minute timeout. It reads the backups on chain into the index and never uploads.

Then, by exit code:

- **0:** show the `✓` line: how many sessions were added or updated, or that the index was already up to date. Show any `✗ Skipped piece` lines too: those backups couldn't be read now, and the next refresh tries them again. Suggest `/attic:sessions` to list what is backed up.
- **1:** show the error. The index is unchanged. If it says to run `attic setup`, suggest `/attic:setup`; otherwise a refresh is safe to retry.
- **64:** the arguments were wrong. Show the error; don't run the same command again.

Never print the contents of `~/.attic/session.env`.
