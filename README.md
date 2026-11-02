# Agent Attic

A Claude Code and Codex plugin that backs up agent sessions, encrypted, to Filecoin Onchain Cloud.

## Install

Attic needs Node 24 or newer and stores backups on mainnet only. Each release publishes the plugin, with its built CLI, to the `release` branch.

In Claude Code:

```sh
/plugin marketplace add silent-cipher/foc-agent-attic#release
/plugin install attic@attic
```

In Codex, add the marketplace and install Attic, then start a new session:

```sh
codex plugin marketplace add silent-cipher/foc-agent-attic --ref release
codex plugin add attic@attic
```

Then run `/attic:setup` (`$attic setup` in Codex). To update, run `/plugin marketplace update attic` in Claude Code (or enable auto-update for the marketplace in `/plugin`), or `codex plugin marketplace upgrade attic`.

While the repository is private, git on your machine needs access to it, for example through `gh auth login` and `gh auth setup-git`.

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

The calibnet suite also runs from the manual **Calibnet** workflow, with the `ATTIC_CALIBNET_PRIVATE_KEY` repository secret.

Attic stores backups on mainnet only. Calibration guarantees no storage, so it is for testing: set `ATTIC_NETWORK=calibration` (for example `ATTIC_NETWORK=calibration claude --plugin-dir plugins/attic`). A session key is tied to the network it was made on; delete `~/.attic/session.env` to switch.

To try console changes before they reach pay.filecoin.cloud, set `ATTIC_CONSOLE_URL` to a staging, preview or local console (for example `ATTIC_CONSOLE_URL=http://localhost:3000`). Setup's console links then point there.

Try the plugin in Claude Code after `pnpm build`:

```sh
claude --plugin-dir plugins/attic
```

Then run `/attic:version`, or `/attic:setup` to log in, then `/attic:backup <session id>`, `/attic:sessions`, `/attic:refresh` and `/attic:restore <session id>`.

### Releasing

