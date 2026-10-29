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

Try the plugin in Claude Code after `pnpm build`:

```sh
claude --plugin-dir plugins/attic
```

Then run `/attic:version`, or `/attic:setup` to log in.

## Logging in

`/attic:setup` makes a session key in `~/.attic/session.env` (owner-readable only) and prints a Filecoin Cloud console link. Approve the key there with your wallet, then paste the Grant (`fgr1_…`) the console shows. Attic never sees the wallet key: the Grant gives the session key the owner's group key, and every backup is encrypted under its `attic` scope. Setup then checks the key is authorized, the storage service is approved and USDFC is available, and says when the key expires.

A Grant can't be revoked: anyone holding `session.env` can read every backup under that group key. Revoking the key on the console's Session keys page stops new uploads.
