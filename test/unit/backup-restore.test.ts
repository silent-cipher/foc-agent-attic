import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseUnits } from 'viem'
import { type BackupOptions, backup } from '../../src/backup.ts'
import { indexPath } from '../../src/local-index.ts'
import { restore } from '../../src/restore.ts'
import { type Home, logIn, tempHome, writeClaudeSession } from '../e2e/helpers.ts'
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
  return { network: 'calibration', consoleUrl: 'https://pay.filecoin.cloud', claudeHome: home.claude }
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

test('a failed upload leaves no index entry, so the next backup uploads it', async () => {
  const home = await loggedInHome()
  const storage = memoryStorage()
  writeClaudeSession(home, ID)
  storage.state.storeError = new Error('commit timed out')

  await assert.rejects(backup(options(home), ID, printed().print, storage.connect), /commit timed out/)
  assert.equal(existsSync(indexPath()), false)

  storage.state.storeError = undefined
  assert.equal(await backup(options(home), ID, printed().print, storage.connect), 0)
  assert.equal(storage.state.pieces.size, 1)
  assert.ok(JSON.parse(readFileSync(indexPath(), 'utf8')).sessions[ID])
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
  assert.equal(existsSync(indexPath()), false)
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
  const index = JSON.parse(readFileSync(indexPath(), 'utf8'))
  index.sessions[ID].pieceCid = index.sessions[OTHER].pieceCid
  writeFileSync(indexPath(), JSON.stringify(index))
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
