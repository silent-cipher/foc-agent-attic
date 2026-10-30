import { hostname } from 'node:os'
import { readClaudeSession } from './claude-code.ts'
import { indexPath, isUpToDate, keyholderOf, readIndex, writeIndex } from './local-index.ts'
import { fileEntries, sealPiece } from './piece.ts'
import { type Network, openLogin } from './session.ts'
import { fundingUrl, hasMinimumFunds, MIN_AVAILABLE_USDFC, usdfc } from './setup.ts'
import type { Connect, Quote } from './storage.ts'

export type BackupOptions = { network: Network; consoleUrl: string; claudeHome: string }

/**
 * Backs up one Claude Code session now, active or not, unless the index already holds these exact files
 * under this login's group key.
 * The index entry is written only once the piece is committed, so a failure leaves the session to retry.
 *
 * @returns 0 when backed up, 2 when the owner has something to do in the console.
 */
export async function backup(
  options: BackupOptions,
  id: string,
  print: (line: string) => void,
  connect: Connect
): Promise<number> {
  const session = readClaudeSession(options.claudeHome, id)
  if (session === undefined) throw new Error(`Session ${id} was not found in ${options.claudeHome}/projects.`)
  const path = indexPath()
  const index = readIndex(path)
  const login = await openLogin(options.network)
  const keyholder = keyholderOf(options.network, login.grant)
  const previous = index.sessions[id]
  if (previous !== undefined && isUpToDate(previous, keyholder, fileEntries(session.files))) {
    print(`✓ Session ${id} is already backed up, unchanged since ${previous.lastWriteAt}.`)
    return 0
  }

  const started = Date.now()
  const step = (line: string) => print(`[${Math.round((Date.now() - started) / 1000)}s] ${line}`)
  const storage = connect(login, options.network, step)
  step(`Checking session key authorization on ${options.network}`)
  if (!(await storage.isAuthorized())) {
    print(`✗ Session key not authorized by ${login.grant.owner}, or its authorization expired. Run /attic:setup.`)
    return 2
  }

  const { header, envelope } = await sealPiece(
    login.grant,
    {
      agent: 'claude-code',
      sessionId: id,
      project: session.project,
      machine: hostname(),
      lastWriteAt: session.lastWriteAt.toISOString(),
    },
    session.files
  )
  step(`Encrypted ${session.files.length} files into ${envelope.length} bytes; choosing a storage provider`)
  const problems = fundingProblems(await storage.quote(envelope.length))
  if (problems.length > 0) {
    for (const problem of problems) print(problem)
    print('Nothing was uploaded. Deposit USDFC and approve the storage service in one step:')
    print(fundingUrl(options.consoleUrl, options.network))
    return 2
  }
  const { pieceCid, copies } = await storage.store(envelope)
  index.sessions[id] = { ...header, ...keyholder, pieceCid, size: envelope.length, copies }
  writeIndex(index, path)
  print(`✓ Backed up session ${id}: ${session.files.length} files, ${envelope.length} bytes encrypted`)
  print(`  Piece ${pieceCid} in data set ${copies.map((copy) => copy.dataSetId).join(', ')}`)
  return 0
}

/** What in the owner's account stops this upload, one line each; empty when it can go ahead. */
export function fundingProblems(quote: Quote): string[] {
  const problems = quote.storageApproved ? [] : ['✗ Storage service not approved']
  if (quote.depositNeeded > 0n) {
    problems.push(
      `✗ ${usdfc(quote.availableFunds)} USDFC available, ${usdfc(quote.depositNeeded)} short of this upload`
    )
  } else if (!hasMinimumFunds(quote.availableFunds)) {
    // Funding the exact cost left nothing for the next upload in the spike, so setup's headroom applies too.
    problems.push(`✗ ${usdfc(quote.availableFunds)} USDFC available (keep at least ${MIN_AVAILABLE_USDFC})`)
  }
  return problems
}
