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
```

Try the plugin in Claude Code after `pnpm build`:

```sh
claude --plugin-dir plugins/attic
```

Then run `/attic:version`.
