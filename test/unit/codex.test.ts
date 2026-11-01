import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
    about: {},
  })
  assert.equal(agent.resumeCommand(ID), `codex resume ${ID}`)
})

test('ignores symlink files and directories; missing sessions return undefined', async () => {
  const home = await tempHome()
  assert.equal(codex(home.codex).readSession(ID), undefined)
  const [path] = writeCodexSession(home, ID)
  assert.ok(path)
  const target = join(home.codex, path)
  renameSync(target, `${target}.saved`)
  symlinkSync(`${target}.saved`, target)
  assert.equal(codex(home.codex).readSession(ID), undefined)
  const outside = await tempHome()
  writeCodexSession(outside, ID)
  symlinkSync(join(outside.codex, 'sessions'), join(home.codex, 'sessions', 'linked'))
  assert.equal(codex(home.codex).readSession(ID), undefined)
})

test('a missing project is null and malformed or mismatched metadata is refused', async () => {
  const home = await tempHome()
  const [path] = writeCodexSession(home, ID)
  assert.ok(path)
  const target = join(home.codex, path)
  writeFileSync(target, JSON.stringify({ type: 'session_meta', payload: { id: ID } }))
  assert.equal(codex(home.codex).readSession(ID)?.project, null)
  assert.deepEqual(codex(home.codex).readSession(ID)?.about, {})
  assert.equal(codex(home.codex).readSession(ID.slice(-12)), undefined)
  writeFileSync(target, '{"cut short')
  assert.throws(() => codex(home.codex).readSession(ID), /metadata/)
})

test('reads the latest matching thread name, first user event and metadata branch', async () => {
  const home = await tempHome()
  const [path] = writeCodexSession(home, ID)
  assert.ok(path)
  const target = join(home.codex, path)
  const meta = { type: 'session_meta', payload: { id: ID, git: { branch: 'feat/search' } } }
  const prompt = `  Fix\n the ${'slow '.repeat(20)}search  `
  writeFileSync(
    target,
    [
      JSON.stringify(meta),
      '{"cut short',
      'null',
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'ignore' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 42 } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: prompt } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Later prompt' } }),
      '{"unfinished',
    ].join('\n')
  )
  writeFileSync(
    join(home.codex, 'session_index.jsonl'),
    [
      JSON.stringify({ id: ID, thread_name: 'Old title' }),
      '{"broken',
      'null',
      JSON.stringify({ id: ID, thread_name: 'Search faster' }),
      JSON.stringify({ id: 'other', thread_name: 'Another session' }),
      JSON.stringify({ id: ID, thread_name: 42 }),
    ].join('\n')
  )
  const session = codex(home.codex).readSession(ID)
  assert.deepEqual(session?.about, {
    title: 'Search faster',
    firstPrompt: `${prompt.replace(/\s+/g, ' ').trim().slice(0, 79)}…`,
    branch: 'feat/search',
  })
  assert.deepEqual(session?.files, [{ path, bytes: readFileSync(target) }])
})

test('missing or unreadable title indexes do not prevent reading a rollout', async () => {
  const home = await tempHome()
  writeCodexSession(home, ID)
  assert.deepEqual(codex(home.codex).readSession(ID)?.about, {})
  mkdirSync(join(home.codex, 'session_index.jsonl'))
  assert.deepEqual(codex(home.codex).readSession(ID)?.about, {})
})

test('omits empty or invalid fields and keeps a short first prompt intact', async () => {
  const home = await tempHome()
  const [path] = writeCodexSession(home, ID)
  assert.ok(path)
  for (const branch of ['', 42, null]) {
    writeFileSync(
      join(home.codex, path),
      JSON.stringify({ type: 'session_meta', payload: { id: ID, git: { branch } } })
    )
    writeFileSync(join(home.codex, 'session_index.jsonl'), JSON.stringify({ id: 'other', thread_name: 'Other' }))
    assert.deepEqual(codex(home.codex).readSession(ID)?.about, {})
  }
  appendFileSync(
    join(home.codex, path),
    '\n{"type":"event_msg","payload":{"type":"user_message","message":"  Fix\\n search  "}}\n'
  )
  assert.deepEqual(codex(home.codex).readSession(ID)?.about, { firstPrompt: 'Fix search' })
})
