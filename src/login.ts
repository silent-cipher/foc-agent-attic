import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { calibration, mainnet } from '@filoz/synapse-core/chains'
import { type Address, type Hex, isHex, size } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { AtticError } from './errors.ts'
import { type OpenedGrant, openGrant } from './grant.ts'
import { type Header, openPiece, sealPiece } from './piece.ts'

export const CHAINS = { mainnet, calibration }

export type Network = keyof typeof CHAINS

/**
 * Who can read a piece: the network it is on and the owner's group key it is encrypted under.
 * A login with another Grant, or a calibration test backup, cannot restore it.
 */
export type Keyholder = { network: Network; owner: Address; groupKey: Hex }

export function sameKeyholder(a: Keyholder, b: Keyholder): boolean {
  return a.network === b.network && a.owner === b.owner && a.groupKey === b.groupKey
}

/** A session key whose Grant opened, on the network both are for. */
export type Login = { sessionKey: Hex; grant: OpenedGrant; keyholder: Keyholder }

/** What `~/.attic/session.env` holds. The Grant is absent until the owner pastes one. */
type SavedLogin = { sessionKey: Hex; network: Network; grant?: string }

/**
 * Opens the saved login for `network`.
 *
 * @throws Saying to run `attic setup` when there is no usable login.
 */
export async function openLogin(network: Network): Promise<Login> {
  const saved = readSavedLogin(loginPath(), network)
  if (saved?.grant === undefined) throw new AtticError('setup', 'Attic is not logged in. Run attic setup first.')
  try {
    return await open(saved, saved.grant)
  } catch (error) {
    throw new AtticError(
      'setup',
      `${error instanceof Error ? error.message : String(error)} Run attic setup to log in again.`
    )
  }
}

/**
 * Logs this machine in as far as it can: saves a new session key when there is none, then saves `grant`
 * once it opens and its key seals and opens a piece, or else opens the saved Grant.
 * Each run does what is still missing, so it is safe to repeat.
 *
 * @returns The session key, and the login once a Grant opens for it.
 * @throws When `grant` is refused, with the reason, safe to print; nothing is saved then.
 */
export async function logIn(
  network: Network,
  grant: string | undefined,
  print: (line: string) => void
): Promise<{ sessionKey: Hex; login: Login | undefined }> {
  const path = loginPath()
  let saved = readSavedLogin(path, network)
  if (saved === undefined) {
    saved = { sessionKey: generatePrivateKey(), network }
    writeSavedLogin(saved, path)
    print(`✓ New session key saved to ${path} (owner-readable only)`)
  }
  const { sessionKey } = saved
  print(`Session key ${privateKeyToAccount(sessionKey).address} on ${network}`)
  if (grant !== undefined) {
    const login = await open(saved, grant)
    // Saved only once its key has sealed and opened a piece in the attic scope.
    const probe: Omit<Header, 'v' | 'files'> = {
      agent: 'claude-code',
      sessionId: 'setup',
      project: null,
      machine: 'setup',
      lastWriteAt: '1970-01-01T00:00:00.000Z',
    }
    await openPiece(login.grant, (await sealPiece(login.grant, probe, [])).envelope)
    writeSavedLogin({ ...saved, grant: login.grant.text }, path)
    print(`✓ Grant saved for group key ${login.keyholder.groupKey} of ${login.keyholder.owner}`)
    print('  It gives this session key permanent read access to everything under that group key.')
    return { sessionKey, login }
  }
  if (saved.grant === undefined) return { sessionKey, login: undefined }
  try {
    return { sessionKey, login: await open(saved, saved.grant) }
  } catch (error) {
    print(`✗ The saved Grant no longer opens. ${error instanceof Error ? error.message : String(error)}`)
    return { sessionKey, login: undefined }
  }
}

async function open(saved: SavedLogin, text: string): Promise<Login> {
  const grant = await openGrant(text, saved.sessionKey, CHAINS[saved.network].id)
  const keyholder = { network: saved.network, owner: grant.owner, groupKey: grant.grant.keyspace }
  return { sessionKey: saved.sessionKey, grant, keyholder }
}

function loginPath(): string {
  return join(homedir(), '.attic', 'session.env')
}

/**
 * Reads the saved login, or undefined when there is none.
 *
 * @throws When the file exists but is not a login, so a stray edit never replaces an authorized key,
 * or when it is for another network than `network`.
 */
function readSavedLogin(path: string, network: Network): SavedLogin | undefined {
  if (!existsSync(path)) return undefined
  const { SESSION_KEY: sessionKey, NETWORK: savedNetwork, GRANT: grant } = parseEnv(readFileSync(path, 'utf8'))
  if (
    sessionKey === undefined ||
    !isHex(sessionKey) ||
    size(sessionKey) !== 32 ||
    (savedNetwork !== 'mainnet' && savedNetwork !== 'calibration')
  ) {
    throw new AtticError(
      'conflict',
      `${path} is not an Attic session file. Fix it, or delete it to start over with a new key.`
    )
  }
  if (savedNetwork !== network) {
    throw new AtticError(
      'conflict',
      `The saved session key is for ${savedNetwork}, not ${network}. Delete ${path} to start over.`
    )
  }
  return grant === undefined ? { sessionKey, network } : { sessionKey, network, grant }
}

function writeSavedLogin(saved: SavedLogin, path: string): void {
  const lines = [
    '# Attic session key. Delete this file to start over with a new key.',
    `SESSION_KEY=${saved.sessionKey}`,
    `NETWORK=${saved.network}`,
  ]
  if (saved.grant !== undefined) lines.push(`GRANT=${saved.grant}`)
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
