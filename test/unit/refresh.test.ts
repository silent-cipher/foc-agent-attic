import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { type BackupOptions, backup } from '../../src/backup.ts'
import { claudeCode } from '../../src/claude-code.ts'
import { type IndexEntry, indexEntries, indexEntry, recordEntry, refreshIndex } from '../../src/local-index.ts'
import { openLogin } from '../../src/login.ts'
import { restore } from '../../src/restore.ts'
import { type Home, logIn, tempHome, writeClaudeSession } from '../e2e/helpers.ts'
import { memoryStorage } from '../memory-storage.ts'

const ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'
const OTHER = '7a2b4c6d-8e9f-4a1b-9c2d-3e4f5a6b7c8d'
const THIRD = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

type Storage = ReturnType<typeof memoryStorage>

// Attic keeps its login and index under HOME, so switching HOME switches machines.
function at(home: Home): Home {
  process.env.HOME = home.root
  return home
}

async function machine(): Promise<Home> {
  const home = at(await tempHome())
  await logIn(home)
  return home
}

function options(home: Home): BackupOptions {
  return { network: 'calibration', consoleUrl: 'https://pay.filecoin.cloud', agents: [claudeCode(home.claude)] }
}

/** Backs up a new session on `home` and returns its index entry. */
async function backUp(home: Home, storage: Storage, id: string): Promise<IndexEntry> {
  at(home)
  writeClaudeSession(home, id)
  assert.equal(await backup(options(home), id, () => undefined, storage.connect), 0)
  const entry = indexEntry(id)
  assert.ok(entry)
  return entry
}

async function refresh(home: Home, storage: Storage): Promise<string[]> {
  at(home)
  const lines: string[] = []
  const print = (line: string) => lines.push(line)
  const login = await openLogin('calibration')
  await refreshIndex(login, storage.connect(login, print), print)
  return lines
}

test('refresh adds a session another machine backed up, which then restores here', async () => {
  const storage = memoryStorage()
  const b = await machine()
  await backUp(b, storage, OTHER)
  const a = await machine()
  await backUp(a, storage, ID)
  const transcript = readFileSync(join(a.claude, 'projects', '-tmp-attic-e2e', `${ID}.jsonl`))

  const lines = await refresh(b, storage)
  assert.deepEqual(lines, [
    'Found 2 pieces on chain, 1 not in the index',
    '✓ Index refreshed: 1 new sessions, 0 updated',
  ])
  assert.deepEqual(
    indexEntries()
      .map((entry) => entry.sessionId)
      .toSorted(),
    [ID, OTHER].toSorted()
  )
  assert.equal(await restore(options(b), ID, () => undefined, storage.connect), 0)
  assert.deepEqual(readFileSync(join(b.claude, 'projects', '-tmp-attic-e2e', `${ID}.jsonl`)), transcript)
})

test('refresh reads no header for a piece the index holds', async () => {
  const storage = memoryStorage()
  const a = await machine()
  await backUp(a, storage, ID)
  const b = await machine()
  await refresh(b, storage)

  storage.state.rangeReads = []
  assert.deepEqual(await refresh(b, storage), [
    'Found 1 pieces on chain, 0 not in the index',
    '✓ The index is already up to date: 1 sessions',
  ])
  assert.deepEqual(storage.state.rangeReads, [])

  const added = await backUp(a, storage, OTHER)
  await refresh(b, storage)
  assert.deepEqual(new Set(storage.state.rangeReads), new Set([added.pieceCid]))
})

test('refresh reads 8 headers at a time', async () => {
  const storage = memoryStorage()
  const a = await machine()
  for (let n = 0; n < 20; n++) await backUp(a, storage, `session-${n}`)

  await refresh(await machine(), storage)
  assert.equal(indexEntries().length, 20)
  assert.equal(storage.state.maxReadsInFlight, 8)
})

test("refresh keeps each session's newest piece, counting a newer one as updated", async () => {
  const storage = memoryStorage()
  const a = await machine()
  await backUp(a, storage, ID)
  const b = await machine()
  await refresh(b, storage)

  at(a)
  appendFileSync(join(a.claude, 'projects', '-tmp-attic-e2e', `${ID}.jsonl`), '{"type":"assistant"}\n')
  await backup(options(a), ID, () => undefined, storage.connect)
  const newest = indexEntry(ID)

  assert.ok((await refresh(b, storage)).includes('✓ Index refreshed: 0 new sessions, 1 updated'))
  assert.equal(indexEntry(ID)?.pieceCid, newest?.pieceCid)
  // The older piece is not held now, so it is read again, and loses.
  assert.ok((await refresh(b, storage)).includes('✓ The index is already up to date: 1 sessions'))
  assert.equal(indexEntry(ID)?.pieceCid, newest?.pieceCid)
})

