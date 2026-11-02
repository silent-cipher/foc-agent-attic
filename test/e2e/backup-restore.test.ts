import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { GROUP_KEY, OWNER_KEY } from '../make-grant.ts'
import { type Home, logIn, runAttic, tempHome, writeClaudeSession, writeCodexSession } from './helpers.ts'

const ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'
const CALIBRATION = { ATTIC_NETWORK: 'calibration' }
const KEYHOLDER = { network: 'calibration', owner: privateKeyToAccount(OWNER_KEY).address, groupKey: GROUP_KEY }

function writeIndexEntry(
  home: Home,
  paths: string[],
  keyholder: Partial<typeof KEYHOLDER> = {},
  agent: 'claude-code' | 'codex' = 'claude-code'
): void {
  const files = paths.map((path) => {
    const bytes = readFileSync(join(agent === 'codex' ? home.codex : home.claude, path))
    return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const entry = {
    v: 1,
    agent,
    sessionId: ID,
    project: '/tmp/attic-e2e',
    machine: 'e2e',
    lastWriteAt: '2026-10-28T09:12:00.000Z',
    files,
    ...KEYHOLDER,
    ...keyholder,
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
    /^Error: Session a0a0a0a0-0000-4000-8000-000000000000 was not found in .*\.claude or .*\.codex\./
  )
})

test('backup before setup says to run setup', async () => {
  const home = await tempHome()
  writeClaudeSession(home, ID)
  const result = runAttic(home, ['backup', ID])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^Error: Attic is not logged in\. Run \/attic:setup first\./)
})

test('backup of a session the index already holds unchanged, for this login, uploads nothing', async () => {
  const home = await tempHome()
  await logIn(home)
  writeIndexEntry(home, writeClaudeSession(home, ID))
  const result = runAttic(home, ['backup', ID], CALIBRATION)
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.match(result.stdout, new RegExp(`✓ Session ${ID} is already backed up, unchanged`))
})

test('--current selects the invoking agent, even when the other agent has the same ID', async () => {
  for (const agent of ['claude-code', 'codex'] as const) {
    const home = await tempHome()
    await logIn(home)
    const claudePaths = writeClaudeSession(home, ID)
    const codexPaths = writeCodexSession(home, ID)
    const paths = agent === 'codex' ? codexPaths : claudePaths
    writeIndexEntry(home, paths, {}, agent)
    const env = agent === 'codex' ? { CODEX_THREAD_ID: ID } : { CLAUDE_SESSION_ID: ID }
    const result = runAttic(home, ['backup', '--current'], { ...CALIBRATION, ...env })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /already backed up, unchanged/)
  }
})

test('--current refuses missing, ambiguous or unsafe context and conflicting arguments', async () => {
  const home = await tempHome()
  for (const [args, env, reason] of [
    [['backup', '--current'], {}, /No current session ID/],
    [['backup', '--current'], { CLAUDE_SESSION_ID: ID, CODEX_THREAD_ID: ID }, /Both agents supply/],
    [['backup', '--current'], { CODEX_THREAD_ID: '../outside' }, /is not a session ID/],
    [['backup', '--current', ID], { CODEX_THREAD_ID: ID }, /not both/],
    [['restore', '--current'], { CODEX_THREAD_ID: ID }, /Unknown option/],
  ] as const) {
    const result = runAttic(home, args, env)
    assert.equal(result.status, 64)
    assert.match(result.stderr, reason)
    assert.equal(result.stdout, '')
  }
})

test('restore refuses a backup that this login cannot decrypt, before downloading it', async () => {
  const others: Partial<typeof KEYHOLDER>[] = [
    { groupKey: '0x0000000000000000000000000000000a' },
    { network: 'mainnet' },
  ]
  for (const keyholder of others) {
    const home = await tempHome()
    await logIn(home)
    writeIndexEntry(home, writeClaudeSession(home, ID), keyholder)
    const result = runAttic(home, ['restore', ID], CALIBRATION)
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`Session ${ID} is backed up under group key .* but this login is for`))
    assert.doesNotMatch(result.stdout, /Downloading/)
  }
})

test('restore of a session missing from the index suggests refresh and writes nothing', async () => {
  const home = await tempHome()
  await logIn(home)
  const result = runAttic(home, ['restore', ID], CALIBRATION)
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    new RegExp(
      `^Error: Session ${ID} is not in the Attic index\\. If another machine backed it up, run /attic:refresh, then restore again\\. Nothing was written\\.`
    )
  )
  assert.equal(result.stdout, '')
  assert.throws(() => statSync(home.claude))
})

