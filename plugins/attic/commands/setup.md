---
description: Log in to Filecoin Onchain Cloud through the console and check Attic can back up
argument-hint: "[fgr1_… Grant]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" setup:*)
---

Arguments: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/attic.mjs" setup`, adding `--grant <Grant>` if the arguments hold a Grant (text starting `fgr1_`; remove any whitespace or line breaks inside it).

Then, by exit code:

- **2 with a console link and no Grant saved:** show the link and the session address exactly as printed. Ask the user to open the link, approve with their wallet, check the console shows the same session address, and paste the Grant it shows here. When they paste it, run setup again with `--grant <Grant>`.
- **2 after the readiness checklist:** show the checklist and every link exactly as printed, and say what the user still has to do in the console. Offer to run setup again once they have.
- **0:** show the checklist, the expiry date and the renewal link. Attic is ready. If the user wants to renew, ask them to open the link, approve with their wallet, and paste the new Grant here; then run setup again with `--grant <Grant>`. The session key stays the same.
- **1:** show the error. If a Grant was refused, ask the user to copy it again from the console.

Never print the contents of `~/.attic/session.env`.
