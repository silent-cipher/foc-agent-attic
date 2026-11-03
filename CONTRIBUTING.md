# Contributing to Agent Attic

This file is for people working on Attic itself. To install and use it, see the [README](README.md).

## Development

Requires Node 24 and pnpm (the version in `packageManager`).

```sh
pnpm install
pnpm lint         # Biome
pnpm typecheck    # tsc, no emit
pnpm test         # unit tests
pnpm test:e2e     # builds plugins/attic/dist/attic.mjs, then runs it in a temporary HOME
pnpm test:calibnet  # on calibnet; skipped unless ATTIC_CALIBNET_PRIVATE_KEY holds a funded wallet key
```

The calibnet suite also runs from the manual **Calibnet** workflow, with the `ATTIC_CALIBNET_PRIVATE_KEY` repository secret. It backs up a session, deletes it, restores it, and checks Claude Code can resume it, then restores it on a second machine whose index already exists, through `refresh`, so it needs `claude` on `PATH`.

Attic stores backups on mainnet only. Calibration guarantees no storage, so it is for testing: set `ATTIC_NETWORK=calibration` (for example `ATTIC_NETWORK=calibration claude --plugin-dir plugins/attic`). A session key is tied to the network it was made on; delete `~/.attic/session.env` to switch.

To try console changes before they reach pay.filecoin.cloud, set `ATTIC_CONSOLE_URL` to a staging, preview or local console (for example `ATTIC_CONSOLE_URL=http://localhost:3000`). Setup's console links then point there.

### Trying the plugin in Claude Code

After `pnpm build`:

```sh
claude --plugin-dir plugins/attic
```

Then run `/attic:version`, or `/attic:setup` to log in, then `/attic:backup <session id>`, `/attic:sessions`, `/attic:refresh` and `/attic:restore <session id>`.

### Trying the plugin in Codex

Run `pnpm install` and `pnpm build` first, then add the checkout as a local marketplace:

```sh
codex plugin marketplace add /absolute/path/to/foc-agent-attic
```

Install Agent Attic from that marketplace in Codex's plugin browser (`/plugins`), then start a new session. The `.agents/plugins/marketplace.json` catalog points to the same `plugins/attic` folder Claude Code uses. Build before installing: the bundle is generated, not committed. After changing the plugin, rebuild and refresh/reinstall the cached copy.

Codex's [documented plugin components](https://developers.openai.com/plugins/build/plugins) include skills, with no documented equivalent of Claude Code's `commands/` directory. The fallback for #4 is the bundled `$attic` skill: `$attic setup`, `$attic backup <session id>`, `$attic sessions`, `$attic refresh`, `$attic restore <session id>` or `$attic version`. The CLI's `attic …` hints name the same operations as these skill calls and the Claude Code commands.

## Releasing

