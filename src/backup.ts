import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { Agent, AgentSession } from './agent.ts'
import { checkFunding, fundingUrl } from './funding.ts'
import { type RunCounts, recordRun } from './last-run.ts'
import { hasNewer, type IndexEntry, indexEntry, isUpToDate, recordEntry, refreshIndex } from './local-index.ts'
import { type Keyholder, type Network, openLogin } from './login.ts'
import { fileEntries, sealPiece } from './piece.ts'
import type { Connect, Copy } from './storage.ts'

export type BackupOptions = {
  network: Network
  consoleUrl: string
  agents: readonly Agent[]
  /** Session bytes held in memory and committed together; defaults to 256 MiB. */
  chunkBytes?: number
}

// ponytail: each chunk is its own add-pieces call; only runs over 256 MiB pay the extra fee.
const CHUNK_BYTES = 256 * 1024 * 1024
const IDLE_MS = 24 * 60 * 60 * 1000

/** A session the run uploads, and its bytes before encryption. */
type Due = { agent: Agent; id: string; bytes: number }

/**
 * Backs up one session now, or every session idle for 24 hours when no ID is supplied.
 * Skips sessions the index already holds unchanged, or newer, under this login's group key,
 * and records how the run ended for `/attic:sessions`.
 * The index entry is written only once the piece is committed, so a failure leaves the session to retry.
 *
 * @returns 0 when backed up, 1 when a session failed, 2 when the owner has something to do in the console.
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
  if (!takeLock(lock, print)) {
    print(`Another backup holds ${lock}; skipping this run.`)
    return 0
  }
  const counts: RunCounts = { backedUp: 0, skipped: 0, failed: 0 }
  const lines: string[] = []
  const tee = (line: string) => {
    if (/^[✓✗]/.test(line)) lines.push(line)
    print(line)
  }
  try {
    const code = await run(options, id, tee, connect, counts)
    if (id === undefined)
      tee(`✓ Backup run: ${counts.backedUp} backed up, ${counts.skipped} skipped, ${counts.failed} failed`)
    recordRun({ finishedAt: new Date().toISOString(), ok: code === 0, lines, counts })
    return code
  } catch (error) {
    recordRun({ finishedAt: new Date().toISOString(), ok: false, lines: [...lines, `✗ ${firstLine(error)}`], counts })
    throw error
  } finally {
    rmSync(lock, { force: true })
  }
}

async function run(
  options: BackupOptions,
  id: string | undefined,
  print: (line: string) => void,
  connect: Connect,
  counts: RunCounts
): Promise<number> {
  const named = id === undefined ? undefined : findSession(options.agents, id)
  const login = await openLogin(options.network)
  const started = Date.now()
  const step = (line: string) => print(`[${Math.round((Date.now() - started) / 1000)}s] ${line}`)
  const storage = connect(login, step)
  let due: Due[]
  if (named === undefined) {
    await refreshIndex(login, storage, print)
    due = idleSessions(options.agents, login.keyholder, print, counts)
  } else {
    const { agent, id, session } = named
    const previous = indexEntry(id)
    if (previous !== undefined && isUpToDate(previous, login.keyholder, fileEntries(session.files))) {
      counts.skipped++
      print(`✓ Session ${id} is already backed up, unchanged since ${previous.lastWriteAt}.`)
      return 0
    }
    if (previous !== undefined && hasNewer(previous, login.keyholder, session.lastWriteAt.toISOString())) {
      counts.skipped++
      print(newerIndexed(id, previous))
      return 0
    }
    due = [{ agent, id, bytes: sessionBytes(session) }]
  }
  if (due.length === 0) return counts.failed === 0 ? 0 : 1

  step(`Checking session key authorization on ${options.network}`)
  const authorizedUntil = await storage.authorizedUntil().catch((error: unknown) => {
    counts.failed += due.length
    throw error
  })
  if (authorizedUntil <= Date.now() / 1000) {
    counts.failed += due.length
    print(`✗ Session key not authorized by ${login.grant.owner}, or its authorization expired. Run /attic:setup.`)
    return 2
  }

  const limit = options.chunkBytes ?? CHUNK_BYTES
  const chunks: Due[][] = []
  let chunk: Due[] = []
  let size = 0
  for (const item of due) {
    // A session over the limit still gets a chunk of its own.
    if (chunk.length > 0 && size + item.bytes > limit) {
      chunks.push(chunk)
      chunk = []
      size = 0
    }
    chunk.push(item)
    size += item.bytes
  }
  if (chunk.length > 0) chunks.push(chunk)

  let removalFailed = false
  for (const [index, chunk] of chunks.entries()) {
    const later = chunks.slice(index + 1).flat().length
    const sealed: Awaited<ReturnType<typeof sealPiece>>[] = []
    // Read again here, so only one chunk of sessions is in memory; the bytes read are the snapshot.
    for (const { agent, id } of chunk) {
      try {
        const session = agent.readSession(id)
        if (session === undefined) throw new Error('its files are gone')
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
        step(`Encrypted session ${id}: ${session.files.length} files into ${piece.envelope.length} bytes`)
        sealed.push(piece)
      } catch (error) {
        counts.failed++
        print(`✗ Session ${id}: ${firstLine(error)}`)
      }
    }
    if (sealed.length === 0) continue
    const quote = await storage.quote(sealed.map(({ envelope }) => envelope.length)).catch((error: unknown) => {
      counts.failed += sealed.length + later
      throw error
    })
    const funding = checkFunding(quote)
    if (!funding.ready) {
      counts.failed += sealed.length + later
      for (const line of funding.lines) print(line)
      print(
        `${index === 0 ? 'Nothing was uploaded.' : `${sealed.length + later} sessions were not uploaded.`} Deposit USDFC and approve the storage service in one step:`
      )
      print(fundingUrl(options.consoleUrl, options.network))
      return 2
    }
    const results = await storage
      .storeBatch(sealed.map(({ envelope }) => envelope))
      .catch((reason: unknown) => sealed.map((): PromiseRejectedResult => ({ status: 'rejected', reason })))
    const obsolete: Copy[] = []
    for (const [index, { header, envelope }] of sealed.entries()) {
      const result = results[index]
      try {
        if (result === undefined) throw new Error('Upload returned no result.')
        if (result.status === 'rejected') throw result.reason
        const { pieceCid, copies } = result.value
        obsolete.push(...recordEntry({ ...header, ...login.keyholder, pieceCid, size: envelope.length, copies }))
        counts.backedUp++
        print(
          `✓ Backed up session ${header.sessionId}: ${header.files.length} files, ${envelope.length} bytes encrypted`
        )
        print(`  Piece ${pieceCid} in data set ${copies.map((copy) => copy.dataSetId).join(', ')}`)
      } catch (error) {
        counts.failed++
        print(`✗ Session ${header.sessionId}: ${firstLine(error)}`)
      }
    }
    if (obsolete.length === 0) continue
    try {
      await storage.scheduleRemoval(obsolete)
    } catch (error) {
      removalFailed = true
      print(`✗ Old pieces remain stored: ${firstLine(error)}`)
    }
  }
  return counts.failed === 0 && !removalFailed ? 0 : 1
}

function findSession(agents: readonly Agent[], id: string): { agent: Agent; id: string; session: AgentSession } {
  for (const agent of agents) {
    const session = agent.readSession(id)
    if (session !== undefined) return { agent, id, session }
  }
  throw new Error(`Session ${id} was not found in ${agents.map((agent) => agent.home).join(' or ')}.`)
}

/** Every local session idle for 24 hours that the index lacks, or holds older or with other files. */
function idleSessions(
  agents: readonly Agent[],
  keyholder: Keyholder,
  print: (line: string) => void,
  counts: RunCounts
): Due[] {
  const due: Due[] = []
  const cutoff = Date.now() - IDLE_MS
  for (const agent of agents) {
    for (const id of new Set(agent.sessionIds())) {
      try {
        const session = agent.readSession(id)
        const previous = indexEntry(id)
        if (session === undefined || session.lastWriteAt.getTime() > cutoff) {
          counts.skipped++
        } else if (previous !== undefined && hasNewer(previous, keyholder, session.lastWriteAt.toISOString())) {
          counts.skipped++
          print(newerIndexed(id, previous))
        } else if (previous !== undefined && isUpToDate(previous, keyholder, fileEntries(session.files))) {
          counts.skipped++
        } else due.push({ agent, id, bytes: sessionBytes(session) })
      } catch (error) {
        counts.failed++
        print(`✗ Session ${id}: ${firstLine(error)}`)
      }
    }
  }
  return due
}

