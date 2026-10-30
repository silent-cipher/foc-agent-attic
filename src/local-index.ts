import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Address, Hex } from 'viem'
import type { OpenedGrant } from './grant.ts'
import type { Header } from './piece.ts'
import { type Network, writePrivateFile } from './session.ts'
import type { Copy } from './storage.ts'

/**
 * Who can read a piece: the network it is on and the owner's group key it is encrypted under.
 * A login with another Grant, or a calibration test backup, cannot restore it.
 */
export type Keyholder = { network: Network; owner: Address; groupKey: Hex }

export function keyholderOf(network: Network, grant: OpenedGrant): Keyholder {
  return { network, owner: grant.owner, groupKey: grant.grant.keyspace }
}

export function sameKeyholder(a: Keyholder, b: Keyholder): boolean {
  return a.network === b.network && a.owner === b.owner && a.groupKey === b.groupKey
}

/** One backed-up session: its piece header and where the piece is stored. */
export type IndexEntry = Header &
  Keyholder & {
    pieceCid: string
    /** Bytes of the encrypted piece. */
    size: number
    copies: Copy[]
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

/** Whether `entry` already backs up these exact files, readable by `keyholder`. */
export function isUpToDate(entry: IndexEntry, keyholder: Keyholder, files: Header['files']): boolean {
  return sameKeyholder(entry, keyholder) && isDeepStrictEqual(entry.files, files)
}

export function writeIndex(index: Index, path: string): void {
  writePrivateFile(path, `${JSON.stringify(index, null, 2)}\n`)
}
