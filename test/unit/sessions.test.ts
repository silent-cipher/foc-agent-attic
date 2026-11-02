import assert from 'node:assert/strict'
import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { type BackupOptions, backup } from '../../src/backup.ts'
import { claudeCode } from '../../src/claude-code.ts'
import { indexEntries, indexEntry } from '../../src/local-index.ts'
import { restore } from '../../src/restore.ts'
import { sessions } from '../../src/sessions.ts'
import { setup } from '../../src/setup.ts'
import { type Home, logIn, tempHome, writeClaudeSession } from '../e2e/helpers.ts'
import { makeGrant } from '../make-grant.ts'
import { memoryStorage } from '../memory-storage.ts'

const ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'
const OTHER = '7a2b4c6d-8e9f-4a1b-9c2d-3e4f5a6b7c8d'
const NOW = 1_800_000_000
const DAY = 86_400
const YESTERDAY = new Date(Date.now() - 86_400_000)

// Attic keeps its login, index and last run under HOME, so switching HOME switches machines.
async function machine(grant?: string): Promise<Home> {
  const home = await tempHome()
  process.env.HOME = home.root
  await logIn(home, grant)
  return home
}

function options(home: Home): BackupOptions {
  return { network: 'calibration', consoleUrl: 'https://pay.filecoin.cloud', agents: [claudeCode(home.claude)] }
}

function printed(): { lines: string[]; print: (line: string) => void } {
  const lines: string[] = []
  return { lines, print: (line) => lines.push(line) }
}

async function listed(now = NOW, words: string[] = []): Promise<string[]> {
  const output = printed()
  assert.equal(await sessions('calibration', words, output.print, now), 0)
  return output.lines
}

test('setup on a new machine rebuilds the index from the newest piece of each session, and restore works', async () => {
  const storage = memoryStorage()
  const old = await machine()
  writeClaudeSession(old, OTHER).map((path) => utimesSync(join(old.claude, path), YESTERDAY, YESTERDAY))
  await backup(options(old), OTHER, printed().print, storage.connect)
  const transcript = join(old.claude, writeClaudeSession(old, ID)[0] ?? '')
  await backup(options(old), ID, printed().print, storage.connect)
  const [first] = storage.state.pieces.keys().drop(1)
  const envelope = first === undefined ? undefined : storage.state.pieces.get(first)
  writeFileSync(transcript, `${readFileSync(transcript, 'utf8')}{"type":"assistant"}\n`)
  await backup(options(old), ID, printed().print, storage.connect)
  const newest = indexEntry(ID)
  // Listed last, so the rebuild must pick the newest piece by its header, not by listing order.
  assert.ok(first !== undefined && envelope !== undefined)
  storage.state.pieces.set(first, envelope)

  const fresh = await machine()
  const output = printed()
  assert.equal((await setup(options(fresh), output.print, storage.connect)).code, 0)
  assert.ok(output.lines.includes('✓ Index refreshed: 2 new sessions, 0 updated'), output.lines.join('\n'))
  assert.deepEqual({ ...indexEntry(ID), copies: [] }, { ...newest, copies: [] })

  const [header, ...rows] = await listed()
  assert.match(header ?? '', /^Session ID +Agent +Project +Last write \(UTC\) +Size +Branch +Title$/)
  assert.match(
    rows[0] ?? '',
    new RegExp(`^${ID}  claude-code  /tmp/attic-e2e  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  \\d+\\.\\d KiB  main +hello$`)
  )
  assert.match(rows[1] ?? '', new RegExp(`^${OTHER} `))

  await restore(options(fresh), ID, printed().print, storage.connect)
  const restored = join(fresh.claude, 'projects', '-tmp-attic-e2e', `${ID}.jsonl`)
  assert.equal(readFileSync(restored, 'utf8'), readFileSync(transcript, 'utf8'))
})

test('sessions shows what each backed-up session is about after a refresh, and filters by its title', async () => {
  const storage = memoryStorage()
  const home = await machine()
  writeClaudeSession(home, ID, 'Speed up the Index')
  writeClaudeSession(home, OTHER)
  await backup(options(home), ID, printed().print, storage.connect)
  await backup(options(home), OTHER, printed().print, storage.connect)

  assert.equal((await setup(options(await machine()), printed().print, storage.connect)).code, 0)
  const rows = (await listed()).filter((line) => line.startsWith(ID) || line.startsWith(OTHER))
  assert.equal(rows.length, 2)
  assert.ok(
    rows.some((row) => row.startsWith(ID) && row.endsWith('  Speed up the Index')),
    rows.join('\n')
  )
  assert.ok(
    rows.some((row) => row.startsWith(OTHER) && row.endsWith('  hello')),
    rows.join('\n')
  )

  const [header, ...matched] = await listed(NOW, ['speed'])
  assert.match(header ?? '', /^Session ID /)
  assert.match(matched[0] ?? '', new RegExp(`^${ID} `))
  assert.doesNotMatch(matched.join('\n'), new RegExp(OTHER))
})

