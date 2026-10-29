# Agent Attic

A Claude Code and Codex plugin that backs up agent sessions, encrypted, to Filecoin Onchain Cloud.

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

Then run `/attic:version`, or `/attic:setup` to log in, then `/attic:backup <session id>` and `/attic:restore <session id>`.

## Logging in

`/attic:setup` makes a session key in `~/.attic/session.env` (owner-readable only) and prints a Filecoin Cloud console link. Approve the key there with your wallet, then paste the Grant (`fgr1_…`) the console shows. Attic never sees the wallet key: the Grant gives the session key the owner's group key, and every backup is encrypted under its `attic` scope. Setup then checks the key is authorized, the storage service is approved and USDFC is available, and says when the key expires. Its console link renews the same session key at any time: approve it again and paste the new Grant.

A Grant can't be revoked: anyone holding `session.env` can read every backup under that group key. Revoking the key on the console's Session keys page stops new uploads.

## Backing up and restoring a session

`/attic:backup <session id>` backs up one Claude Code session now, even if it is still active: its transcript and its folder of subagents and tool results, under `~/.claude` (or `CLAUDE_CONFIG_DIR`). It checks the session key is authorized and USDFC is available, then packs a header (session ID, project, machine, each file's size and SHA-256) and the files into one piece, encrypts it under a fresh piece key, and stores it on 2 providers in Attic's own data sets. Only once both copies are committed does it record the piece in `~/.attic/index.json`, so a failed upload leaves nothing to clean up: run it again. A session the index already holds unchanged is not uploaded again.

`/attic:restore <session id>` downloads the session's piece, decrypts it, and checks every file's SHA-256 before writing anything. It refuses paths outside Claude Code's folder and existing files that differ from the backup, writes the missing files, and prints `claude --resume <session id>`, which resumes the session from any folder.

The calibnet suite backs up a session, deletes it, restores it, and checks Claude Code can resume it, so it needs `claude` on `PATH`.
