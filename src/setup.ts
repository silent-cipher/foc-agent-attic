import { publicKeyOf } from '@filoz/keysmith'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { checkFunding, fundingUrl } from './funding.ts'
import { hasIndex, type RefreshResult, refreshIndex } from './local-index.ts'
import { logIn, type Network } from './login.ts'
import type { Account, Connect } from './storage.ts'

export type SetupOptions = { network: Network; consoleUrl: string; grant?: string }

/** How setup ended: waiting for a Grant, or the readiness checks, with the refresh that built a missing index. */
export type SetupResult =
  | { code: 2; needs: 'grant'; sessionAddress: Address; approveUrl: string }
  | (ReadinessResult & { refresh?: RefreshResult })

/**
 * Logs this machine in through the Filecoin Cloud console, reports whether backups can run, and builds the
 * index from the chain when this machine has none.
 * Each run does what is still missing, so it is safe to repeat.
 *
 * @returns Code 0 when ready, 2 when the owner still has something to do.
 */
export async function setup(
  options: SetupOptions,
  print: (line: string) => void,
  connect: Connect
): Promise<SetupResult> {
  const { sessionKey, login } = await logIn(options.network, options.grant, print)
  const sessionAddress = privateKeyToAccount(sessionKey).address
  const approveUrl = await authorizeUrl(options.consoleUrl, options.network, sessionKey)
  if (login === undefined) {
    print('Approve this session key in the Filecoin Cloud console, then copy the Grant it shows:')
    print(approveUrl)
    print(`The console must show session address ${sessionAddress}.`)
    print('Then run setup again with --grant <Grant>.')
    return { code: 2, needs: 'grant', sessionAddress, approveUrl }
  }

  const storage = connect(login, print)
  const [authorizedUntil, account] = await Promise.all([storage.authorizedUntil(), storage.account()])
  const readiness = reportReadiness(
    {
      owner: login.grant.owner,
      authorizedUntil,
      grantExpires: login.grant.expires,
      ...account,
      approveUrl,
      fundingUrl: fundingUrl(options.consoleUrl, options.network),
    },
    print
  )
  // Reading pieces needs only the Grant, so a new machine can list and restore before the key is authorized.
  if (hasIndex()) return readiness
  return { ...readiness, refresh: await refreshIndex(login, storage, print) }
}

async function authorizeUrl(consoleUrl: string, network: Network, sessionKey: Hex): Promise<string> {
  const account = privateKeyToAccount(sessionKey)
  // With pubkey, the console also issues a Grant for the whole group key (node=keyspace), wrapped to it.
  const pubkey = publicKeyOf(sessionKey).toLowerCase()
  const pubkeysig = await account.signMessage({
    message: `Keysmith key agreement key: ${pubkey}`,
  })
  // Lowercase: the console's strict address check refuses a mixed-case address with a bad checksum.
  return `${consoleUrl}/console/setup?authorize=${account.address.toLowerCase()}&scopes=createDataSet,addPieces,schedulePieceRemovals&network=${network}&pubkey=${pubkey}&pubkeysig=${pubkeysig}&node=keyspace`
}

/** What the chain says about the owner's account and this session key. */
export type Readiness = Account & {
  owner: Address
  /** Unix seconds; 0 when the owner never authorized the key. */
  authorizedUntil: number
  /** Unix seconds. */
  grantExpires: number
  approveUrl: string
  fundingUrl: string
}

/**
 * The checks, when the key expires if it is authorized, and the console links that fix what is missing:
 * code 0 when every check passed, else 2.
 */
export type ReadinessResult = {
  code: 0 | 2
  authorized: boolean
  storageApproved: boolean
  funded: boolean
  expiresAt?: string
  approveUrl: string
  fundingUrl?: string
}

/** Prints the readiness checklist and the console links that fix what is missing. */
export function reportReadiness(
  r: Readiness,
  print: (line: string) => void,
  now = Math.floor(Date.now() / 1000)
): ReadinessResult {
  const authorized = r.authorizedUntil > now
  const funding = checkFunding({ ...r, depositNeeded: 0n })
  const result: ReadinessResult = {
    code: authorized && funding.ready ? 0 : 2,
    authorized,
    storageApproved: r.storageApproved,
    funded: funding.funded,
    approveUrl: r.approveUrl,
  }
  print(authorized ? '✓ Session key authorized' : `✗ Session key not authorized by ${r.owner}`)
  for (const line of funding.lines) print(line)
  if (authorized) {
    const expires = Math.min(r.authorizedUntil, r.grantExpires)
    const days = Math.floor((expires - now) / 86_400)
    result.expiresAt = new Date(expires * 1000).toISOString()
    print(`Session key expires ${result.expiresAt.slice(0, 10)} (in ${days} days).`)
    print('To renew it before then, approve it again in the console and run setup with the new Grant:')
  } else {
    print('Approve this session key in the Filecoin Cloud console:')
  }
  print(r.approveUrl)
  if (!funding.ready) {
    result.fundingUrl = r.fundingUrl
    print('Deposit USDFC and approve the storage service in one step:')
    print(r.fundingUrl)
  }
  return result
}