test('refresh before setup says to run setup', async () => {
  const home = await tempHome()
  const result = runAttic(home, ['refresh'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^Error: Attic is not logged in\. Run \/attic:setup first\./)
  assert.equal(result.stdout, '')
})

test('restore before setup says to run setup', async () => {
  const home = await tempHome()
  writeIndexEntry(home, writeClaudeSession(home, ID))
  const result = runAttic(home, ['restore', ID])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^Error: Attic is not logged in\. Run \/attic:setup first\./)
})

test('the CLI finds Codex rollouts under CODEX_HOME, skips unchanged backups and lists them offline', async () => {
  const home = await tempHome()
  home.codex = join(home.root, 'custom-codex')
  const paths = writeCodexSession(home, ID)
  const before = runAttic(home, ['backup', ID])
  assert.match(before.stderr, /Attic is not logged in/)
  writeIndexEntry(home, paths, {}, 'codex')
  const beforeRestore = runAttic(home, ['restore', ID], CALIBRATION)
  assert.match(beforeRestore.stderr, /Attic is not logged in/)
  await logIn(home)
  const backedUp = runAttic(home, ['backup', ID], CALIBRATION)
  assert.equal(backedUp.status, 0, backedUp.stderr)
  assert.match(backedUp.stdout, /already backed up, unchanged/)
  const listed = runAttic(home, ['sessions'], CALIBRATION)
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, new RegExp(`${ID} +codex +/tmp/attic-e2e`))
})

test('backup without an ID starts the idle run and requires setup', async () => {
  const home = await tempHome()
  const result = runAttic(home, ['backup'], CALIBRATION)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Attic is not logged in.*setup first/)
  assert.throws(() => statSync(join(home.root, '.attic', 'backup.lock')))
})

test('backup without an ID skips a held lock and preserves status', async () => {
  const home = await tempHome()
  mkdirSync(join(home.root, '.attic'), { recursive: true })
  // This test's process stays running while the CLI checks the lock.
  writeFileSync(join(home.root, '.attic', 'backup.lock'), String(process.pid))
  const status = join(home.root, '.attic', 'status.json')
  writeFileSync(status, 'previous status')
  const result = runAttic(home, ['backup'], CALIBRATION)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /skipping this run/)
  assert.equal(readFileSync(status, 'utf8'), 'previous status')
})

test('with --json, backup prints its counts on stdout and its progress on stderr', async () => {
  const home = await tempHome()
  await logIn(home)
  writeIndexEntry(home, writeClaudeSession(home, ID))
  const result = runAttic(home, ['backup', ID, '--json'], CALIBRATION)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { backedUp: 0, skipped: 1, failed: 0 })
  assert.match(result.stderr, /already backed up, unchanged/)

  writeFileSync(join(home.root, '.attic', 'backup.lock'), String(process.pid))
  const locked = runAttic(home, ['backup', '--json'], CALIBRATION)
  assert.equal(locked.status, 0, locked.stderr)
  assert.deepEqual(JSON.parse(locked.stdout), { backedUp: 0, skipped: 0, failed: 0, locked: true })
})

test('with --json, a failure is one JSON error on stdout saying what to fix and whether a retry can help', async () => {
  const home = await tempHome()
  const loggedIn = await tempHome()
  await logIn(loggedIn)
  const cases = [
    [['refresh', '--json'], 1, 'setup'],
    [['backup', 'a0a0a0a0-0000-4000-8000-000000000000', '--json'], 1, 'not_found'],
    [['restore', ID, '--json'], 1, 'not_found'],
    [['restore', '--json'], 64, 'usage'],
    [['backup', '--current', '--json'], 64, 'usage'],
  ] as const
  for (const [args, status, type] of cases) {
    const result = type === 'setup' ? runAttic(home, args) : runAttic(loggedIn, args, CALIBRATION)
    assert.equal(result.status, status, args.join(' '))
    const error = JSON.parse(result.stdout)
    assert.deepEqual({ ...error, message: undefined }, { error: type, message: undefined, retryable: false })
    assert.ok(result.stderr.startsWith(`Error: ${error.message}\n`), result.stderr)
  }
  writeIndexEntry(loggedIn, writeClaudeSession(loggedIn, ID), { network: 'mainnet' })
  const other = runAttic(loggedIn, ['restore', ID, '--json'], CALIBRATION)
  assert.equal(other.status, 1)
  assert.equal(JSON.parse(other.stdout).error, 'conflict')
})
