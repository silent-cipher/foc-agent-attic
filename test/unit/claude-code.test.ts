import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readClaudeSession } from '../../src/claude-code.ts'

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
  const session = readClaudeSession(home, ID)
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
  assert.equal(readClaudeSession(claudeHome(), ID)?.project, '/Users/me/work/app')
})

test('the last write is the newest file in the session', () => {
  const home = claudeHome()
  const newest = new Date('2026-10-28T09:12:00Z')
  const older = new Date('2026-10-27T09:12:00Z')
  const project = join(home, 'projects', '-Users-me-work-app')
  utimesSync(join(project, `${ID}.jsonl`), older, older)
  utimesSync(join(project, ID, 'tool-results', 't1.txt'), older, older)
  utimesSync(join(project, ID, 'subagents', 'a1.jsonl'), newest, newest)
  assert.deepEqual(readClaudeSession(home, ID)?.lastWriteAt, newest)
})

test('skips symlinks inside the session folder', () => {
  const home = claudeHome()
  symlinkSync('/etc/hosts', join(home, 'projects', '-Users-me-work-app', ID, 'link'))
  assert.equal(readClaudeSession(home, ID)?.files.length, 3)
})

test('an unknown session or a home without projects is not found', () => {
  assert.equal(readClaudeSession(claudeHome(), 'a0a0a0a0-0000-4000-8000-000000000000'), undefined)
  assert.equal(readClaudeSession(mkdtempSync(join(tmpdir(), 'attic-empty-')), ID), undefined)
})
