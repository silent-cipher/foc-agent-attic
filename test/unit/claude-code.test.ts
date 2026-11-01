import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeCode } from '../../src/claude-code.ts'

const ID = 'f6c998dd-bca7-4fcc-9e4c-d0fb49ced1b4'

function claudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'attic-claude-'))
  const project = join(home, 'projects', '-Users-me-work-app')
  mkdirSync(join(project, ID, 'subagents'), { recursive: true })
  mkdirSync(join(project, ID, 'tool-results'), { recursive: true })
  writeFileSync(
    join(project, `${ID}.jsonl`),
    `{"type":"mode","sessionId":"${ID}"}\n{"cut short\n{"cwd":"/Users/me/work/app"}\n`
  )
  writeFileSync(join(project, ID, 'subagents', 'a1.jsonl'), 'subagent')
  writeFileSync(join(project, ID, 'tool-results', 't1.txt'), 'tool output')
  writeFileSync(join(project, 'other-session.jsonl'), 'not this one')
  return home
}

test('reads the transcript and the files under its folder, paths relative to the home folder', () => {
  const home = claudeHome()
  const session = claudeCode(home).readSession(ID)
  assert.ok(session !== undefined)
  assert.deepEqual(
    session.files.map((file) => file.path),
    [
      `projects/-Users-me-work-app/${ID}.jsonl`,
      `projects/-Users-me-work-app/${ID}/subagents/a1.jsonl`,
      `projects/-Users-me-work-app/${ID}/tool-results/t1.txt`,
    ]
  )
  assert.equal(new TextDecoder().decode(session.files[1]?.bytes), 'subagent')
})

test('takes the project from the first cwd in the transcript', () => {
  assert.equal(claudeCode(claudeHome()).readSession(ID)?.project, '/Users/me/work/app')
})

test('the last write is the newest file in the session', () => {
  const home = claudeHome()
  const newest = new Date('2026-10-28T09:12:00Z')
  const older = new Date('2026-10-27T09:12:00Z')
  const project = join(home, 'projects', '-Users-me-work-app')
  utimesSync(join(project, `${ID}.jsonl`), older, older)
  utimesSync(join(project, ID, 'tool-results', 't1.txt'), older, older)
  utimesSync(join(project, ID, 'subagents', 'a1.jsonl'), newest, newest)
  assert.deepEqual(claudeCode(home).readSession(ID)?.lastWriteAt, newest)
})

test('skips symlinks inside the session folder', () => {
  const home = claudeHome()
  symlinkSync('/etc/hosts', join(home, 'projects', '-Users-me-work-app', ID, 'link'))
  assert.equal(claudeCode(home).readSession(ID)?.files.length, 3)
})

test('an unknown session or a home without projects is not found', () => {
  assert.equal(claudeCode(claudeHome()).readSession('a0a0a0a0-0000-4000-8000-000000000000'), undefined)
  assert.equal(claudeCode(mkdtempSync(join(tmpdir(), 'attic-empty-'))).readSession(ID), undefined)
})

test('reads the latest title, the first typed prompt and the latest branch from the transcript', () => {
  const home = claudeHome()
  const lines = [
    { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>…' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, gitBranch: 'main' },
    { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Skill text' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] } },
    { type: 'ai-title', aiTitle: 'First title', sessionId: ID },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `Fix\n  the ${'very '.repeat(30)}slow index` }] },
      gitBranch: 'feat/index',
    },
    { type: 'user', message: { role: 'user', content: 'a later prompt' }, gitBranch: '' },
    { type: 'ai-title', aiTitle: 'Speed up the index', sessionId: ID },
  ]
  writeFileSync(
    join(home, 'projects', '-Users-me-work-app', `${ID}.jsonl`),
    lines.map((line) => `${JSON.stringify(line)}\n`).join('')
  )
  const about = claudeCode(home).readSession(ID)?.about
  assert.equal(about?.title, 'Speed up the index')
  assert.equal(about?.branch, 'feat/index')
  assert.match(about?.firstPrompt ?? '', /^Fix the very very [a-z ]+…$/)
})

test('a transcript without a title, prompt or branch says nothing about them', () => {
  assert.deepEqual(claudeCode(claudeHome()).readSession(ID)?.about, {})
})
