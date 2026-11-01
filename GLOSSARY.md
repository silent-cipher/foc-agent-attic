# Agent Attic

Backs up coding agents' chat sessions, encrypted, to Filecoin Onchain Cloud, and restores them on any machine logged in with the same wallet.

## Sessions

**Agent**:
A coding agent whose sessions Attic backs up: Claude Code or Codex.
_Avoid_: Tool, client

**Session**:
One agent conversation: its transcript plus the files the agent keeps beside it (subagents, tool results), identified by the agent's session ID.
_Avoid_: Chat, conversation, rollout (Codex's word for the same thing)

**Agent home**:
The folder an agent keeps its sessions under (`~/.claude` or `~/.codex`, or their env overrides). Session file paths are relative to it.

**Due session**:
A session the next run should upload: idle for 24 hours and missing from the index or changed since its last piece.

**Current session**:
The session the command was run from, backed up even though it is still active.

## Backups

**Piece**:
One session's backup on Filecoin: a header and the session's files, encrypted as one envelope. Each piece has its own key.
_Avoid_: Blob, archive, upload

**Header**:
The plaintext start of a piece that describes the session (ID, agent, project, machine, each file's size and hash). Readable without reading the rest of the piece.
_Avoid_: Manifest

**Index**:
This machine's record of the newest piece of each session. A cache: a refresh from an empty index recreates it from the pieces on chain.
_Avoid_: Manifest, catalog, database

**Refresh**:
Reading the pieces on chain that the index doesn't hold yet into the index, so sessions other machines backed up can be listed and restored here. Never uploads.
_Avoid_: Sync, rebuild

**Pending removal**:
An older piece of a session whose newer piece has committed, waiting to be removed from its data set.

**Run**:
One pass of backing up: every due session, or the one session named. At most one run per machine at a time.
_Avoid_: Job (the OS scheduler's word for what starts a run), sync

**Data set**:
Attic's storage on Filecoin for one owner, group key and provider, holding their pieces across agents, projects and machines. See [the data set rules](docs/adr/0001-data-set-rules.md).

## Login

**Owner**:
The wallet whose funds pay for storage and whose group key encrypts the backups. Never on the machine.
_Avoid_: User, account

**Session key**:
A key Attic makes on the machine that the owner authorizes to store pieces for a limited time. Unrelated to a session.
_Avoid_: Agent key, device key

**Grant**:
What the console gives a session key so it can derive the owner's group key. Can't be revoked.

**Group key**:
The owner's key that every piece key derives from. Whoever holds a Grant for it can read every backup under it.

**Keyholder**:
The network, owner and group key a piece is encrypted under. A login can restore a piece only when its keyholder matches.

**Login**:
A session key, its Grant and the network they are for, saved on the machine.
_Avoid_: Session (taken by the agent's session), credentials

## Funding

**Headroom**:
The USDFC that must stay available after a run's uploads are paid, so the next run doesn't fail.
