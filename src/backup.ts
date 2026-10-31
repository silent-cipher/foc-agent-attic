import { hostname } from 'node:os'
import type { Agent, AgentSession } from './agent.ts'
import { checkFunding, fundingUrl } from './funding.ts'
import { recordRun } from './last-run.ts'
import { indexEntry, isUpToDate, recordEntry } from './local-index.ts'
import { type Network, openLogin } from './login.ts'
import { fileEntries, sealPiece } from './piece.ts'
import type { Connect } from './storage.ts'

export type BackupOptions = { network: Network; consoleUrl: string; agents: readonly Agent[] }

/**
 * Backs up one session now, active or not, unless the index already holds these exact files
 * under this login's group key, and records how the run ended for `/attic:sessions`.
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
  const lines: string[] = []
  const tee = (line: string) => {
    if (/^[✓✗]/.test(line)) lines.push(line)
    print(line)
  }
  try {
    const code = await backupSession(options, id, tee, connect)
    recordRun({ finishedAt: new Date().toISOString(), ok: code === 0, lines })
    return code
  } catch (error) {
    // The first line: viem adds request details on the lines after it.
    const [reason] = (error instanceof Error ? error.message : String(error)).split('\n')
    recordRun({ finishedAt: new Date().toISOString(), ok: false, lines: [...lines, `✗ ${reason}`] })
    throw error
  }
}

async function backupSession(
  options: BackupOptions,
  id: string,
  print: (line: string) => void,
  connect: Connect
): Promise<number> {
  let found: { agent: Agent; session: AgentSession } | undefined
  for (const agent of options.agents) {
    const session = agent.readSession(id)
    if (session !== undefined) {
      found = { agent, session }
      break
    }
  }
  if (found === undefined) {
    throw new Error(`Session ${id} was not found in ${options.agents.map((agent) => agent.home).join(' or ')}.`)
  }
  const { agent, session } = found
  const login = await openLogin(options.network)
  const previous = indexEntry(id)
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
      agent: agent.name,
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
  recordEntry({ ...header, ...login.keyholder, pieceCid, size: envelope.length, copies })
  print(`✓ Backed up session ${id}: ${session.files.length} files, ${envelope.length} bytes encrypted`)
  print(`  Piece ${pieceCid} in data set ${copies.map((copy) => copy.dataSetId).join(', ')}`)
  return 0
}
