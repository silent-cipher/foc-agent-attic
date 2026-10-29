import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Header } from './piece.ts'
import type { Network } from './session.ts'

/** One backed-up session: its piece header and where the piece is stored. */
export type IndexEntry = Header & {
  /** Where the piece is: a calibration test backup is no backup on mainnet. */
  network: Network
  pieceCid: string
  /** Bytes of the encrypted piece. */
  size: number
  /** One per copy. Ids are decimal strings, since JSON has no bigint. */
  copies: { providerId: string; dataSetId: string; pieceId: string }[]
}

/** What `~/.attic/index.json` holds: the newest backup of each session, by session ID. */
export type Index = { sessions: Record<string, IndexEntry> }

export function indexPath(): string {
  return join(homedir(), '.attic', 'index.json')
}

/** Reads the index, or an empty one when there is none. */
export function readIndex(path: string): Index {
  if (!existsSync(path)) return { sessions: {} }
  const index = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof index?.sessions !== 'object' || index.sessions === null) {
    throw new Error(`${path} is not an Attic index. Fix it, or move it away.`)
  }
  return index
}

/** Replaces the index in one rename, so a crash never leaves it half-written. Owner-readable only. */
export function writeIndex(index: Index, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  // Removed first: `mode` applies only to a file the write creates.
  rmSync(tmp, { force: true })
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}
