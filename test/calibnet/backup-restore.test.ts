import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { parseEnv } from 'node:util'
import { calibration } from '@filoz/synapse-core/chains'
import { AddPiecesPermission, CreateDataSetPermission, loginSync } from '@filoz/synapse-core/session-key'
import { createWalletClient, http, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type Home, runAttic, tempHome, writeClaudeSession } from '../e2e/helpers.ts'
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

test('a backed-up session, deleted locally, restores and Claude Code resumes it', {
  skip: ownerKey === undefined && 'set ATTIC_CALIBNET_PRIVATE_KEY to a funded calibnet wallet key',
  timeout: 900_000,
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
    permissions: [CreateDataSetPermission, AddPiecesPermission],
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

  const paths = writeClaudeSession(home, id)
  const original = paths.map((path) => readFileSync(join(home.claude, path)))
  const backedUp = runAttic(home, ['backup', id], ENV)
  assert.equal(backedUp.status, 0, backedUp.stdout + backedUp.stderr)
  assert.match(backedUp.stdout, new RegExp(`✓ Backed up session ${id}: 2 files`))

  rmSync(join(home.claude, 'projects'), { recursive: true })
  assert.match(claudeResume(home, id), /No conversation found/)

  const restored = runAttic(home, ['restore', id], ENV)
  assert.equal(restored.status, 0, restored.stdout + restored.stderr)
  assert.ok(restored.stdout.split('\n').includes(`claude --resume ${id}`), restored.stdout)
  assert.deepEqual(
    paths.map((path) => readFileSync(join(home.claude, path))),
    original
  )
  assert.doesNotMatch(claudeResume(home, id), /No conversation found/)
})