[release-please](https://github.com/googleapis/release-please) keeps a release PR open that bumps the version in `package.json` and both plugin manifests and updates `CHANGELOG.md` from the conventional commit titles merged to `main`. Merging it releases: on that push, the **release-please** workflow runs CI and the calibnet suite on the merge commit, and only once both pass does it tag `vX.Y.Z`, publish the GitHub release with `.github/release-notes.md` above the changelog, build the bundle, publish it to npm and push it to the `release` branch. Other pushes to `main` only update the release PR, and never tag an earlier release PR.

If a check fails on a release merge, nothing is tagged. For a flaky failure, re-run the failed jobs of that run. For a real one, fix it on `main`, then remove the `autorelease: pending` label from the merged release PR so release-please opens a new one with the fix; check the version it proposes. If publishing fails after the tag exists, dispatch the workflow on that tag to publish it again (`dry_run` checks it without pushing); a version already on npm is skipped.

npm publishes through [trusted publishing](https://docs.npmjs.com/trusted-publishers): the package's trusted publisher on npmjs.com is this repository's `release-please.yml` workflow, so no npm token is stored. npm only accepts a trusted publisher for a package that exists, so the first release's npm step fails and pushes nothing. Publish that version by hand from its tag (`pnpm install`, `pnpm build`, `npm publish`), add the trusted publisher, then dispatch the workflow on the tag to push the `release` branch.

## How Attic behaves

The rules the code and tests hold to. [GLOSSARY.md](GLOSSARY.md) defines the terms, and [docs/adr](docs/adr) records the decisions behind data sets and metadata.

### Logging in

`setup` makes a session key in `~/.attic/session.env` (owner-readable only) and prints a Filecoin Cloud console link. The owner approves the key there with their wallet, then pastes the Grant (`fgr1_…`) the console shows. Attic never sees the wallet key: the Grant gives the session key the owner's group key, and every backup is encrypted under its `attic` scope. Setup then checks the key is authorized, the storage service is approved and USDFC is available, and says when the key expires. Its console link renews the same session key at any time.

### Backing up

`backup` with no arguments refreshes the index, then backs up every local session idle for at least 24 hours whose files are missing or changed. It uploads snapshot bytes with at most four transfers at a time and batches the pieces into one add-pieces call per data set, within the provider's batch limits. A run holds at most 256 MiB of sessions in memory: a larger run, such as a machine's first, commits each 256 MiB in its own add-pieces call. With no existing data set, the first successful session uploads alone to establish it, then the rest upload in parallel. A known provider outage fails for retry instead of creating another data set. An empty run sends no transactions. One session's failure leaves the others running; `~/.attic/status.json` records `backedUp`, `skipped` (active, unchanged, or older than the indexed backup), and `failed` counts.

A backup skips a local snapshot older than the indexed backup, with or without an ID, so a stale machine cannot replace a newer backup.

A changed session's old piece is scheduled for removal only after its replacement commits and is indexed, in one removal call per data set and add-pieces call. A failed removal leaves the old piece stored and reports failure; it does not undo the new backup. Existing session keys need setup reauthorization with the `schedulePieceRemovals` scope before uploading. Backups use one provider copy.

Only one backup runs per machine, including explicit-ID backups. Another invocation exits while the process whose PID is in `~/.attic/backup.lock` is running. The lock is removed when the run finishes or errors; a lock left by a killed process is replaced by the next run.

`backup --current` backs up the invoking chat. Active sessions are included, with the bytes available when Attic reads them. Claude Code supplies the ID through its `${CLAUDE_SESSION_ID}` command/skill substitution; Codex supplies `CODEX_THREAD_ID` to the CLI. The CLI also accepts `CLAUDE_SESSION_ID` when explicitly supplied in its environment. Missing or ambiguous current-session context fails with guidance to give an explicit ID; Attic never picks the most recently modified session.

`backup <session id>` backs up one session now, even if it is still active. For Claude Code that is its transcript and its folder of subagents and tool results, under `~/.claude` (or `CLAUDE_CONFIG_DIR`). It checks the session key is authorized and USDFC is available, then packs a header (session ID, project, machine, title, first prompt and git branch when the transcript has them, each file's size and SHA-256) and the files into one piece, encrypts it under a fresh piece key, and stores it with one provider in an Attic data set. Only once the piece is committed does it record the piece in `~/.attic/index.json`, so a failed upload leaves the session to retry. Each index entry records the network, wallet and group key its piece is encrypted under. A session the index already holds unchanged, for the current login, is not uploaded again; after logging in with another wallet or group key, the next backup uploads it again, and restore refuses a backup the current login can't decrypt.

### Restoring and listing

`restore <session id>` downloads the session's piece, decrypts it, and checks every file's SHA-256 before writing anything. It refuses paths outside the session agent's folder and existing files that differ from the backup, writes the missing files, and prints the resume command. The plugin's restore command and skill accept a description instead of an ID: the agent offers the best matches from `sessions --json` and restores only the one the user chooses. If nothing matches, or an ID is missing from the index, the agent refreshes once and tries again before reporting no backup. The CLI's restore and sessions stay local.

`sessions` lists the index newest first, with the result of the last backup run from `~/.attic/status.json`. A Claude Code session's title is the latest one Claude Code gave it, else its first prompt, shortened; sessions backed up before Attic recorded titles show none until they change and are backed up again. Word filters match title, first prompt, project or git branch, ignoring case. From 7 days before the Grant expires, it warns to run setup to renew it.

### Other machines' backups

`refresh` lists the pieces in the owner's Attic data sets under the login's group key, and decrypts only the start of each piece the index doesn't already hold, where the header is, 8 at a time. It keeps the newest piece of each session, leaves every other entry alone, and reports how many sessions it added or updated. It only reads the chain into the index and never uploads. It needs only the Grant, so sessions can be listed and restored before a new session key is authorized. On a machine with no `~/.attic/index.json`, setup runs the same refresh to build it.

If the listing fails, the index is left unchanged. A piece whose header can't be read (its provider is down, or it isn't an Attic session) is reported and left out, and the next refresh tries it again.

### Codex sessions

Attic handles Codex rollouts under `~/.codex/sessions` (or `$CODEX_HOME/sessions`). It saves the rollout JSONL byte for byte, including an active rollout's incomplete last line, and restores it to the same relative path under the destination Codex home. It reads the project from the initial `session_meta.payload.cwd` and prints `codex resume <id>` after restore. Global history, credentials, config, SQLite databases and archived sessions are not included; each subagent rollout is its own session ID.

Codex sessions show their latest `thread_name` from `session_index.jsonl`, else their first `user_message` event, shortened. The branch comes from `session_meta.payload.git.branch`. These fields are saved in the encrypted header. A missing or unreadable title index leaves the title out; the index itself is never backed up. Renaming an unchanged rollout does not upload it again: the title updates when the rollout next changes and is backed up.
