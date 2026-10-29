---
description: Back up one Claude Code session now, encrypted, to Filecoin Onchain Cloud
argument-hint: "<session id>"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" backup:*)
---

Arguments: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" backup <session id>` with the session ID from the arguments, and a 10-minute timeout: an upload to two storage providers can take several minutes. If the arguments hold no session ID, ask for one and stop.

Then, by exit code:

- **0:** say the session is backed up, or was already backed up and unchanged, as printed.
- **2:** show what is printed and every link exactly as printed, and say what the user has to do: run `/attic:setup`, or deposit USDFC in the console. Nothing was uploaded. Offer to run the backup again once they have.
- **1:** show the error. If it says to run `/attic:setup`, suggest it. A failed upload is safe to retry.

Never print the contents of `~/.attic/session.env`.
