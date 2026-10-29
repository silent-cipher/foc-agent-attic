import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { type Home, runAttic, tempHome, writeClaudeSession } from './helpers.ts'

const ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'

function writeIndexEntry(home: Home, paths: string[]): void {
  const files = paths.map((path) => {
    const bytes = readFileSync(join(home.claude, path))
    return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const entry = {
    v: 1,
    agent: 'claude-code',
    sessionId: ID,
    project: '/tmp/attic-e2e',
    machine: 'e2e',
    lastWriteAt: '2026-10-28T09:12:00.000Z',
    files,
    pieceCid: 'bafkzcibcaapeh2qvtlm6tdodcaa6s3jfohqc6rqmfhwdgbm2nj4bsgzddlqbu3a',
    size: 1234,
    copies: [],
  }
  mkdirSync(join(home.root, '.attic'), { recursive: true })
  writeFileSync(join(home.root, '.attic', 'index.json'), JSON.stringify({ sessions: { [ID]: entry } }))
}

test('backup of an unknown session uploads nothing and says it was not found', async () => {
  const home = await tempHome()
  writeClaudeSession(home, ID)
  const result = runAttic(home, ['backup', 'a0a0a0a0-0000-4000-8000-000000000000'])
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /^Error: Session a0a0a0a0-0000-4000-8000-000000000000 was not found in .*\.claude\/projects/
  )
})

test('backup before setup says to run setup', async () => {
  const home = await tempHome()
  writeClaudeSession(home, ID)
  const result = runAttic(home, ['backup', ID])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^Error: Attic is not logged in\. Run \/attic:setup first\./)
})

test('backup of a session the index already holds unchanged uploads nothing, without logging in', async () => {
  const home = await tempHome()
  writeIndexEntry(home, writeClaudeSession(home, ID))
  const result = runAttic(home, ['backup', ID])
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.match(result.stdout, new RegExp(`✓ Session ${ID} is already backed up, unchanged`))
})

test('backup of a session that changed since its index entry goes on to upload it', async () => {
  const home = await tempHome()
  const paths = writeClaudeSession(home, ID)
  writeIndexEntry(home, paths)
  writeFileSync(join(home.claude, paths[0] ?? ''), '{"cwd":"/tmp/attic-e2e"}\n{"more":"messages"}\n')
  const result = runAttic(home, ['backup', ID])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Attic is not logged in/)
})

test('restore of a session with no backup writes nothing', async () => {
  const home = await tempHome()
  const result = runAttic(home, ['restore', ID])
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`^Error: Session ${ID} is not in the Attic index`))
  assert.throws(() => statSync(home.claude))
})

test('restore before setup says to run setup', async () => {
  const home = await tempHome()
  writeIndexEntry(home, writeClaudeSession(home, ID))
  const result = runAttic(home, ['restore', ID])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^Error: Attic is not logged in\. Run \/attic:setup first\./)
})
