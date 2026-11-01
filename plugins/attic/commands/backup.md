---
description: Back up idle sessions, or one Claude Code or Codex session now, encrypted, to Filecoin Onchain Cloud
argument-hint: "[<session id> | --current]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" backup:*)
---

Arguments: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" backup <session id>` with the session ID from the arguments, and a 10-minute timeout: an upload and its on-chain commit can take several minutes. For exactly `--current`, use `node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" backup "${CLAUDE_SESSION_ID}"`: Claude Code substitutes the invoking session's ID here. If that substitution is empty or still literal, report that the current session ID is unavailable; never guess from file timestamps. Reject `--current` combined with a session ID. With no arguments, run `node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" backup` with the same timeout: it refreshes the index and backs up all sessions idle for 24 hours.

It prints each step as it goes (`[12s] Uploading to provider 9 …`). If the command times out or is stopped, show the last steps it printed: they say where it was, and any transaction hash can be looked up on the explorer.

Then, by exit code:

- **0:** show the run counts, or say the session is backed up or unchanged, as printed.
- **2:** show what is printed and every link exactly as printed, and say what the user has to do: run `/attic:setup`, or deposit USDFC in the console. Nothing was uploaded. Offer to run the backup again once they have.
- **1:** show the error. If it says to run `/attic:setup`, suggest it. A failed upload is safe to retry.

Never print the contents of `~/.attic/session.env`.
