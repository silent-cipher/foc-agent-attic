# Agent Attic

Attic backs up your Claude Code and Codex sessions, encrypted, to Filecoin Onchain Cloud, so you can restore and resume them later, on this machine or another one.

- **Private.** Each session is encrypted on your machine before it leaves. Storage providers only ever see encrypted bytes.
- **Yours.** Backups belong to your wallet. Attic never sees your wallet key.
- **Findable.** Search backups by title, first prompt, project or git branch, and restore one by describing it.

Attic comes as a plugin for Claude Code and Codex, and as a command-line tool (`attic`). They share the same backups, so use whichever suits you.

## What you need

- **Node 24 or newer.** Check with `node --version`.
- **A Filecoin wallet holding USDFC**, the stablecoin Filecoin Onchain Cloud is paid in, plus a little FIL for the transactions you approve. Setup suggests a 2 USDFC deposit to start.
- **A browser with that wallet**, to approve Attic once in the [Filecoin Cloud console](https://pay.filecoin.cloud).

Attic stores backups on Filecoin mainnet.

## Install

Pick one.

**Claude Code plugin.** In Claude Code, run:

```sh
/plugin marketplace add silent-cipher/foc-agent-attic#release
/plugin install attic@attic
```

**Codex plugin.** In a terminal, run the following, then start a new Codex session:

```sh
codex plugin marketplace add silent-cipher/foc-agent-attic --ref release
codex plugin add attic@attic
```

While this repository is private, installing a plugin needs GitHub access to it, for example through `gh auth login` and `gh auth setup-git`.

**Command line only.** For cron, servers, or without an agent:

```sh
npm install -g foc-agent-attic
```

Or run it without installing, for example `npx foc-agent-attic sessions`.

## Set up

Run setup once on each machine: `/attic:setup` in Claude Code, `$attic setup` in Codex, or `attic setup` in a terminal.

1. Setup prints a console link and a session address. Open the link and approve with your wallet. Check the console shows the same session address.
2. The console shows a **Grant**, a long code starting `fgr1_`. Paste it back into your agent, or run `attic setup --grant fgr1_…`.
3. Setup checks that Attic is approved and that your account holds enough USDFC. If something is missing, it prints a console link that fixes it (deposit USDFC and approve the storage service in one step). Run setup again afterwards.

When every check shows ✓, Attic is ready. Setup also says when your approval expires; Attic warns you 7 days before, and running setup again renews it.

On a new machine, setup also finds the sessions you backed up elsewhere, so you can restore them straight away.

## Use it

| What | Claude Code | Codex | Terminal |
| --- | --- | --- | --- |
| Back up every session idle for a day | `/attic:backup` | `$attic backup` | `attic backup` |
| Back up the chat you're in, now | `/attic:backup --current` | `$attic backup --current` | — |
| Back up one session, now | `/attic:backup <id>` | `$attic backup <id>` | `attic backup <id>` |
| List or search backups | `/attic:sessions [words]` | `$attic sessions [words]` | `attic sessions [words]` |
| Restore a session | `/attic:restore [description or id]` | `$attic restore [description or id]` | `attic restore <id>` |
| Pick up other machines' backups | `/attic:refresh` | `$attic refresh` | `attic refresh` |
| Show the version | `/attic:version` | `$attic version` | `attic --version` |

**Backing up.** A plain backup uploads each session that has been idle for at least 24 hours and is new or changed since its last backup, so it's cheap to run often. Unchanged sessions are skipped. If one session fails, the others still back up; run it again to retry.

**Restoring.** In an agent, describe what you want back, for example `/attic:restore yesterday's funding check`. The agent shows the closest matches and restores the one you pick. Attic checks every file against the backup before writing anything, never overwrites a local file that differs, and then prints the command to resume, such as `claude --resume <id>` or `codex resume <id>`.

**Listing.** `sessions` works offline. It shows each backup's ID, agent, project, date, size, branch and title, and how the last backup run ended.

## Back up automatically

Attic doesn't schedule itself yet. Until it does, run the CLI from cron (macOS or Linux). Find the full path with `command -v attic`, then add a line with `crontab -e`, for example every night at 3:00:

```sh
0 3 * * * /usr/local/bin/attic backup >> ~/.attic/cron.log 2>&1
```

cron runs with a minimal `PATH`, so use the full path to `attic`, and make sure Node 24 is the `node` it finds. Only one backup runs at a time, so an overlapping run simply exits.

## Good to know

- **Keep `~/.attic/session.env` private.** A Grant can't be revoked: anyone holding that file can read every backup made under it. Revoking the session key on the console's Session keys page stops new uploads.
- **One copy.** Each backup is stored with one storage provider for now.
- **What's included.** For Claude Code, a session's transcript and its subagents and tool results. For Codex, the session's rollout file. Settings, credentials and global history are not backed up.
- **Costs.** You pay in USDFC from the deposit in your Filecoin Cloud account. Running setup shows how much is available, and when there isn't enough, backup stops and prints the console link to top up.

## Troubleshooting

- **"Deposit USDFC" or exit code 2.** You need to act in the console first: paste a Grant, approve the session key, or add USDFC. Open the link Attic printed, then run setup again.
- **A session you expected isn't listed.** Run `refresh` to pick up backups from other machines. A plain backup also skips sessions active in the last 24 hours; use `backup --current` or `backup <id>` to back one up now.
- **"Update Attic".** Run `/plugin marketplace update attic` in Claude Code (or turn on auto-update in `/plugin`), `codex plugin marketplace upgrade attic` in Codex, or `npm install -g foc-agent-attic@latest`.

## Scripting and agents

`attic --help` lists every command and exit code, and `attic <command> --help` shows its arguments, an example and its `--json` output. With `--json`, `setup`, `backup`, `restore` and `refresh` print one JSON object on stdout and their progress on stderr, while `sessions --json` prints a JSON array of the matching sessions, `[]` when none match. Exit codes are 0 done, 1 failed, 2 the owner has to act in the console, and 64 for a usage error.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, testing, releasing, and the detailed rules Attic follows.

## License

Dual-licensed under [Apache-2.0 or MIT](LICENSE.md).
