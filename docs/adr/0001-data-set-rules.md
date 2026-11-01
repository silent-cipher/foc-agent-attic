# ADR 0001: Data sets and metadata

Status: Accepted 2026-11-01

Source: [issue #19](https://github.com/silent-cipher/foc-agent-attic/issues/19), agreed while planning index refresh and two-copy backups.

## Context

Machines sharing an owner's group key must find each other's backups without exposing session details or multiplying storage fees. Data sets belong to an owner on one network and one provider; pieces hold the encrypted session backups.

The mainnet prices recorded in #19 on 2026-10-31 explain the decisions below; they are historical figures, not a live quote:

| Item | USDFC |
| --- | --- |
| Create a data set | 0.025 |
| Keep a data set | 0.12 per month |
| Reserve per data set | 0.5 |
| Store bytes | 2.5 per TiB per month |
| Add pieces | 0.008 per call, plus 0.003 per piece |

The reserve ties up funds; it is not another monthly fee.

## Decisions

### Metadata finds data sets, never describes sessions

Data set metadata and on-chain piece metadata are public. Agent, project, machine and session ID stay inside the encrypted piece, including its encrypted header. Piece metadata stays unused. Encryption-envelope labels needed to derive a piece key are separate from on-chain piece metadata.

Putting session fields in either metadata surface is rejected because it exposes private session details. Refresh instead decrypts piece headers to identify sessions.

An encrypted summary in piece metadata was also considered to avoid those header reads. The [2026-11-01 follow-up decision](https://github.com/silent-cipher/foc-agent-attic/issues/19#issuecomment-6547527917) deferred it: piece metadata lives only in `PieceAdded` events, and the public Glif RPC tested then limited log queries to 1,000 blocks and retained about a week of logs. Reliable discovery would need filecoin-api and permanent header-read fallback. Refresh reads eight headers concurrently instead. Revisit if Attic adopts filecoin-api for another reason or refresh remains too slow.

### Freeze data set metadata; version the piece header

The complete metadata written for a data set is:

| Key | Value |
| --- | --- |
| `source` | `attic` |
| `foc/enc` | `1` |
| `foc/ks` | Group key ID (keyspace) |
| `foc/kc` | Group key commitment |

Writing reuses a data set only when its metadata matches exactly. Adding even one key makes every owner's next backup open a new data set, with another creation fee, monthly fee and reserve. Adding an agent, project, machine or format-version tag is therefore rejected. Evolve the session format through the version in the encrypted piece header instead.

### Reading matches only source and keyspace

Within the owner's live data sets on the selected network, reading filters metadata only on `source: attic` and the login's keyspace (`foc/ks`). It tolerates extra keys rather than requiring the writer's exact metadata match. Otherwise a later metadata addition could hide readable backups from older readers. Session identity and format come from decrypting the piece header.

### One data set per owner, group key and provider

On each network, all agents, projects and machines share a data set for the same owner, group key and provider. A second provider holds its copy in its own data set. Grouping by agent, project or machine is rejected: it multiplies fixed fees and reserves without improving encryption isolation, since each piece already has its own key.

A lock across machines to enforce unique first creation is rejected. It adds coordination and failure recovery to independent backups. Concurrent first backups can create duplicate data sets; discovery must read all matching data sets so no backup disappears. One data set per tuple is the reuse rule, not an on-chain uniqueness guarantee.

### Stick to known data sets

Once a data set exists, uploads target it by ID. A provider outage must fail or leave the upload to retry; it must never silently open another data set. Automatic replacement is rejected because a temporary outage would create lasting fees and reserves. Replacing a provider is a deliberate step that accounts for the old data set and its backups.

### Batch pieces; keep sessions separate

Each session stays its own piece with its own key. Save the fixed 0.008 USDFC add-pieces fee by adding a run's pieces in one call per target data set; the 0.003 USDFC per-piece fee still applies. Bundling several sessions into one encrypted piece is rejected because it couples their restore and removal and loses the separate key per session.

## Implementation boundary

The [storage adapter](../../src/storage.ts) pins writes to the data set the SDK's `findMatchingDataSets` prefers among those with exactly matching metadata that can still take pieces (live, managed, not terminated), batches uploads with the SDK's explicit flush, and schedules replaced pieces for removal after the new backup commits and is indexed. With no matching data set, the first successful session establishes one before parallel uploads begin. SDK message limits can split oversized batches, and a run commits at most 256 MiB of sessions per add-pieces call to bound memory. Backups still request one copy; two-copy backups and deliberate provider replacement remain separate work. The metadata and read filters follow the rules above; [piece encoding](../../src/piece.ts) gives each session a fresh piece key and a versioned encrypted header.
