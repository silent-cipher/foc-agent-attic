import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { GROUP_KEY, OWNER_KEY } from '../make-grant.ts'
import { type Home, logIn, runAttic, tempHome, writeClaudeSession } from './helpers.ts'

const ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'
const OTHER = '7a2b4c6d-8e9f-4a1b-9c2d-3e4f5a6b7c8d'
const CALIBRATION = { ATTIC_NETWORK: 'calibration' }

function entry(sessionId: string, project: string, lastWriteAt: string, size: number) {
  return {
    v: 1,
    agent: 'claude-code',
    sessionId,
    project,
    machine: 'e2e',
    lastWriteAt,
    files: [],
    network: 'calibration',
    owner: privateKeyToAccount(OWNER_KEY).address,
    groupKey: GROUP_KEY,
    pieceCid: `bafk-${sessionId}`,
    size,
    copies: [],
  }
}

function writeIndex(home: Home, entries: ReturnType<typeof entry>[]): void {
  mkdirSync(join(home.root, '.attic'), { recursive: true })
  const sessions = Object.fromEntries(entries.map((e) => [e.sessionId, e]))
  writeFileSync(join(home.root, '.attic', 'index.json'), JSON.stringify({ sessions }))
}

test('sessions lists the index newest first, offline', async () => {
  const home = await tempHome()
  await logIn(home)
  writeIndex(home, [
    entry(ID, '/tmp/old', '2026-10-01T08:00:00.000Z', 2048),
    entry(OTHER, '/tmp/new', '2026-10-28T09:12:00.000Z', 1536),
  ])
  const result = runAttic(home, ['sessions'], CALIBRATION)
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.deepEqual(result.stdout.split('\n').slice(0, 3), [
    'Session ID                            Agent        Project   Last write (UTC)  Size',
    `${OTHER}  claude-code  /tmp/new  2026-10-28 09:12  1.5 KiB`,
    `${ID}  claude-code  /tmp/old  2026-10-01 08:00  2.0 KiB`,
  ])
  assert.match(result.stdout, /No backup run has finished on this machine yet\./)
})

test('sessions shows a failed backup run and that Attic is not logged in', async () => {
  const home = await tempHome()
  writeClaudeSession(home, ID)
  assert.equal(runAttic(home, ['backup', ID]).status, 1)
  const result = runAttic(home, ['sessions'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^No sessions in the Attic index\./)
  assert.match(
    result.stdout,
    /\nLast run \d{4}-\d\d-\d\d \d\d:\d\d UTC failed:\n {2}✗ Attic is not logged in\. Run \/attic:setup first\.\n/
  )
  assert.match(result.stdout, /\n✗ Attic is not logged in\. Run \/attic:setup first\.\n$/)
})
