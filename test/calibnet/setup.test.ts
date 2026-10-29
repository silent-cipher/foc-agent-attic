import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import { calibration } from '@filoz/synapse-core/chains'
import { AddPiecesPermission, CreateDataSetPermission, loginSync } from '@filoz/synapse-core/session-key'
import { createWalletClient, http, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { runAttic, tempHome } from '../e2e/helpers.ts'
import { makeGrant } from '../make-grant.ts'

const ownerKey = process.env.ATTIC_CALIBNET_PRIVATE_KEY

test('setup sees a session key the owner authorized on calibnet', {
  skip: ownerKey === undefined && 'set ATTIC_CALIBNET_PRIVATE_KEY to a funded calibnet wallet key',
  timeout: 300_000,
}, async () => {
  assert.ok(ownerKey !== undefined && isHex(ownerKey))
  const home = await tempHome()
  assert.equal(runAttic(home, ['setup', '--network', 'calibration']).status, 2)
  const { SESSION_KEY: sessionKey } = parseEnv(readFileSync(join(home.root, '.attic', 'session.env'), 'utf8'))
  assert.ok(sessionKey !== undefined && isHex(sessionKey))

  // The console's two steps, done with the owner key: a Grant, then the on-chain authorization.
  const expires = Math.floor(Date.now() / 1000) + 3600
  const grant = await makeGrant({ ownerKey, sessionKey, chainId: calibration.id, expires })
  const before = runAttic(home, ['setup', '--grant', grant])
  assert.equal(before.status, 2, before.stdout + before.stderr)
  assert.match(before.stdout, /✓ Grant saved/)
  assert.match(before.stdout, /✗ Session key not authorized/)

  const owner = createWalletClient({ account: privateKeyToAccount(ownerKey), chain: calibration, transport: http() })
  await loginSync(owner, {
    address: privateKeyToAccount(sessionKey).address,
    permissions: [CreateDataSetPermission, AddPiecesPermission],
    expiresAt: BigInt(expires),
    origin: 'attic-calibnet-test',
  })

  const after = runAttic(home, ['setup'])
  assert.match(after.stdout, /✓ Session key authorized/, after.stdout + after.stderr)
  assert.match(after.stdout, /Session key expires \d{4}-\d{2}-\d{2} \(in 0 days\)/)
})
