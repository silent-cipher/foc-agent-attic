import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AtticError } from './errors.ts'
import { type Keyholder, type Login, sameKeyholder, writePrivateFile } from './login.ts'
import { type Header, readHeader } from './piece.ts'
import type { Copy, Storage } from './storage.ts'

/** One backed-up session: its piece header and where the piece is stored. */
export type IndexEntry = Header &
  Keyholder & {
    pieceCid: string
    /** Bytes of the encrypted piece. */
    size: number
    copies: Copy[]
  }

/** What `~/.attic/index.json` holds: the newest backup of each session, by session ID. */
type Index = { sessions: Record<string, IndexEntry> }

/** The index's entry for a session, or undefined when it has no backup here. */
export function indexEntry(sessionId: string): IndexEntry | undefined {
  return readIndex(indexPath()).sessions[sessionId]
}

/** Records the newest backup and returns superseded copies this keyholder can remove. */
export function recordEntry(entry: IndexEntry): Copy[] {
  const path = indexPath()
  const index = readIndex(path)
  const known = index.sessions[entry.sessionId]
  // A refresh during the upload can index a newer piece; removing it would lose that backup.
  if (known !== undefined && hasNewer(known, entry, entry.lastWriteAt)) return []
  index.sessions[entry.sessionId] = entry
  writePrivateFile(path, `${JSON.stringify(index, null, 2)}\n`)
  return known !== undefined && sameKeyholder(known, entry) && known.pieceCid !== entry.pieceCid ? known.copies : []
}

/** Every session the index holds. */
export function indexEntries(): IndexEntry[] {
  return Object.values(readIndex(indexPath()).sessions)
}

/** Whether this machine has an index, even an empty one. */
export function hasIndex(): boolean {
  return existsSync(indexPath())
}

/** What a refresh added or updated, how many sessions the index then holds, and the pieces it couldn't read. */
export type RefreshResult = {
  added: number
  updated: number
  sessions: number
  skippedPieces: { pieceCid: string; error: string }[]
}

/** How many piece headers a refresh reads at once. */
const HEADER_READS = 8

/**
 * Adds the login's pieces on chain that the index doesn't hold yet, keeping each session's newest piece and
 * leaving every other entry alone. Writes the index only once every header is read, so a failed listing changes
 * nothing. A piece whose header can't be read is skipped and reported, and read again by the next refresh.
 */
export async function refreshIndex(
  login: Login,
  storage: Storage,
  print: (line: string) => void
): Promise<RefreshResult> {
  const held = new Set(indexEntries().map((entry) => entry.pieceCid))
  const listed = await storage.pieces()
  const onChain = new Set(listed.map((piece) => piece.pieceCid))
  // ponytail: a session's older pieces and pieces that aren't sessions are never held, so every refresh reads
  // their headers again; remember them in the index if removal (#5) doesn't keep them few.
  const pieces = listed.filter((piece) => !held.has(piece.pieceCid))
  print(`Found ${listed.length} pieces on chain, ${pieces.length} not in the index`)
  const found: IndexEntry[] = []
  const skippedPieces: RefreshResult['skippedPieces'] = []
  const queue = pieces.values()
  await Promise.all(
    Array.from({ length: HEADER_READS }, async () => {
      for (const piece of queue) {
        try {
          const header = await readHeader(login.grant, piece)
          found.push({
            ...header,
            ...login.keyholder,
            pieceCid: piece.pieceCid,
            size: piece.size,
            copies: piece.copies,
          })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          skippedPieces.push({ pieceCid: piece.pieceCid, error: reason })
          print(`✗ Skipped piece ${piece.pieceCid}: ${reason}`)
        }
      }
    })
  )

  // Read again after the slow part, so a backup that finished meanwhile keeps its entry.
  const path = indexPath()
  const index = readIndex(path)
  let added = 0
  let updated = 0
  // Newest first, so a session's older pieces found in the same refresh are not counted.
  for (const entry of found.toSorted((a, b) => b.lastWriteAt.localeCompare(a.lastWriteAt))) {
    const known = index.sessions[entry.sessionId]
    // An entry this login can't decrypt, or whose piece was removed, loses to any piece it can read.
    if (
      known !== undefined &&
      sameKeyholder(known, login.keyholder) &&
      onChain.has(known.pieceCid) &&
      known.lastWriteAt >= entry.lastWriteAt
    )
      continue
    if (known === undefined) added++
    else updated++
    index.sessions[entry.sessionId] = entry
  }
  writePrivateFile(path, `${JSON.stringify(index, null, 2)}\n`)
  const sessions = Object.keys(index.sessions).length
  print(
    added + updated === 0
      ? `✓ The index is already up to date: ${sessions} sessions`
      : `✓ Index refreshed: ${added} new sessions, ${updated} updated`
  )
  return { added, updated, sessions, skippedPieces }
}

function indexPath(): string {
  return join(homedir(), '.attic', 'index.json')
}

/** Reads the index, or an empty one when there is none. */
function readIndex(path: string): Index {
  if (!existsSync(path)) return { sessions: {} }
  const index = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof index?.sessions !== 'object' || index.sessions === null) {
    throw new AtticError('conflict', `${path} is not an Attic index. Fix it, or move it away.`)
  }
  return index
}

/** Whether `entry` backs up a snapshot newer than `lastWriteAt`, readable by `keyholder`. */
export function hasNewer(entry: IndexEntry, keyholder: Keyholder, lastWriteAt: string): boolean {
  return sameKeyholder(entry, keyholder) && entry.lastWriteAt > lastWriteAt
}

/** Whether `entry` already backs up these exact files, readable by `keyholder`. */
export function isUpToDate(entry: IndexEntry, keyholder: Keyholder, files: Header['files']): boolean {
  return sameKeyholder(entry, keyholder) && isDeepStrictEqual(entry.files, files)
}
