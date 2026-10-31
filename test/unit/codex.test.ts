import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { codex, codexHome } from '../../src/codex.ts'
import { tempHome, writeCodexSession } from '../e2e/helpers.ts'

const ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'

test('Codex home defaults to ~/.codex and honors CODEX_HOME', () => {
  assert.equal(codexHome({}), join(homedir(), '.codex'))
  assert.equal(codexHome({ CODEX_HOME: '/tmp/custom-codex' }), '/tmp/custom-codex')
})

test('reads only the requested rollout, byte for byte, with its project and last write', async () => {
  const home = await tempHome()
  const [path] = writeCodexSession(home, ID)
  assert.ok(path)
  writeCodexSession(home, 'other-session')
  const target = join(home.codex, path)
  const date = new Date('2026-10-28T10:00:00Z')
  writeFileSync(target, `${readFileSync(target, 'utf8')}{"cut short`)
  utimesSync(target, date, date)
  const agent = codex(home.codex)
  assert.deepEqual(agent.readSession(ID), {
    files: [{ path, bytes: readFileSync(target) }],
    project: '/tmp/attic-e2e',
    lastWriteAt: date,
  })
  assert.equal(agent.resumeCommand(ID), `codex resume ${ID}`)
})

test('ignores symlinks, unrelated files and partial IDs; missing sessions return undefined', async () => {
  const home = await tempHome()
  assert.equal(codex(home.codex).readSession(ID), undefined)
  const [path] = writeCodexSession(home, ID)
  assert.ok(path)
  const target = join(home.codex, path)
  renameSync(target, `${target}.saved`)
  symlinkSync(`${target}.saved`, target)
  assert.equal(codex(home.codex).readSession(ID), undefined)
  mkdirSync(join(home.codex, 'sessions', 'linked'), { recursive: true })
  symlinkSync(dirname(target), join(home.codex, 'sessions', 'linked', 'dir'))
  assert.equal(codex(home.codex).readSession('missing'), undefined)
})

test('a missing project is null and malformed or mismatched metadata is refused', async () => {
  const home = await tempHome()
  const [path] = writeCodexSession(home, ID)
  assert.ok(path)
  const target = join(home.codex, path)
  writeFileSync(target, JSON.stringify({ type: 'session_meta', payload: { id: ID } }))
  assert.equal(codex(home.codex).readSession(ID)?.project, null)
  assert.equal(codex(home.codex).readSession(ID.slice(-12)), undefined)
  writeFileSync(target, '{"cut short')
  assert.throws(() => codex(home.codex).readSession(ID), /metadata/)
})