[release-please](https://github.com/googleapis/release-please) keeps a release PR open that bumps the version in `package.json` and both plugin manifests and updates `CHANGELOG.md` from the conventional commit titles merged to `main`. Merging it releases: on that push, the **release-please** workflow runs CI and the calibnet suite on the merge commit, and only once both pass does it tag `vX.Y.Z`, publish the GitHub release with `.github/release-notes.md` above the changelog, build the bundle and push it to the `release` branch. Other pushes to `main` only update the release PR, and never tag an earlier release PR.

If a check fails on a release merge, nothing is tagged. For a flaky failure, re-run the failed jobs of that run. For a real one, fix it on `main`, then remove the `autorelease: pending` label from the merged release PR so release-please opens a new one with the fix; check the version it proposes. If publishing fails after the tag exists, dispatch the workflow on that tag to publish it again (`dry_run` checks it without pushing).

## Logging in

`/attic:setup` makes a session key in `~/.attic/session.env` (owner-readable only) and prints a Filecoin Cloud console link. Approve the key there with your wallet, then paste the Grant (`fgr1_…`) the console shows. Attic never sees the wallet key: the Grant gives the session key the owner's group key, and every backup is encrypted under its `attic` scope. Setup then checks the key is authorized, the storage service is approved and USDFC is available, and says when the key expires. Its console link renews the same session key at any time: approve it again and paste the new Grant.

A Grant can't be revoked: anyone holding `session.env` can read every backup under that group key. Revoking the key on the console's Session keys page stops new uploads.

## Backing up and restoring a session

`/attic:backup` with no arguments (or `$attic backup` in Codex) refreshes the index, then backs up every local session idle for at least 24 hours whose files are missing or changed. It uploads snapshot bytes with at most four transfers at a time and batches the pieces into one add-pieces call per data set, within the provider's batch limits. A run holds at most 256 MiB of sessions in memory: a larger run, such as a machine's first, commits each 256 MiB in its own add-pieces call. With no existing data set, the first successful session uploads alone to establish it, then the rest upload in parallel. A known provider outage fails for retry instead of creating another data set. An empty run sends no transactions. One session's failure leaves the others running; `~/.attic/status.json` records `backedUp`, `skipped` (active, unchanged, or older than the indexed backup), and `failed` counts.

A backup skips a local snapshot older than the indexed backup, with or without an ID, so a stale machine cannot replace a newer backup.

A changed session's old piece is scheduled for removal only after its replacement commits and is indexed, in one removal call per data set and add-pieces call. A failed removal leaves the old piece stored and reports failure; it does not undo the new backup. Existing session keys need `/attic:setup` reauthorization with the new `schedulePieceRemovals` scope before uploading. Backups still use one provider copy.

Only one backup runs per machine, including explicit-ID backups. Another invocation exits while the process whose PID is in `~/.attic/backup.lock` is running. The lock is removed when the run finishes or errors; a lock left by a killed process is replaced by the next run.

`/attic:backup --current` backs up the invoking Claude Code chat; in Codex, use `$attic backup --current`. Active sessions are included, with the bytes available when Attic reads them. Claude Code supplies the ID through its `${CLAUDE_SESSION_ID}` command/skill substitution; Codex supplies `CODEX_THREAD_ID` to the CLI. The CLI also accepts `CLAUDE_SESSION_ID` when explicitly supplied in its environment. Missing or ambiguous current-session context fails with guidance to give an explicit ID; Attic never picks the most recently modified session. Use either `--current` or an ID. Later backups use the same file hashes, so an unchanged snapshot is skipped and a changed session is uploaded again.

`/attic:backup <session id>` backs up one Claude Code session now, even if it is still active: its transcript and its folder of subagents and tool results, under `~/.claude` (or `CLAUDE_CONFIG_DIR`). It checks the session key is authorized and USDFC is available, then packs a header (session ID, project, machine, title, first prompt and git branch when the transcript has them, each file's size and SHA-256) and the files into one piece, encrypts it under a fresh piece key, and stores it with one provider in an Attic data set. Only once the piece is committed does it record the piece in `~/.attic/index.json`, so a failed upload leaves the session to retry. Each index entry records the network, wallet and group key its piece is encrypted under. A session the index already holds unchanged, for the current login, is not uploaded again; after logging in with another wallet or group key, the next backup uploads it again, and restore refuses a backup the current login can't decrypt.

`/attic:restore` accepts a description (for example, `/attic:restore yesterday's funding check`) or no argument: the agent offers the best matches with title, project and date, and restores only the session you choose. In Claude Code it uses a question dialog; in Codex, `$attic restore` asks a plain question. Giving a session ID restores directly without asking. If nothing matches, or an ID is missing from the index, the agent refreshes once and tries again before reporting no backup.

`/attic:restore <session id>` downloads the session's piece, decrypts it, and checks every file's SHA-256 before writing anything. It refuses paths outside the session agent's folder and existing files that differ from the backup, writes the missing files, and prints `claude --resume <session id>`, which resumes the session from any folder.

`/attic:sessions` lists the sessions in the index, newest first (ID, agent, project, last write, encrypted size, git branch, title), with the result of the last backup run, from `~/.attic/status.json`. A Claude Code session's title is the latest one Claude Code gave it, else its first prompt, shortened; sessions backed up before Attic recorded them show none until they change and are backed up again. `/attic:sessions <words>` lists only the sessions whose title, first prompt, project or git branch contain every word, ignoring case. It reads only local files, so it works offline. From 7 days before the Grant expires, it warns to run `/attic:setup` to renew it.

`attic sessions --json` prints only the matching sessions as a JSON array, newest first, each with its session ID, agent, title, first prompt, project, branch and last write (title, first prompt and branch only when recorded). It accepts the same word filters and needs no login; an empty index or no matches produces `[]`.

## Driving the CLI from an agent

`attic --help` lists the commands and exit codes, and `attic <command> --help` shows that command's arguments (required or optional), an example and its `--json` result; both exit 0. With `--json`, `setup`, `backup`, `restore` and `refresh` print one JSON object on stdout when they finish (the readiness checks and console links, the run counts, the resume command, or the refresh counts and skipped pieces) and print their progress on stderr.

Every command exits 0 when done, 1 when it failed, 2 when the owner has to act in the console first (paste a Grant, approve the session key, or deposit USDFC), and 64 for a usage error: wrong arguments, or a bad `ATTIC_NETWORK` or `ATTIC_CONSOLE_URL`. With `--json`, a failure prints `{"error", "message", "retryable"}` on stdout and the message on stderr; a backup run whose sessions or old-piece removal failed adds its counts, with its `✗` lines as the message. `error` is `usage`, `setup` (run setup), `not_found` (refresh the index, or check the ID), `update` (update Attic), `conflict` (local files or the login don't match the backup, so a person has to move, fix or switch them) or `failed`; only `failed` is `retryable`. A `setup` or `backup` result that exits 2 says in `needs` what the owner does first.

## Other machines' backups

`/attic:refresh` adds the sessions other machines backed up to this machine's index. It lists the pieces in the owner's Attic data sets under the login's group key, and decrypts only the start of each piece the index doesn't already hold, where the header is, 8 at a time. It keeps the newest piece of each session, leaves every other entry alone, and reports how many sessions it added or updated. It only reads the chain into the index and never uploads. This needs only the Grant, so sessions can be listed and restored before a new session key is authorized.

If the listing fails, the index is left unchanged. A piece whose header can't be read (its provider is down, or it isn't an Attic session) is reported and left out, and the next refresh tries it again.

The CLI's restore and sessions operations stay local; the restore command and skill run the refresh-and-retry flow when a session is missing. On a machine with no `~/.attic/index.json`, `/attic:setup` runs the same refresh to build it.

The calibnet suite backs up a session, deletes it, restores it, and checks Claude Code can resume it, then restores it on a second machine whose index already exists, through `refresh`, so it needs `claude` on `PATH`.

## Codex sessions and plugin

The same backup, sessions and restore operations also handle Codex rollouts under `~/.codex/sessions` (or `$CODEX_HOME/sessions`). Attic saves the rollout JSONL byte for byte, including an active rollout's incomplete last line, and restores it to the same relative path under the destination Codex home. It reads the project from the initial `session_meta.payload.cwd` and prints `codex resume <id>` after restore. Global history, credentials, config, SQLite databases and archived sessions are not included; each subagent rollout is its own session ID.

Codex sessions show their latest `thread_name` from `session_index.jsonl`, else their first `user_message` event, shortened. The branch comes from `session_meta.payload.git.branch`. These fields are saved in the encrypted header and searchable with `sessions <words>`. A missing or unreadable title index leaves the title out; the index itself is never backed up. Renaming an unchanged rollout does not upload it again: the title updates when the rollout next changes and is backed up.

Codex's [documented plugin components](https://developers.openai.com/plugins/build/plugins) include skills, with no documented equivalent of Claude Code's `commands/` directory. The fallback for #4 is the bundled `$attic` skill: use `$attic setup`, `$attic backup <session id>`, `$attic sessions`, `$attic refresh`, `$attic restore <session id>` or `$attic version`. The CLI's `/attic:…` hints refer to the equivalent Claude Code commands.

For local development, run `pnpm install` and `pnpm build` first. Add the checkout as a local marketplace:

```sh
codex plugin marketplace add /absolute/path/to/foc-agent-attic
```

Install Agent Attic from that marketplace in Codex's plugin browser (`/plugins`), then start a new session. The `.agents/plugins/marketplace.json` catalog points to the same `plugins/attic` folder Claude Code uses. Build before installing: the bundle is generated, not committed. After changing the plugin, rebuild and refresh/reinstall the cached copy.