function newerIndexed(id: string, previous: IndexEntry): string {
  return `✓ Skipped session ${id}: the index holds a newer backup, from ${previous.machine} at ${previous.lastWriteAt}.`
}

function sessionBytes(session: AgentSession): number {
  return session.files.reduce((total, file) => total + file.bytes.length, 0)
}

/** The error's first line: viem adds request details on the lines after it. */
function firstLine(error: unknown): string {
  const [line = ''] = (error instanceof Error ? error.message : String(error)).split('\n')
  return line
}

/**
 * Takes the run lock, a file holding the running process's PID, replacing one whose process has stopped.
 *
 * @returns false while another live process holds it.
 */
function takeLock(lock: string, print: (line: string) => void): boolean {
  // Linking a written file creates the lock with its PID in one step, so no lock exists without one.
  const claim = `${lock}.${process.pid}`
  try {
    writeFileSync(claim, String(process.pid), { mode: 0o600 })
    linkSync(claim, lock)
    return true
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  } finally {
    rmSync(claim, { force: true })
  }
  let holder: string
  try {
    holder = readFileSync(lock, 'utf8')
  } catch (error) {
    // Released since the link failed.
    if (hasCode(error, 'ENOENT')) return takeLock(lock, print)
    throw error
  }
  const pid = Number(holder)
  if (Number.isSafeInteger(pid) && pid > 0 && isRunning(pid)) return false
  // ponytail: two runs replacing the same stopped lock at once can both proceed; a rename swap would close that.
  rmSync(lock, { force: true })
  print(`Removed the lock of stopped backup process ${holder}.`)
  return takeLock(lock, print)
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists under another user.
    return !hasCode(error, 'ESRCH')
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
