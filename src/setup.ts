import { hostname } from 'node:os'
import { publicKeyOf } from '@filoz/keysmith'
import { getAccountSummary, isFwssMaxApproved } from '@filoz/synapse-core/pay'
import { getExpirations } from '@filoz/synapse-core/session-key'
import { type Address, createPublicClient, formatUnits, http, parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { type OpenedGrant, openGrant } from './grant.ts'
import { type Header, openPiece, sealPiece } from './piece.ts'
import { CHAINS, type Network, readSession, type Session, sessionPath, writeSession } from './session.ts'
import { PERMISSIONS } from './storage.ts'

// The spike's exact deposit left 0 USDFC available, and the next upload then failed.
export const MIN_AVAILABLE_USDFC = 1
const SUGGESTED_DEPOSIT_USDFC = 2

export type SetupOptions = { network: Network; consoleUrl: string; grant?: string }

/**
 * Logs this machine in through the Filecoin Cloud console and reports whether backups can run.
 * Each run does what is still missing, so it is safe to repeat.
 *
 * @returns 0 when ready, 2 when the owner still has something to do.
 */
export async function setup(options: SetupOptions, print: (line: string) => void): Promise<number> {
  const path = sessionPath()
  let session = readSession(path, options.network)
  if (session === undefined) {
    session = { sessionKey: generatePrivateKey(), network: options.network }
    writeSession(session, path)
    print(`✓ New session key saved to ${path} (owner-readable only)`)
  }
  const chain = CHAINS[session.network]
  const sessionAddress = privateKeyToAccount(session.sessionKey).address
  print(`Session key ${sessionAddress} on ${session.network}`)

  const grant = await saveOrOpenGrant(session, options.grant, chain.id, path, print)
  const approveUrl = await authorizeUrl(options.consoleUrl, session, sessionAddress)
  if (grant === undefined) {
    print('Approve this session key in the Filecoin Cloud console, then copy the Grant it shows:')
    print(approveUrl)
    print(`The console must show session address ${sessionAddress}.`)
    print('Then run setup again with --grant <Grant>.')
    return 2
  }

  const client = createPublicClient({ chain, transport: http() })
  const [expirations, storageApproved, account] = await Promise.all([
    getExpirations(client, { address: grant.owner, sessionKeyAddress: sessionAddress, permissions: PERMISSIONS }),
    isFwssMaxApproved(client, { clientAddress: grant.owner }),
    getAccountSummary(client, { address: grant.owner }),
  ])
  const authorizedUntil = Math.min(...PERMISSIONS.map((p) => Number(expirations[p] ?? 0n)))
  return reportReadiness(
    {
      owner: grant.owner,
      authorizedUntil,
      grantExpires: grant.expires,
      storageApproved,
      availableFunds: account.availableFunds,
      approveUrl,
      fundingUrl: fundingUrl(options.consoleUrl, session.network),
    },
    print
  )
}

/** The console page that deposits USDFC and approves the storage service in one step. */
export function fundingUrl(consoleUrl: string, network: Network): string {
  return `${consoleUrl}/console?deposit=${SUGGESTED_DEPOSIT_USDFC}&operator=fwss&network=${network}`
}

/** USDFC base units (18 decimals) as a number with two decimals, the way setup and backup print them. */
export function usdfc(amount: bigint): string {
  return Number(formatUnits(amount, 18)).toFixed(2)
}

/** Whether `availableFunds` (USDFC base units) leave enough headroom for the next upload. */
export function hasMinimumFunds(availableFunds: bigint): boolean {
  return availableFunds >= parseUnits(String(MIN_AVAILABLE_USDFC), 18)
}

async function saveOrOpenGrant(
  session: Session,
  text: string | undefined,
  chainId: number,
  path: string,
  print: (line: string) => void
): Promise<OpenedGrant | undefined> {
  if (text !== undefined) {
    const grant = await openGrant(text, session.sessionKey, chainId)
    // Saved only once its key has sealed and opened a piece in the attic scope.
    const probe: Omit<Header, 'files'> = {
      v: 1,
      agent: 'claude-code',
      sessionId: 'setup',
      project: null,
      machine: hostname(),
      lastWriteAt: new Date().toISOString(),
    }
    await openPiece(grant, (await sealPiece(grant, probe, [])).envelope)
    writeSession({ ...session, grant: grant.text }, path)
    print(`✓ Grant saved for group key ${grant.grant.keyspace} of ${grant.owner}`)
    print('  It gives this session key permanent read access to everything under that group key.')
    return grant
  }
  if (session.grant === undefined) return undefined
  try {
    return await openGrant(session.grant, session.sessionKey, chainId)
  } catch (error) {
    print(`✗ The saved Grant no longer opens. ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

async function authorizeUrl(consoleUrl: string, session: Session, sessionAddress: Address): Promise<string> {
  // With pubkey, the console also issues a Grant for the whole group key (node=keyspace), wrapped to it.
  const pubkey = publicKeyOf(session.sessionKey).toLowerCase()
  const pubkeysig = await privateKeyToAccount(session.sessionKey).signMessage({
    message: `Keysmith key agreement key: ${pubkey}`,
  })
  // Lowercase: the console's strict address check refuses a mixed-case address with a bad checksum.
  return `${consoleUrl}/console/setup?authorize=${sessionAddress.toLowerCase()}&scopes=createDataSet,addPieces&network=${session.network}&pubkey=${pubkey}&pubkeysig=${pubkeysig}&node=keyspace`
}

/** What the chain says about the owner's account and this session key. */
export type Readiness = {
  owner: Address
  /** Unix seconds; 0 when the owner never authorized the key. */
  authorizedUntil: number
  /** Unix seconds. */
  grantExpires: number
  storageApproved: boolean
  /** USDFC base units (18 decimals). */
  availableFunds: bigint
  approveUrl: string
  fundingUrl: string
}

/** Prints the readiness checklist and the console links that fix what is missing; returns the exit code. */
export function reportReadiness(
  r: Readiness,
  print: (line: string) => void,
  now = Math.floor(Date.now() / 1000)
): number {
  const authorized = r.authorizedUntil > now
  const funded = hasMinimumFunds(r.availableFunds)
  const available = usdfc(r.availableFunds)
  print(authorized ? '✓ Session key authorized' : `✗ Session key not authorized by ${r.owner}`)
  print(r.storageApproved ? '✓ Storage service approved' : '✗ Storage service not approved')
  print(
    funded ? `✓ ${available} USDFC available` : `✗ ${available} USDFC available (keep at least ${MIN_AVAILABLE_USDFC})`
  )
  if (authorized) {
    const expires = Math.min(r.authorizedUntil, r.grantExpires)
    const days = Math.floor((expires - now) / 86_400)
    print(`Session key expires ${new Date(expires * 1000).toISOString().slice(0, 10)} (in ${days} days).`)
    print('To renew it before then, approve it again in the console and run setup with the new Grant:')
  } else {
    print('Approve this session key in the Filecoin Cloud console:')
  }
  print(r.approveUrl)
  if (!r.storageApproved || !funded) {
    print('Deposit USDFC and approve the storage service in one step:')
    print(r.fundingUrl)
  }
  return authorized && r.storageApproved && funded ? 0 : 2
}
