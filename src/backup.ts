import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { Agent, AgentSession } from './agent.ts'
import { checkFunding, fundingUrl } from './funding.ts'
import { recordRun } from './last-run.ts'
import { indexEntry, isUpToDate, recordEntry, refreshIndex } from './local-index.ts'
import { type Network, openLogin, sameKeyholder } from './login.ts'
import { fileEntries, sealPiece } from './piece.ts'
import type { Connect, Copy } from './storage.ts'

export type BackupOptions = { network: Network; consoleUrl: string; agents: readonly Agent[] }

/**
 * Backs up one session now, or every session idle for 24 hours when no ID is supplied.
 * Skips snapshots when the index already holds these exact files
 * under this login's group key, and records how the run ended for `/attic:sessions`.
 * The index entry is written only once the piece is committed, so a failure leaves the session to retry.
 *
 * @returns 0 when backed up, 2 when the owner has something to do in the console.
 */
export async function backup(
  options: BackupOptions,
  id: string | undefined,
  print: (line: string) => void,
  connect: Connect
): Promise<number> {
  const folder = join(homedir(), '.attic')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const lock = join(folder, 'backup.lock')
  try {
    mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    print(
      `A backup holds ${lock}; skipping this run. If it was interrupted, remove the lock after checking no backup is running.`
    )
    return 0
  }
  const counts = { backedUp: 0, skipped: 0, failed: 0 }
  const lines: string[] = []
  const tee = (line: string) => {
    if (/^[✓✗]/.test(line)) lines.push(line)
    print(line)
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
    const code =
      id === undefined
        ? await backupIdle(options, tee, connect, counts)
        : await backupSession(options, id, tee, connect)
    recordRun({ finishedAt: new Date().toISOString(), ok: code === 0, lines, ...(id === undefined ? counts : {}) })
    return code
  } catch (error) {
    // The first line: viem adds request details on the lines after it.
    const [reason] = (error instanceof Error ? error.message : String(error)).split('\n')
    recordRun({
      finishedAt: new Date().toISOString(),
      ok: false,
      lines: [...lines, `✗ ${reason}`],
      ...(id === undefined ? counts : {}),
    })
    throw error
  } finally {
    rmSync(lock, { recursive: true })
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
      ...session.about,
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
  if (
    previous !== undefined &&
    sameKeyholder(previous, login.keyholder) &&
    previous.lastWriteAt <= header.lastWriteAt &&
    previous.pieceCid !== pieceCid
  ) {
    await storage.remove(previous.copies)
  }
  return 0
}

async function backupIdle(
  options: BackupOptions,
  print: (line: string) => void,
  connect: Connect,
  counts: { backedUp: number; skipped: number; failed: number }
): Promise<number> {
  const login = await openLogin(options.network)
  const storage = connect(login, print)
  await refreshIndex(login, storage, print)
  const due: { agent: Agent; id: string; session: AgentSession }[] = []
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const agent of options.agents) {
    for (const id of new Set(agent.sessionIds())) {
      try {
        const session = agent.readSession(id)
        const previous = indexEntry(id)
        if (
          session !== undefined &&
          previous !== undefined &&
          sameKeyholder(previous, login.keyholder) &&
          previous.lastWriteAt > session.lastWriteAt.toISOString()
        ) {
          counts.skipped++
          print(`✓ Skipped session ${id}: a newer backup is already indexed.`)
          continue
        }
        if (
          session === undefined ||
          session.lastWriteAt.getTime() > cutoff ||
          (previous !== undefined && isUpToDate(previous, login.keyholder, fileEntries(session.files)))
        ) {
          counts.skipped++
        } else due.push({ agent, id, session })
      } catch (error) {
        counts.failed++
        print(`✗ Session ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (due.length === 0) {
    print(`✓ Backup run: ${counts.backedUp} backed up, ${counts.skipped} skipped, ${counts.failed} failed`)
    return counts.failed === 0 ? 0 : 1
  }
  const authorizedUntil = await storage.authorizedUntil().catch((error: unknown) => {
    counts.failed += due.length
    throw error
  })
  if (authorizedUntil <= Date.now() / 1000) {
    counts.failed += due.length
    print('✗ Session key not authorized, or its authorization expired. Run /attic:setup.')
    return 2
  }
  const prepared: Awaited<ReturnType<typeof sealPiece>>[] = []
  for (const { agent, id, session } of due) {
    try {
      const piece = await sealPiece(
        login.grant,
        {
          agent: agent.name,
          sessionId: id,
          project: session.project,
          machine: hostname(),
          lastWriteAt: session.lastWriteAt.toISOString(),
          ...session.about,
        },
        session.files
      )
      prepared.push(piece)
    } catch (error) {
      counts.failed++
      print(`✗ Session ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (prepared.length === 0) return 1
  const quote = await storage.quote(prepared.map(({ envelope }) => envelope.length)).catch((error: unknown) => {
    counts.failed += prepared.length
    throw error
  })
  const funding = checkFunding(quote)
  if (!funding.ready) {
    counts.failed += prepared.length
    for (const line of funding.lines) print(line)
    print('Nothing was uploaded. Deposit USDFC and approve the storage service in one step:')
    print(fundingUrl(options.consoleUrl, options.network))
    return 2
  }
  const results = await storage
    .storeBatch(prepared.map(({ envelope }) => envelope))
    .catch((reason: unknown) => prepared.map((): PromiseRejectedResult => ({ status: 'rejected', reason })))
  const obsolete: Copy[] = []
  for (const [index, piece] of prepared.entries()) {
    const result = results[index]
    if (result === undefined || result.status === 'rejected') {
      counts.failed++
      const reason: unknown = result?.reason ?? 'Upload returned no result.'
      print(`✗ Session ${piece.header.sessionId}: ${reason instanceof Error ? reason.message : String(reason)}`)
      continue
    }
    try {
      const previous = indexEntry(piece.header.sessionId)
      recordEntry({ ...piece.header, ...login.keyholder, ...result.value, size: piece.envelope.length })
      if (
        previous !== undefined &&
        sameKeyholder(previous, login.keyholder) &&
        previous.lastWriteAt <= piece.header.lastWriteAt &&
        previous.pieceCid !== result.value.pieceCid
      ) {
        obsolete.push(...previous.copies)
      }
      counts.backedUp++
      print(`✓ Backed up session ${piece.header.sessionId}: ${piece.envelope.length} bytes encrypted`)
    } catch (error) {
      counts.failed++
      print(`✗ Session ${piece.header.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (obsolete.length > 0) {
    try {
      await storage.remove(obsolete)
    } catch (error) {
      print(`✗ Old pieces remain stored: ${error instanceof Error ? error.message : String(error)}`)
      print(`✓ Backup run: ${counts.backedUp} backed up, ${counts.skipped} skipped, ${counts.failed} failed`)
      return 1
    }
  }
  print(`✓ Backup run: ${counts.backedUp} backed up, ${counts.skipped} skipped, ${counts.failed} failed`)
  return counts.failed === 0 ? 0 : 1
}
