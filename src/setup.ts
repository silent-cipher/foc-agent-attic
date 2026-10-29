import { publicKeyOf } from '@filoz/keysmith'
import { calibration, mainnet } from '@filoz/synapse-core/chains'
import { getAccountSummary, isFwssMaxApproved } from '@filoz/synapse-core/pay'
import { AddPiecesPermission, CreateDataSetPermission, getExpirations } from '@filoz/synapse-core/session-key'
import { type Address, createPublicClient, formatUnits, http, parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { decrypt, encrypt } from './envelope.ts'
import { type OpenedGrant, openGrant } from './grant.ts'
import { type Network, readSession, type Session, sessionPath, writeSession } from './session.ts'

const CHAINS = { mainnet, calibration }
const PERMISSIONS = [CreateDataSetPermission, AddPiecesPermission]
// The spike's exact deposit left 0 USDFC available, and the next upload then failed.
const MIN_AVAILABLE_USDFC = 1
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
  let session = readSession(path)
  if (session === undefined) {
    session = { sessionKey: generatePrivateKey(), network: options.network }
    writeSession(session, path)
    print(`✓ New session key saved to ${path} (owner-readable only)`)
  } else if (options.network !== session.network) {
    throw new Error(
      `The saved session key is for ${session.network}, not ${options.network}. Delete ${path} to start over.`
    )
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
      fundingUrl: `${options.consoleUrl}/console?deposit=${SUGGESTED_DEPOSIT_USDFC}&operator=fwss&network=${session.network}`,
    },
    print
  )
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
    // Saved only once its key has written and read back an envelope in the attic scope.
    await decrypt(grant, await encrypt(grant, new TextEncoder().encode('attic')))
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
  const funded = r.availableFunds >= parseUnits(String(MIN_AVAILABLE_USDFC), 18)
  const usdfc = Number(formatUnits(r.availableFunds, 18)).toFixed(2)
  print(authorized ? '✓ Session key authorized' : `✗ Session key not authorized by ${r.owner}`)
  print(r.storageApproved ? '✓ Storage service approved' : '✗ Storage service not approved')
  print(funded ? `✓ ${usdfc} USDFC available` : `✗ ${usdfc} USDFC available (keep at least ${MIN_AVAILABLE_USDFC})`)
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
