import { hostname } from 'node:os'
import { COMMITMENT_KEY, commitment, KEYSPACE_ID_KEY } from '@filoz/keysmith'
import { getAccountSummary } from '@filoz/synapse-core/pay'
import { fromSecp256k1 } from '@filoz/synapse-core/session-key'
import { Synapse } from '@filoz/synapse-sdk'
import { readClaudeSession } from './claude-code.ts'
import { encrypt } from './envelope.ts'
import { indexPath, readIndex, writeIndex } from './local-index.ts'
import { pack } from './piece.ts'
import { CHAINS, type Network, openLogin } from './session.ts'
import { fundingUrl, hasMinimumFunds, PERMISSIONS } from './setup.ts'

/** Tags Attic's data sets, apart from other apps' data sets on the same wallet. */
export const SOURCE = 'attic'
const COPIES = 2

export type BackupOptions = { network: Network; consoleUrl: string; claudeHome: string }

/**
 * Backs up one Claude Code session now, active or not, unless the index already holds these exact files.
 * The index entry is written only once every copy is committed, so a failure leaves the session to retry.
 *
 * @returns 0 when backed up, 2 when the owner has something to do in the console.
 */
export async function backup(options: BackupOptions, id: string, print: (line: string) => void): Promise<number> {
  const session = readClaudeSession(options.claudeHome, id)
  if (session === undefined) throw new Error(`Session ${id} was not found in ${options.claudeHome}/projects.`)
  const path = indexPath()
  const index = readIndex(path)
  const piece = pack(
    {
      v: 1,
      agent: 'claude-code',
      sessionId: id,
      project: session.project,
      machine: hostname(),
      lastWriteAt: session.lastWriteAt.toISOString(),
    },
    session.files
  )
  const previous = index.sessions[id]
  if (previous !== undefined && JSON.stringify(previous.files) === JSON.stringify(piece.header.files)) {
    print(`✓ Session ${id} is already backed up, unchanged since ${previous.lastWriteAt}.`)
    return 0
  }

  const { grant, sessionKey: privateKey } = await openLogin(options.network)
  const chain = CHAINS[options.network]
  const sessionKey = fromSecp256k1({ privateKey, root: grant.owner, chain })
  await sessionKey.syncExpirations(PERMISSIONS)
  if (!sessionKey.hasPermissions(PERMISSIONS)) {
    print(`✗ Session key not authorized by ${grant.owner}, or its authorization expired. Run /attic:setup.`)
    return 2
  }

  const envelope = await encrypt(grant, piece.bytes)
  const synapse = Synapse.create({
    account: grant.owner,
    chain,
    sessionKey,
    requiredPermissions: PERMISSIONS,
    source: SOURCE,
    pieceBatching: false,
  })
  const target = {
    copies: COPIES,
    // filecoin-pin's tags for an encrypted data set, so the console reads it as one.
    metadata: { 'foc/enc': '1', [KEYSPACE_ID_KEY]: grant.grant.keyspace, [COMMITMENT_KEY]: commitment(grant.key) },
  }
  const contexts = await synapse.storage.createContexts(target)
  const [costs, account] = await Promise.all([
    synapse.storage.calculateMultiContextCosts(contexts, { pieceSizes: [BigInt(envelope.length)] }),
    getAccountSummary(synapse.client, { address: grant.owner }),
  ])
  // Funding the exact cost left nothing for the next upload in the spike, so setup's headroom applies too.
  if (!costs.ready || !hasMinimumFunds(account.availableFunds)) {
    print('✗ Not enough USDFC available, or the storage service is not approved. Nothing was uploaded.')
    print('Deposit USDFC and approve the storage service in one step:')
    print(fundingUrl(options.consoleUrl, options.network))
    return 2
  }
  // Not `{ contexts }`: explicit contexts turn off the SDK's retry on another provider when a copy fails.
  const result = await synapse.storage.upload(envelope, target)
  if (!result.complete) {
    throw new Error(
      `Only ${result.copies.length} of ${COPIES} copies were committed, so the backup was not recorded. Run backup again.`
    )
  }
  const copies = result.copies.map((copy) => ({
    providerId: String(copy.providerId),
    dataSetId: String(copy.dataSetId),
    pieceId: String(copy.pieceId),
  }))
  index.sessions[id] = { ...piece.header, pieceCid: result.pieceCid.toString(), size: envelope.length, copies }
  writeIndex(index, path)
  print(`✓ Backed up session ${id}: ${session.files.length} files, ${envelope.length} bytes encrypted`)
  print(`  Piece ${result.pieceCid} in data sets ${copies.map((copy) => copy.dataSetId).join(' and ')}`)
  return 0
}
