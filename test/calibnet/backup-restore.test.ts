import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { parseEnv } from 'node:util'
import { calibration } from '@filoz/synapse-core/chains'
import {
  AddPiecesPermission,
  CreateDataSetPermission,
  loginSync,
  SchedulePieceRemovalsPermission,
} from '@filoz/synapse-core/session-key'
import { createWalletClient, http, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type Home, runAttic, runAtticLive, tempHome, writeClaudeSession, writeCodexSession } from '../e2e/helpers.ts'
import { makeGrant } from '../make-grant.ts'

const ownerKey = process.env.ATTIC_CALIBNET_PRIVATE_KEY
const ENV = { ATTIC_NETWORK: 'calibration' }

// Claude Code answers a session it can open with "Not logged in" here, before asking any model.
function claudeResume(home: Home, id: string): string {
  const result = spawnSync('claude', ['-p', '--resume', id, 'hi'], {
    cwd: home.root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home.root, CLAUDE_CONFIG_DIR: home.claude },
    timeout: 60_000,
  })
  assert.equal(result.error, undefined, 'Claude Code (`claude`) must be on PATH')
  return result.stdout + result.stderr
}

test('a backed-up session restores, on this machine and after a refresh on another, and Claude Code resumes it', {
  skip: ownerKey === undefined && 'set ATTIC_CALIBNET_PRIVATE_KEY to a funded calibnet wallet key',
  timeout: 1_200_000,
}, async () => {
  assert.ok(ownerKey !== undefined && isHex(ownerKey))
  const home = await tempHome()
  const id = crypto.randomUUID()

  runAttic(home, ['setup'], ENV)
  const { SESSION_KEY: sessionKey } = parseEnv(readFileSync(join(home.root, '.attic', 'session.env'), 'utf8'))
  assert.ok(sessionKey !== undefined && isHex(sessionKey))
  const expires = Math.floor(Date.now() / 1000) + 3600
  const grant = await makeGrant({ ownerKey, sessionKey, chainId: calibration.id, expires })
  const owner = createWalletClient({ account: privateKeyToAccount(ownerKey), chain: calibration, transport: http() })
  await loginSync(owner, {
    address: privateKeyToAccount(sessionKey).address,
    permissions: [CreateDataSetPermission, AddPiecesPermission, SchedulePieceRemovalsPermission],
    expiresAt: BigInt(expires),
    origin: 'attic-calibnet-test',
  })
  // The next read can hit an RPC node that has not reached the login block yet.
  let ready = runAttic(home, ['setup', '--grant', grant], ENV)
  for (let attempt = 1; attempt < 6 && ready.status !== 0; attempt++) {
    await setTimeout(10_000)
    ready = runAttic(home, ['setup'], ENV)
  }
  assert.equal(ready.status, 0, ready.stdout + ready.stderr)

  // A second machine, set up before the backup: a new session key whose Grant is enough to refresh and restore,
  // unauthorized on chain.
  const fresh = await tempHome()
  runAttic(fresh, ['setup'], ENV)
  const { SESSION_KEY: freshKey } = parseEnv(readFileSync(join(fresh.root, '.attic', 'session.env'), 'utf8'))
  assert.ok(freshKey !== undefined && isHex(freshKey))
  const freshGrant = await makeGrant({ ownerKey, sessionKey: freshKey, chainId: calibration.id, expires })
  const built = await runAtticLive(fresh, ['setup', '--grant', freshGrant], ENV, 600_000)
  assert.match(built.stdout, /✓ (Index refreshed|The index is already up to date)/, built.stdout + built.stderr)

  const title = `Calibnet ${id}`
  const paths = writeClaudeSession(home, id, title)
  const original = paths.map((path) => readFileSync(join(home.claude, path)))
  const before = new Date(Date.now() - 26 * 60 * 60 * 1000)
  for (const path of paths) utimesSync(join(home.claude, path), before, before)
  const backedUp = await runAtticLive(home, ['backup', id], ENV, 600_000)
  assert.equal(backedUp.status, 0, backedUp.stdout + backedUp.stderr)
  assert.match(backedUp.stdout, new RegExp(`✓ Backed up session ${id}: 2 files`))

  rmSync(join(home.claude, 'projects'), { recursive: true })
  assert.match(claudeResume(home, id), /No conversation found/)

  const restored = await runAtticLive(home, ['restore', id], ENV, 300_000)
  assert.equal(restored.status, 0, restored.stdout + restored.stderr)
  assert.ok(restored.stdout.split('\n').includes(`claude --resume ${id}`), restored.stdout)
  assert.deepEqual(
    paths.map((path) => readFileSync(join(home.claude, path))),
    original
  )
  assert.doesNotMatch(claudeResume(home, id), /No conversation found/)

  const refreshed = await runAtticLive(fresh, ['refresh'], ENV, 300_000)
  assert.equal(refreshed.status, 0, refreshed.stdout + refreshed.stderr)
  assert.match(refreshed.stdout, /✓ Index refreshed: [1-9]\d* new sessions/, refreshed.stdout)

  const listed = runAttic(fresh, ['sessions'], ENV)
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, new RegExp(`\\n${id} +claude-code +/tmp/attic-e2e .* ${title}\\n`))
  const filtered = runAttic(fresh, ['sessions', id.slice(0, 8)], ENV)
  assert.deepEqual(filtered.stdout.split('\n')[1]?.split(' ')[0], id, filtered.stdout)
  assert.match(filtered.stdout.split('\n')[2] ?? '', /^(Last run|No backup run)/, filtered.stdout)
  const again = await runAtticLive(fresh, ['restore', id], ENV, 300_000)
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.deepEqual(
    paths.map((path) => readFileSync(join(fresh.claude, path))),
    original
  )
  assert.doesNotMatch(claudeResume(fresh, id), /No conversation found/)

  await loginSync(owner, {
    address: privateKeyToAccount(freshKey).address,
    permissions: [CreateDataSetPermission, AddPiecesPermission, SchedulePieceRemovalsPermission],
    expiresAt: BigInt(expires),
    origin: 'attic-calibnet-test',
  })
  let freshReady = runAttic(fresh, ['setup'], ENV)
  for (let attempt = 1; attempt < 6 && freshReady.status !== 0; attempt++) {
    await setTimeout(10_000)
    freshReady = runAttic(fresh, ['setup'], ENV)
  }
  assert.equal(freshReady.status, 0, freshReady.stdout + freshReady.stderr)
  const codexId = crypto.randomUUID()
  const remoteId = crypto.randomUUID()
  const codexPaths = writeCodexSession(home, codexId)
  const remotePaths = writeClaudeSession(fresh, remoteId)
  appendFileSync(join(home.claude, paths[0] ?? ''), '{}\n')
  const idle = new Date(Date.now() - 25 * 60 * 60 * 1000)
  for (const [root, files] of [
    [home.claude, paths],
    [home.codex, codexPaths],
    [fresh.claude, remotePaths],
  ] as const) {
    for (const path of files) utimesSync(join(root, path), idle, idle)
  }
  const concurrent = await Promise.all([
    runAtticLive(home, ['backup'], ENV, 600_000),
    runAtticLive(fresh, ['backup'], ENV, 600_000),
  ])
  for (const result of concurrent) {
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const commits = new Set(
      [...result.stdout.matchAll(/Committing on provider \d+, transaction (0x[0-9a-f]+)/g)].map((match) => match[1])
    )
    assert.equal(commits.size, 1, result.stdout)
  }
  for (const machine of [home, fresh]) {
    const refreshed = await runAtticLive(machine, ['refresh'], ENV, 300_000)
    assert.equal(refreshed.status, 0, refreshed.stdout + refreshed.stderr)
    const listed = runAttic(machine, ['sessions', '--json'], ENV)
    assert.equal(listed.status, 0, listed.stderr)
    assert.ok(listed.stdout.includes(codexId) && listed.stdout.includes(remoteId), listed.stdout)
  }
  for (const [machine, sessionId] of [
    [home, remoteId],
    [fresh, codexId],
  ] as const) {
    const restored = await runAtticLive(machine, ['restore', sessionId], ENV, 300_000)
    assert.equal(restored.status, 0, restored.stdout + restored.stderr)
  }
  assert.deepEqual(
    remotePaths.map((path) => readFileSync(join(home.claude, path))),
    remotePaths.map((path) => readFileSync(join(fresh.claude, path)))
  )
  assert.deepEqual(
    codexPaths.map((path) => readFileSync(join(fresh.codex, path))),
    codexPaths.map((path) => readFileSync(join(home.codex, path)))
  )
})
