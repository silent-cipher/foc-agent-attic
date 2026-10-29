import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { type Hex, isHex, size } from 'viem'

export type Network = 'mainnet' | 'calibration'

/** What `~/.attic/session.env` holds. The Grant is absent until the owner pastes one. */
export type Session = { sessionKey: Hex; network: Network; grant?: string }

export function sessionPath(): string {
  return join(homedir(), '.attic', 'session.env')
}

/**
 * Reads the saved session, or undefined when there is none.
 *
 * @throws When the file exists but is not a session, so a stray edit never replaces an authorized key.
 */
export function readSession(path: string): Session | undefined {
  if (!existsSync(path)) return undefined
  const { SESSION_KEY: sessionKey, NETWORK: network, GRANT: grant } = parseEnv(readFileSync(path, 'utf8'))
  if (
    sessionKey === undefined ||
    !isHex(sessionKey) ||
    size(sessionKey) !== 32 ||
    (network !== 'mainnet' && network !== 'calibration')
  ) {
    throw new Error(`${path} is not an Attic session file. Fix it, or delete it to start over with a new key.`)
  }
  return grant === undefined ? { sessionKey, network } : { sessionKey, network, grant }
}

/** Replaces the saved session in one rename, owner-readable only. */
export function writeSession(session: Session, path: string): void {
  const lines = [
    '# Attic session key. Delete this file to start over with a new key.',
    `SESSION_KEY=${session.sessionKey}`,
    `NETWORK=${session.network}`,
  ]
  if (session.grant !== undefined) lines.push(`GRANT=${session.grant}`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  // Removed first: `mode` applies only to a file the write creates.
  rmSync(tmp, { force: true })
  writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}
