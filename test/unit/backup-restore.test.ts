import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseUnits } from 'viem'
import { type BackupOptions, backup } from '../../src/backup.ts'
import { claudeCode } from '../../src/claude-code.ts'
import { codex } from '../../src/codex.ts'
import { indexEntry, recordEntry } from '../../src/local-index.ts'
import { openLogin } from '../../src/login.ts'
import { openPiece } from '../../src/piece.ts'
import { restore } from '../../src/restore.ts'
import { sessions } from '../../src/sessions.ts'
import { setup } from '../../src/setup.ts'
import { type Home, logIn, tempHome, writeClaudeSession, writeCodexSession } from '../e2e/helpers.ts'
import { memoryStorage } from '../memory-storage.ts'

const ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'
const OTHER = '7a2b4c6d-8e9f-4a1b-9c2d-3e4f5a6b7c8d'

// Attic keeps its login and index under HOME.
async function loggedInHome(): Promise<Home> {
  const home = await tempHome()
  process.env.HOME = home.root
  await logIn(home)
  return home
}

function options(home: Home): BackupOptions {
  return {
    network: 'calibration',
    consoleUrl: 'https://pay.filecoin.cloud',
    agents: [claudeCode(home.claude), codex(home.codex)],
  }
}

function printed(): { lines: string[]; print: (line: string) => void } {
  const lines: string[] = []
  return { lines, print: (line) => lines.push(line) }
}

test('a backed-up session, deleted locally, restores byte for byte', async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  const paths = writeClaudeSession(home, ID)
  const original = paths.map((path) => readFileSync(join(home.claude, path)))

  assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
  rmSync(join(home.claude, 'projects'), { recursive: true })
  const output = printed()
  assert.equal(await restore(options(home), ID, output.print, storage.connect), 0)

  assert.deepEqual(
    paths.map((path) => readFileSync(join(home.claude, path))),
    original
  )
  assert.ok(output.lines.includes(`claude --resume ${ID}`), output.lines.join('\n'))
})

test('active snapshots upload again only after their bytes change, for both agents', async () => {
  for (const agent of ['claude-code', 'codex'] as const) {
    const home = await loggedInHome()
    const storage = memoryStorage()
    const paths = agent === 'codex' ? writeCodexSession(home, ID) : writeClaudeSession(home, ID)
    const [path] = paths
    assert.ok(path)
    const root = agent === 'codex' ? home.codex : home.claude
    const transcript = join(root, path)
    appendFileSync(transcript, '{"active')
    assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
    const first = indexEntry(ID)
    assert.ok(first)
    assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
    assert.equal(storage.state.pieces.size, 1)
    appendFileSync(transcript, '":true}\n')
    const expected = readFileSync(transcript)
    assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
    assert.equal(storage.state.pieces.size, 2)
    assert.notEqual(indexEntry(ID)?.pieceCid, first.pieceCid)
    rmSync(root, { recursive: true })
    assert.equal(await restore(options(home), ID, printed().print, storage.connect), 0)
    assert.deepEqual(readFileSync(transcript), expected)
  }
})

test('a failed upload leaves no index entry, so the next backup uploads it', async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  writeClaudeSession(home, ID)
  storage.state.storeError = new Error('commit timed out')

  await assert.rejects(backup(options(home), ID, printed().print, storage.connect), /commit timed out/)
  assert.equal(indexEntry(ID), undefined)

  storage.state.storeError = undefined
  assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
  assert.equal(storage.state.pieces.size, 1)
  assert.ok(indexEntry(ID))
})

test('an unauthorized session key uploads nothing and says to run setup', async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  writeClaudeSession(home, ID)
  storage.state.authorizedUntil = 0
  const output = printed()

  assert.equal(await backup(options(home), ID, output.print, storage.connect), 2)
  assert.match(output.lines.join('\n'), /✗ Session key not authorized .* Run \/attic:setup/)
  assert.equal(storage.state.pieces.size, 0)
  assert.equal(indexEntry(ID), undefined)
})

test('an account short of funds uploads nothing and prints the funding link', async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  writeClaudeSession(home, ID)
  storage.state.quote = { storageApproved: false, depositNeeded: parseUnits('0.25', 18), availableFunds: 0n }
  const output = printed()

  assert.equal(await backup(options(home), ID, output.print, storage.connect), 2)
  assert.ok(output.lines.includes('https://pay.filecoin.cloud/console?deposit=2&operator=fwss&network=calibration'))
  assert.equal(storage.state.pieces.size, 0)
})

