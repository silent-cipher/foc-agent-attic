import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { calibration, mainnet } from '@filoz/synapse-core/chains'
import { type Hex, isHex, size } from 'viem'
import { type OpenedGrant, openGrant } from './grant.ts'

export const CHAINS = { mainnet, calibration }

/** Tags Attic's data sets, apart from other apps' data sets on the same wallet. */
export const SOURCE = 'attic'

export type Network = keyof typeof CHAINS

/** What `~/.attic/session.env` holds. The Grant is absent until the owner pastes one. */
export type Session = { sessionKey: Hex; network: Network; grant?: string }

export function sessionPath(): string {
  return join(homedir(), '.attic', 'session.env')
}

/**
 * Reads the saved session, or undefined when there is none.
 *
 * @throws When the file exists but is not a session, so a stray edit never replaces an authorized key,
 * or when it is for another network than `network`.
 */
export function readSession(path: string, network: Network): Session | undefined {
  if (!existsSync(path)) return undefined
  const { SESSION_KEY: sessionKey, NETWORK: savedNetwork, GRANT: grant } = parseEnv(readFileSync(path, 'utf8'))
  if (
    sessionKey === undefined ||
    !isHex(sessionKey) ||
    size(sessionKey) !== 32 ||
    (savedNetwork !== 'mainnet' && savedNetwork !== 'calibration')
  ) {
    throw new Error(`${path} is not an Attic session file. Fix it, or delete it to start over with a new key.`)
  }
  if (savedNetwork !== network) {
    throw new Error(`The saved session key is for ${savedNetwork}, not ${network}. Delete ${path} to start over.`)
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
  writePrivateFile(path, `${lines.join('\n')}\n`)
}

/** Replaces a file under `~/.attic` in one rename, so a crash never leaves it half-written. Owner-readable only. */
export function writePrivateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  // Removed first: `mode` applies only to a file the write creates.
  rmSync(tmp, { force: true })
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}

/** A session the owner has logged in: its key and the Grant opened for it. */
export type Login = { sessionKey: Hex; grant: OpenedGrant }

/**
 * Opens the saved session's Grant for `network`.
 *
 * @throws Saying to run `/attic:setup` when there is no usable login.
 */
export async function openLogin(network: Network): Promise<Login> {
  const path = sessionPath()
  const session = readSession(path, network)
  if (session?.grant === undefined) throw new Error('Attic is not logged in. Run /attic:setup first.')
  try {
    const grant = await openGrant(session.grant, session.sessionKey, CHAINS[network].id)
    return { sessionKey: session.sessionKey, grant }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Run /attic:setup to log in again.`)
  }
}
