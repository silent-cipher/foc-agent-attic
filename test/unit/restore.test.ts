import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeSessionFiles } from '../../src/restore.ts'

const bytes = (text: string) => new TextEncoder().encode(text)
const TRANSCRIPT = { path: 'projects/-tmp-app/s1.jsonl', bytes: bytes('transcript') }
const SUBAGENT = { path: 'projects/-tmp-app/s1/subagents/a1.jsonl', bytes: bytes('subagent') }

function home(): string {
  return mkdtempSync(join(tmpdir(), 'attic-restore-'))
}

test('writes every file into its folder, owner-readable only', () => {
  const root = home()
  assert.equal(writeSessionFiles(root, [TRANSCRIPT, SUBAGENT]), 2)
  assert.equal(readFileSync(join(root, SUBAGENT.path), 'utf8'), 'subagent')
  assert.equal(statSync(join(root, TRANSCRIPT.path)).mode & 0o777, 0o600)
})

test('leaves identical files alone and writes only the missing ones', () => {
  const root = home()
  writeSessionFiles(root, [TRANSCRIPT])
  assert.equal(writeSessionFiles(root, [TRANSCRIPT, SUBAGENT]), 1)
  assert.equal(writeSessionFiles(root, [TRANSCRIPT, SUBAGENT]), 0)
})

test('an existing file that differs writes nothing, not even the missing files', () => {
  const root = home()
  mkdirSync(join(root, 'projects/-tmp-app/s1/subagents'), { recursive: true })
  writeFileSync(join(root, SUBAGENT.path), 'edited since')
  assert.throws(() => writeSessionFiles(root, [TRANSCRIPT, SUBAGENT]), /a1\.jsonl already exists and differs/)
  assert.equal(existsSync(join(root, TRANSCRIPT.path)), false)
  assert.equal(readFileSync(join(root, SUBAGENT.path), 'utf8'), 'edited since')
})

test('a path outside the home folder writes nothing', () => {
  for (const path of ['../escape.jsonl', 'projects/../../escape.jsonl', '/tmp/escape.jsonl', '.']) {
    const root = home()
    assert.throws(() => writeSessionFiles(root, [TRANSCRIPT, { path, bytes: bytes('x') }]), /is outside/, path)
    assert.equal(existsSync(join(root, TRANSCRIPT.path)), false)
  }
})
