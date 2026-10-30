import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type Keyholder, sameKeyholder, writePrivateFile } from './login.ts'
import type { Header } from './piece.ts'
import type { Copy } from './storage.ts'

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

/** Records `entry` as its session's newest backup, keeping every other session's entry. */
export function recordEntry(entry: IndexEntry): void {
  const path = indexPath()
  const index = readIndex(path)
  index.sessions[entry.sessionId] = entry
  writePrivateFile(path, `${JSON.stringify(index, null, 2)}\n`)
}

function indexPath(): string {
  return join(homedir(), '.attic', 'index.json')
}

/** Reads the index, or an empty one when there is none. */
function readIndex(path: string): Index {
  if (!existsSync(path)) return { sessions: {} }
  const index = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof index?.sessions !== 'object' || index.sessions === null) {
    throw new Error(`${path} is not an Attic index. Fix it, or move it away.`)
  }
  return index
}

/** Whether `entry` already backs up these exact files, readable by `keyholder`. */
export function isUpToDate(entry: IndexEntry, keyholder: Keyholder, files: Header['files']): boolean {
  return sameKeyholder(entry, keyholder) && isDeepStrictEqual(entry.files, files)
}