test('the rebuild reads only the start of each piece', async () => {
  const storage = memoryStorage()
  const old = await machine()
  writeClaudeSession(old, ID)
  writeFileSync(join(old.claude, 'projects', '-tmp-attic-e2e', ID, 'big.txt'), Buffer.alloc(4 * 1024 * 1024, 'a'))
  await backup(options(old), ID, printed().print, storage.connect)
  const [envelope] = storage.state.pieces.values()

  await setup(options(await machine()), printed().print, storage.connect)
  assert.equal(indexEntries().length, 1)
  assert.ok(envelope !== undefined && storage.state.bytesRead < envelope.length / 4, String(storage.state.bytesRead))
})

test('a piece that is not an Attic session is skipped and reported', async () => {
  const storage = memoryStorage()
  const old = await machine()
  writeClaudeSession(old, ID)
  await backup(options(old), ID, printed().print, storage.connect)
  storage.state.pieces.set('memory-junk', new TextEncoder().encode('not a piece'))

  const output = printed()
  const result = await setup(options(await machine()), output.print, storage.connect)
  assert.ok(
    output.lines.some((line) => line.startsWith('✗ Skipped piece memory-junk: ')),
    output.lines.join('\n')
  )
  assert.ok('refresh' in result)
  assert.deepEqual(
    result.refresh?.skippedPieces.map(({ pieceCid }) => pieceCid),
    ['memory-junk']
  )
  assert.deepEqual([result.refresh?.added, result.refresh?.sessions], [1, 1])
  assert.deepEqual(
    indexEntries().map((entry) => entry.sessionId),
    [ID]
  )
})

test('setup leaves an existing index alone', async () => {
  const storage = memoryStorage()
  const home = await machine()
  writeClaudeSession(home, ID)
  await backup(options(home), ID, printed().print, storage.connect)
  storage.state.pieces.clear()

  const output = printed()
  assert.equal('refresh' in (await setup(options(home), output.print, storage.connect)), false)
  assert.ok(!output.lines.some((line) => line.includes('Found')), output.lines.join('\n'))
  assert.ok(indexEntry(ID))
})

test('sessions shows how the last backup run ended', async () => {
  const storage = memoryStorage()
  const home = await machine()
  assert.ok((await listed()).includes('No backup run has finished on this machine yet.'))

  writeClaudeSession(home, ID)
  await backup(options(home), ID, printed().print, storage.connect)
  let listing = await listed()
  assert.match(listing.join('\n'), /Last run \d{4}-\d\d-\d\d \d\d:\d\d UTC succeeded:\n {2}✓ Backed up session /)

  storage.state.authorizedUntil = 0
  writeClaudeSession(home, OTHER)
  await backup(options(home), OTHER, printed().print, storage.connect)
  listing = await listed()
  assert.match(listing.join('\n'), /UTC failed:\n {2}✗ Session key not authorized .* Run attic setup\./)

  storage.state.authorizedUntil = 4102444800
  storage.state.storeError = new Error('commit timed out\nRequest body: …')
  assert.equal((await backup(options(home), OTHER, printed().print, storage.connect)).code, 1)
  assert.match((await listed()).join('\n'), new RegExp(`UTC failed:\\n {2}✗ Session ${OTHER}: commit timed out$`))
})

test('sessions warns from 7 days before the session key expires', async () => {
  await machine(await makeGrant({ expires: NOW + 7 * DAY }))
  assert.ok((await listed()).includes('No sessions in the Attic index. Back one up with attic backup <session id>.'))
  assert.ok(
    (await listed(NOW + DAY)).includes(
      '⚠ The session key expires on 2027-01-22 (in 6 days). Run attic setup to renew it.'
    )
  )
  assert.ok(!(await listed(NOW - DAY)).some((line) => line.includes('session key')))
  assert.ok(
    (await listed(NOW + 7 * DAY)).includes('✗ The session key expired on 2027-01-22. Run attic setup to log in again.')
  )
})
