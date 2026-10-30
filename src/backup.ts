import { hostname } from 'node:os'
import { readClaudeSession } from './claude-code.ts'
import { checkFunding, fundingUrl } from './funding.ts'
import { indexPath, isUpToDate, readIndex, writeIndex } from './local-index.ts'
import { type Network, openLogin } from './login.ts'
import { fileEntries, sealPiece } from './piece.ts'
import type { Connect } from './storage.ts'

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
  const previous = index.sessions[id]
  if (previous !== undefined && isUpToDate(previous, login.keyholder, fileEntries(session.files))) {
    print(`✓ Session ${id} is already backed up, unchanged since ${previous.lastWriteAt}.`)
    return 0
  }

  const started = Date.now()
  const step = (line: string) => print(`[${Math.round((Date.now() - started) / 1000)}s] ${line}`)
  const storage = connect(login, step)
  step(`Checking session key authorization on ${options.network}`)
  if ((await storage.authorizedUntil()) <= Date.now() / 1000) {
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
  const funding = checkFunding(await storage.quote(envelope.length))
  if (!funding.ready) {
    for (const line of funding.lines) print(line)
    print('Nothing was uploaded. Deposit USDFC and approve the storage service in one step:')
    print(fundingUrl(options.consoleUrl, options.network))
    return 2
  }
  const { pieceCid, copies } = await storage.store(envelope)
  index.sessions[id] = { ...header, ...login.keyholder, pieceCid, size: envelope.length, copies }
  writeIndex(index, path)
  print(`✓ Backed up session ${id}: ${session.files.length} files, ${envelope.length} bytes encrypted`)
  print(`  Piece ${pieceCid} in data set ${copies.map((copy) => copy.dataSetId).join(', ')}`)
  return 0
}
