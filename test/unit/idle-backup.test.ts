import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { type BackupOptions, backup } from '../../src/backup.ts'
import { claudeCode } from '../../src/claude-code.ts'
import { codex } from '../../src/codex.ts'
import { lastRun } from '../../src/last-run.ts'
import { indexEntry } from '../../src/local-index.ts'
import { openLogin } from '../../src/login.ts'
import { openPiece } from '../../src/piece.ts'
import type { Connect } from '../../src/storage.ts'
import { logIn, tempHome, writeClaudeSession, writeCodexSession } from '../e2e/helpers.ts'
import { memoryStorage } from '../memory-storage.ts'

async function fixture() {
  const home = await tempHome()
  process.env.HOME = home.root
  await logIn(home)
  const options: BackupOptions = {
    network: 'calibration',
    consoleUrl: 'https://pay.filecoin.cloud',
    agents: [claudeCode(home.claude), codex(home.codex)],
  }
  const storage = memoryStorage()
  const lines: string[] = []
  return { home, options, ...storage, lines, print: (line: string) => lines.push(line) }
}
const ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'
const OTHER = '7a2b4c6d-8e9f-4a1b-9c2d-3e4f5a6b7c8d'
const old = new Date(Date.now() - 25 * 60 * 60 * 1000)

function age(root: string, paths: string[]) {
  for (const path of paths) utimesSync(join(root, path), old, old)
}

test('the idle run discovers both agents, skips active files, and snapshots before uploading', async () => {
  const f = await fixture()
  const paths = writeClaudeSession(f.home, ID)
  age(f.home.claude, paths)
  age(f.home.codex, writeCodexSession(f.home, OTHER))
  writeClaudeSession(f.home, 'active')
  const original = paths.map((path) => readFileSync(join(f.home.claude, path)))
  let batches = 0
  const connect: Connect = (login, print) => {
    const storage = f.connect(login, print)
    return {
      ...storage,
      async storeBatch(envelopes) {
        batches++
        assert.equal(envelopes.length, 2)
        appendFileSync(join(f.home.claude, paths[0] ?? ''), 'new activity\n')
        return storage.storeBatch(envelopes)
      },
    }
  }
  assert.equal(await backup(f.options, undefined, f.print, connect), 0)
  assert.equal(batches, 1)
  assert.equal(f.state.pieces.size, 2)
  assert.equal(indexEntry('active'), undefined)
  const entry = indexEntry(ID)
  assert.ok(entry)
  const envelope = f.state.pieces.get(entry.pieceCid)
  assert.ok(envelope)
  const { files } = await openPiece((await openLogin('calibration')).grant, envelope)
  assert.deepEqual(
    files.map((file) => Buffer.from(file.bytes)),
    original
  )
  assert.deepEqual(lastRun()?.counts, { backedUp: 2, skipped: 1, failed: 0 })
  assert.equal(existsSync(join(f.home.root, '.attic', 'backup.lock')), false)
})

test('refresh imports another machine before unchanged sessions skip all writes', async () => {
  const f = await fixture()
  const paths = writeClaudeSession(f.home, ID)
  age(f.home.claude, paths)
  assert.equal(await backup(f.options, ID, f.print, f.connect), 0)
  writeFileSync(join(f.home.root, '.attic', 'index.json'), '{"sessions":{}}')
  const connect: Connect = (login, print) => ({
    ...f.connect(login, print),
    authorizedUntil: async () => {
      throw new Error('nothing due must not check write permissions')
    },
    quote: async () => {
      throw new Error('nothing due must not quote')
    },
    storeBatch: async () => {
      throw new Error('nothing due must not upload')
    },
    remove: async () => {
      throw new Error('nothing due must not remove')
    },
  })
  assert.equal(await backup(f.options, undefined, f.print, connect), 0)
  assert.equal(f.state.pieces.size, 1)
  assert.ok(indexEntry(ID))
  assert.deepEqual(lastRun()?.counts, { backedUp: 0, skipped: 1, failed: 0 })
})

test('failed sessions retain their old piece while successful replacements remove once after indexing', async () => {
  const f = await fixture()
  const paths = writeClaudeSession(f.home, ID)
  const other = writeCodexSession(f.home, OTHER)
  age(f.home.claude, paths)
  age(f.home.codex, other)
  await backup(f.options, undefined, f.print, f.connect)
  const previous = indexEntry(ID)
  const previousOther = indexEntry(OTHER)
  assert.ok(previous && previousOther)
  for (const [root, changedPaths] of [
    [f.home.claude, paths],
    [f.home.codex, other],
  ] as const) {
    appendFileSync(join(root, changedPaths[0] ?? ''), '{}\n')
    age(root, changedPaths)
  }
  let removals = 0
  const connect: Connect = (login, print) => {
    const storage = f.connect(login, print)
    return {
      ...storage,
      async storeBatch(envelopes) {
        const [first] = envelopes
        assert.ok(first)
        return [...(await storage.storeBatch([first])), { status: 'rejected', reason: new Error('provider failed') }]
      },
      async scheduleRemoval(copies) {
        removals++
        assert.notEqual(indexEntry(ID)?.pieceCid, previous.pieceCid)
        assert.equal(indexEntry(OTHER)?.pieceCid, previousOther.pieceCid)
        assert.deepEqual(copies, previous.copies)
        await storage.scheduleRemoval(copies)
      },
    }
  }
  assert.equal(await backup(f.options, undefined, f.print, connect), 1)
  assert.equal(removals, 1)
  assert.equal(f.state.pieces.has(previous.pieceCid), false)
  assert.equal(f.state.pieces.has(previousOther.pieceCid), true)
  assert.deepEqual(lastRun()?.counts, { backedUp: 1, skipped: 0, failed: 1 })
  assert.equal(await backup(f.options, undefined, f.print, f.connect), 0)
  assert.deepEqual(lastRun()?.counts, { backedUp: 1, skipped: 1, failed: 0 })
})

