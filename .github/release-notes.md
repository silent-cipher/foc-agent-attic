Attic backs up Claude Code and Codex sessions, encrypted, to Filecoin Onchain Cloud. It stores backups on mainnet only and needs Node 24 or newer.

**Install**

- Claude Code: `/plugin marketplace add silent-cipher/foc-agent-attic#release`, then `/plugin install attic@attic`.
- Codex: `codex plugin marketplace add silent-cipher/foc-agent-attic --ref release`, then `codex plugin add attic@attic`.

Then run `/attic:setup` (`$attic setup` in Codex) to log in. To update, run `/plugin marketplace update attic` in Claude Code or `codex plugin marketplace upgrade attic`.

**Trade-offs**

- A Grant can't be revoked: anyone holding `~/.attic/session.env` can read every backup under its group key. Revoking the session key on the console stops new uploads.
- Each backup is stored as one copy with one provider.