test('a replacement with the same timestamp wins over an indexed piece that was removed', async () => {
  const storage = memoryStorage()
  const a = await machine()
  const transcript = join(a.claude, writeClaudeSession(a, ID)[0] ?? '')
  const written = new Date('2026-01-01T00:00:00.000Z')
  utimesSync(transcript, written, written)
  assert.equal(await backup(options(a), ID, () => undefined, storage.connect), 0)
  const first = indexEntry(ID)
  assert.ok(first)
  const b = await machine()
  await refresh(b, storage)

  at(a)
  appendFileSync(transcript, '{"type":"assistant"}\n')
  utimesSync(transcript, written, written)
  assert.equal(await backup(options(a), ID, () => undefined, storage.connect), 0)
  const replacement = indexEntry(ID)
  assert.equal(replacement?.lastWriteAt, first.lastWriteAt)
  assert.equal(storage.state.pieces.has(first.pieceCid), false)

  assert.ok((await refresh(b, storage)).includes('✓ Index refreshed: 0 new sessions, 1 updated'))
  assert.equal(indexEntry(ID)?.pieceCid, replacement?.pieceCid)
})

test("a session's older pieces found in the same refresh are not counted", async () => {
  const storage = memoryStorage()
  const a = await machine()
  await backUp(a, storage, ID)
  appendFileSync(join(a.claude, 'projects', '-tmp-attic-e2e', `${ID}.jsonl`), '{"type":"assistant"}\n')
  await backup(options(a), ID, () => undefined, storage.connect)
  const newest = indexEntry(ID)

  assert.ok((await refresh(await machine(), storage)).includes('✓ Index refreshed: 1 new sessions, 0 updated'))
  assert.equal(indexEntry(ID)?.pieceCid, newest?.pieceCid)
})

test('a piece this login can read replaces an entry it cannot, even a newer one', async () => {
  const storage = memoryStorage()
  const a = await machine()
  const entry = await backUp(a, storage, ID)
  const b = await machine()
  recordEntry({
    ...entry,
    groupKey: '0x0000000000000000000000000000000a',
    pieceCid: 'bafk-other-key',
    lastWriteAt: '2099-01-01T00:00:00.000Z',
  })

  assert.ok((await refresh(b, storage)).includes('✓ Index refreshed: 0 new sessions, 1 updated'))
  assert.equal(indexEntry(ID)?.pieceCid, entry.pieceCid)
})

test('a refresh whose listing fails leaves the index unchanged', async () => {
  const storage = memoryStorage()
  const b = await machine()
  await backUp(b, storage, OTHER)
  const before = readFileSync(join(b.root, '.attic', 'index.json'))
  await backUp(await machine(), storage, ID)
  storage.state.listError = new Error('RPC timed out')

  await assert.rejects(refresh(b, storage), /RPC timed out/)
  assert.deepEqual(readFileSync(join(b.root, '.attic', 'index.json')), before)
})

test('a piece whose header cannot be read is skipped and reported, and read again next refresh', async () => {
  const storage = memoryStorage()
  const a = await machine()
  const down = await backUp(a, storage, ID)
  const up = await backUp(a, storage, OTHER)
  await backUp(a, storage, THIRD)
  storage.state.unreadable.add(down.pieceCid)
  const b = await machine()

  const lines = await refresh(b, storage)
  assert.ok(
    lines.includes(`✗ Skipped piece ${down.pieceCid}: provider answered 503 for ${down.pieceCid}`),
    lines.join('\n')
  )
  assert.ok(lines.includes('✓ Index refreshed: 2 new sessions, 0 updated'), lines.join('\n'))
  assert.equal(indexEntry(OTHER)?.pieceCid, up.pieceCid)

  storage.state.unreadable.clear()
  assert.ok((await refresh(b, storage)).includes('✓ Index refreshed: 1 new sessions, 0 updated'))
  assert.equal(indexEntry(ID)?.pieceCid, down.pieceCid)
  assert.equal(indexEntries().length, 3)
})

test('restore of a session missing from the index suggests refresh, without network calls, and writes nothing', async () => {
  const home = await machine()
  const offline = () => {
    throw new Error('restore reached the network')
  }
  await assert.rejects(
    restore(options(home), ID, () => undefined, offline),
    new RegExp(`^Error: Session ${ID} is not in the Attic index\\. .*run /attic:refresh.* Nothing was written\\.$`)
  )
  assert.equal(existsSync(home.claude), false)
})