test('a malformed session does not stop another session, and a failed listing releases the lock', async () => {
  const f = await fixture()
  const paths = writeCodexSession(f.home, ID)
  writeFileSync(join(f.home.codex, paths[0] ?? ''), 'invalid\n')
  age(f.home.codex, paths)
  age(f.home.claude, writeClaudeSession(f.home, OTHER))
  assert.equal(await backup(f.options, undefined, f.print, f.connect), 1)
  assert.ok(indexEntry(OTHER))
  assert.equal(indexEntry(ID), undefined)
  assert.equal(lastRun()?.counts?.failed, 1)
  f.state.listError = new Error('RPC unavailable')
  await assert.rejects(backup(f.options, undefined, f.print, f.connect), /RPC unavailable/)
  assert.equal(lastRun()?.ok, false)
  assert.equal(existsSync(join(f.home.root, '.attic', 'backup.lock')), false)
})

test('a lock held by a running process skips the run, and the lock of a stopped process is replaced', async () => {
  const f = await fixture()
  const lock = join(f.home.root, '.attic', 'backup.lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'pid'), String(process.pid))
  assert.equal(
    await backup(f.options, undefined, f.print, () => {
      throw new Error('must not connect')
    }),
    0
  )
  assert.equal(lastRun(), undefined)
  assert.equal(existsSync(lock), true)

  const stopped = spawnSync(process.execPath, ['-e', '']).pid
  writeFileSync(join(lock, 'pid'), String(stopped))
  assert.equal(await backup(f.options, undefined, f.print, f.connect), 0)
  assert.ok(f.lines.includes(`Removed the lock of stopped backup process ${stopped}.`), f.lines.join('\n'))
  assert.equal(lastRun()?.ok, true)
  assert.equal(existsSync(lock), false)
})

test('explicit and idle runs upload nothing for a snapshot older than the indexed backup', async () => {
  const f = await fixture()
  const paths = writeClaudeSession(f.home, ID)
  await backup(f.options, ID, f.print, f.connect)
  const newest = indexEntry(ID)
  assert.ok(newest)
  appendFileSync(join(f.home.claude, paths[0] ?? ''), '{}\n')
  age(f.home.claude, paths)
  assert.equal(await backup(f.options, ID, f.print, f.connect), 0)
  assert.ok(f.lines.some((line) => line.startsWith(`✓ Skipped session ${ID}: the index holds a newer backup`)))
  assert.equal(indexEntry(ID)?.pieceCid, newest.pieceCid)
  assert.equal(f.state.pieces.size, 1)
  assert.equal(await backup(f.options, undefined, f.print, f.connect), 0)
  assert.equal(f.state.pieces.size, 1)
  assert.deepEqual(lastRun()?.counts, { backedUp: 0, skipped: 1, failed: 0 })
})

test('preflight failures count all due sessions and release the lock', async () => {
  for (const stage of ['authorization', 'quote']) {
    const f = await fixture()
    age(f.home.claude, writeClaudeSession(f.home, ID))
    const connect: Connect = (login, print) => ({
      ...f.connect(login, print),
      ...(stage === 'authorization'
        ? {
            authorizedUntil: async () => {
              throw new Error('RPC unavailable')
            },
          }
        : {
            quote: async () => {
              throw new Error('RPC unavailable')
            },
          }),
    })
    await assert.rejects(backup(f.options, undefined, f.print, connect), /RPC unavailable/)
    assert.equal(lastRun()?.counts?.failed, 1)
    assert.equal(lastRun()?.ok, false)
    assert.equal(existsSync(join(f.home.root, '.attic', 'backup.lock')), false)
  }
})

test('a run larger than the chunk size commits and removes one chunk at a time', async () => {
  const f = await fixture()
  const sessions = [
    [f.home.claude, writeClaudeSession(f.home, ID)],
    [f.home.codex, writeCodexSession(f.home, OTHER)],
  ] as const
  for (const [root, paths] of sessions) age(root, paths)
  await backup(f.options, undefined, f.print, f.connect)
  for (const [root, paths] of sessions) {
    appendFileSync(join(root, paths[0] ?? ''), '{}\n')
    age(root, paths)
  }
  const calls: string[] = []
  const connect: Connect = (login, print) => {
    const storage = f.connect(login, print)
    return {
      ...storage,
      async storeBatch(envelopes) {
        calls.push(`store ${envelopes.length}`)
        return storage.storeBatch(envelopes)
      },
      async scheduleRemoval(copies) {
        calls.push(`remove ${copies.length}`)
        return storage.scheduleRemoval(copies)
      },
    }
  }
  assert.equal(await backup({ ...f.options, chunkBytes: 1 }, undefined, f.print, connect), 0)
  assert.deepEqual(calls, ['store 1', 'remove 1', 'store 1', 'remove 1'])
  assert.equal(f.state.pieces.size, 2)
})