test("restore refuses a piece that holds another session's files and writes nothing", async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  writeClaudeSession(home, ID)
  writeClaudeSession(home, OTHER)
  await backup(options(home), ID, printed().print, storage.connect)
  await backup(options(home), OTHER, printed().print, storage.connect)
  const entry = indexEntry(ID)
  const other = indexEntry(OTHER)
  assert.ok(entry && other)
  recordEntry({ ...entry, pieceCid: other.pieceCid })
  rmSync(join(home.claude, 'projects'), { recursive: true })

  await assert.rejects(
    restore(options(home), ID, printed().print, storage.connect),
    new RegExp(`The piece for ${ID} holds session ${OTHER}\\. Nothing was written\\.`)
  )
  assert.equal(existsSync(join(home.claude, 'projects')), false)
})

test('restore refuses a damaged piece and writes nothing', async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  writeClaudeSession(home, ID)
  await backup(options(home), ID, printed().print, storage.connect)
  for (const envelope of storage.state.pieces.values()) envelope.fill(0, -16)
  rmSync(join(home.claude, 'projects'), { recursive: true })

  await assert.rejects(
    restore(options(home), ID, printed().print, storage.connect),
    /^Error: The backup does not decrypt: .*Nothing was written\.$/s
  )
  assert.equal(existsSync(join(home.claude, 'projects')), false)
})

test('Codex backup restores on a new machine after index rebuild, and lists alongside Claude Code', async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  const [path] = writeCodexSession(home, ID)
  assert.ok(path)
  const original = readFileSync(join(home.codex, path))
  writeClaudeSession(home, OTHER)
  await backup(options(home), OTHER, printed().print, storage.connect)
  await backup(options(home), ID, printed().print, storage.connect)
  await backup(options(home), ID, printed().print, storage.connect)
  assert.equal(storage.state.pieces.size, 2)
  assert.equal(indexEntry(ID)?.agent, 'codex')

  const fresh = await loggedInHome()
  assert.equal(await setup(options(fresh), printed().print, storage.connect), 0)
  const listing = printed()
  await sessions('calibration', [], listing.print)
  assert.match(listing.lines.join('\n'), new RegExp(`${ID} +codex +/tmp/attic-e2e`))
  assert.match(listing.lines.join('\n'), new RegExp(`${OTHER} +claude-code`))
  const output = printed()
  assert.equal(await restore(options(fresh), ID, output.print, storage.connect), 0)
  assert.deepEqual(readFileSync(join(fresh.codex, path)), original)
  assert.equal(existsSync(fresh.claude), false)
  assert.ok(output.lines.includes(`codex resume ${ID}`))
  assert.equal(await restore(options(fresh), ID, output.print, storage.connect), 0)
})

test('restore refuses a Codex piece indexed as Claude Code and writes nothing', async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  writeCodexSession(home, ID)
  await backup(options(home), ID, printed().print, storage.connect)
  const entry = indexEntry(ID)
  assert.ok(entry)
  recordEntry({ ...entry, agent: 'claude-code' })
  await assert.rejects(restore(options(home), ID, printed().print, storage.connect), /holds a codex session/)
  assert.equal(existsSync(home.claude), false)
})

test('Codex renames wait for changed rollout bytes and unreadable titles do not fail backup', async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  const [path] = writeCodexSession(home, ID)
  assert.ok(path)
  const index = join(home.codex, 'session_index.jsonl')
  writeFileSync(index, JSON.stringify({ id: ID, thread_name: 'Original title' }))
  assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
  assert.equal(indexEntry(ID)?.title, 'Original title')

  writeFileSync(index, JSON.stringify({ id: ID, thread_name: 'Renamed title' }))
  assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
  assert.equal(storage.state.pieces.size, 1)
  assert.equal(indexEntry(ID)?.title, 'Original title')

  appendFileSync(
    join(home.codex, path),
    '{"type":"event_msg","payload":{"type":"user_message","message":"Fix search"}}\n'
  )
  assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
  assert.equal(storage.state.pieces.size, 2)
  assert.equal(indexEntry(ID)?.title, 'Renamed title')
  const login = await openLogin('calibration')
  const envelope = [...storage.state.pieces.values()][1]
  assert.ok(envelope)
  const { header } = await openPiece(login.grant, envelope)
  assert.equal(header.title, 'Renamed title')
  assert.equal(header.firstPrompt, 'Fix search')
  assert.equal('branch' in header, false)
  assert.deepEqual(
    header.files.map((file) => file.path),
    [path]
  )

  rmSync(index)
  mkdirSync(index)
  appendFileSync(join(home.codex, path), '{}\n')
  assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
  assert.equal('title' in (indexEntry(ID) ?? {}), false)
})
