import { hostname } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { COMMITMENT_KEY, commitment, KEYSPACE_ID_KEY } from '@filoz/keysmith'
import { getAccountSummary } from '@filoz/synapse-core/pay'
import { fromSecp256k1 } from '@filoz/synapse-core/session-key'
import { Synapse } from '@filoz/synapse-sdk'
import { readClaudeSession } from './claude-code.ts'
import { encrypt } from './envelope.ts'
import { indexPath, readIndex, writeIndex } from './local-index.ts'
import { pack } from './piece.ts'
import { CHAINS, type Network, openLogin, SOURCE } from './session.ts'
import { fundingUrl, hasMinimumFunds, MIN_AVAILABLE_USDFC, PERMISSIONS, usdfc } from './setup.ts'

export type BackupOptions = { network: Network; consoleUrl: string; claudeHome: string }

/**
 * Backs up one Claude Code session now, active or not, unless the index already holds these exact files.
 * The index entry is written only once the piece is committed, so a failure leaves the session to retry.
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
  if (previous?.network === options.network && isDeepStrictEqual(previous.files, piece.header.files)) {
    print(`✓ Session ${id} is already backed up, unchanged since ${previous.lastWriteAt}.`)
    return 0
  }

  const started = Date.now()
  const step = (line: string) => print(`[${Math.round((Date.now() - started) / 1000)}s] ${line}`)
  const { grant, sessionKey: privateKey } = await openLogin(options.network)
  step(`Checking session key authorization on ${options.network}`)
  const chain = CHAINS[options.network]
  const sessionKey = fromSecp256k1({ privateKey, root: grant.owner, chain })
  await sessionKey.syncExpirations(PERMISSIONS)
  if (!sessionKey.hasPermissions(PERMISSIONS)) {
    print(`✗ Session key not authorized by ${grant.owner}, or its authorization expired. Run /attic:setup.`)
    return 2
  }

  const envelope = await encrypt(grant, piece.bytes)
  step(`Encrypted ${session.files.length} files into ${envelope.length} bytes; choosing a storage provider`)
  const synapse = Synapse.create({
    account: grant.owner,
    chain,
    sessionKey,
    requiredPermissions: PERMISSIONS,
    source: SOURCE,
    pieceBatching: false,
  })
  // One copy for v1: on calibnet the second provider's copy has stalled at "pending" for the SDK's full wait.
  const contexts = await synapse.storage.createContexts({
    copies: 1,
    // filecoin-pin's tags for an encrypted data set, so the console reads it as one.
    metadata: { 'foc/enc': '1', [KEYSPACE_ID_KEY]: grant.grant.keyspace, [COMMITMENT_KEY]: commitment(grant.key) },
  })
  step(`Checking funds for provider ${contexts.map((context) => context.provider.id).join(', ')}`)
  const [costs, account] = await Promise.all([
    synapse.storage.calculateMultiContextCosts(contexts, { pieceSizes: [BigInt(envelope.length)] }),
    getAccountSummary(synapse.client, { address: grant.owner }),
  ])
  const problems = fundingProblems(costs, account.availableFunds)
  if (problems.length > 0) {
    for (const problem of problems) print(problem)
    print('Nothing was uploaded. Deposit USDFC and approve the storage service in one step:')
    print(fundingUrl(options.consoleUrl, options.network))
    return 2
  }
  const result = await synapse.storage.upload(envelope, {
    contexts,
    callbacks: {
      onStored: (providerId, pieceCid) => step(`Stored on provider ${providerId} as piece ${pieceCid}`),
      onPiecesAdded: (hash, providerId) => step(`Committing on provider ${providerId}, transaction ${hash}`),
      onPiecesConfirmed: (dataSetId, providerId) =>
        step(`Committed on provider ${providerId} in data set ${dataSetId}`),
    },
  })
  const copies = result.copies.map((copy) => ({
    providerId: String(copy.providerId),
    dataSetId: String(copy.dataSetId),
    pieceId: String(copy.pieceId),
  }))
  index.sessions[id] = {
    ...piece.header,
    network: options.network,
    pieceCid: result.pieceCid.toString(),
    size: envelope.length,
    copies,
  }
  writeIndex(index, path)
  print(`✓ Backed up session ${id}: ${session.files.length} files, ${envelope.length} bytes encrypted`)
  print(`  Piece ${result.pieceCid} in data set ${copies.map((copy) => copy.dataSetId).join(', ')}`)
  return 0
}

/** What in the owner's account stops this upload, one line each; empty when it can go ahead. */
export function fundingProblems(
  costs: { needsFwssMaxApproval: boolean; depositNeeded: bigint },
  availableFunds: bigint
): string[] {
  const problems = costs.needsFwssMaxApproval ? ['✗ Storage service not approved'] : []
  if (costs.depositNeeded > 0n) {
    problems.push(`✗ ${usdfc(availableFunds)} USDFC available, ${usdfc(costs.depositNeeded)} short of this upload`)
  } else if (!hasMinimumFunds(availableFunds)) {
    // Funding the exact cost left nothing for the next upload in the spike, so setup's headroom applies too.
    problems.push(`✗ ${usdfc(availableFunds)} USDFC available (keep at least ${MIN_AVAILABLE_USDFC})`)
  }
  return problems
}
