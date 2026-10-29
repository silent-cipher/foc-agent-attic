import assert from 'node:assert/strict'
import { test } from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { openGrant } from '../../src/grant.ts'
import { CALIBRATION, makeGrant, OWNER_KEY, SESSION_KEY, STRANGER_KEY } from '../make-grant.ts'

test('a console Grant opens for its session key and names its owner', async () => {
  const text = await makeGrant({ expires: 4102444800 })
  const opened = await openGrant(text, SESSION_KEY, CALIBRATION)
  assert.equal(opened.owner, privateKeyToAccount(OWNER_KEY).address)
  assert.equal(opened.expires, 4102444800)
  assert.equal(opened.text, text)
})

test('a Grant wrapped across lines opens', async () => {
  const text = await makeGrant()
  const wrapped = `  ${text.slice(0, 40)}\n${text.slice(40)}\n`
  assert.equal((await openGrant(wrapped, SESSION_KEY, CALIBRATION)).text, text)
})

test('a Grant for the attic scope opens', async () => {
  await openGrant(await makeGrant({ node: 'scope:attic' }), SESSION_KEY, CALIBRATION)
})

test('refuses text that is not a Grant', async () => {
  for (const text of ['', 'fak1_abc', 'https://pay.filecoin.cloud/share#v1/abc', 'fgr1_not base64!']) {
    await assert.rejects(openGrant(text, SESSION_KEY, CALIBRATION), /This is not a Grant/)
  }
})

test('refuses a truncated Grant', async () => {
  const text = await makeGrant()
  await assert.rejects(openGrant(text.slice(0, -20), SESSION_KEY, CALIBRATION), /The Grant does not open/)
})

test('refuses a Grant for another session key', async () => {
  await assert.rejects(
    openGrant(await makeGrant({ sessionKey: STRANGER_KEY }), SESSION_KEY, CALIBRATION),
    /The Grant does not open: .*another bearer/
  )
})

test('refuses an expired Grant', async () => {
  const text = await makeGrant({ expires: 1_000_000 })
  await assert.rejects(openGrant(text, SESSION_KEY, CALIBRATION), /The Grant does not open: The chain expired/)
})

test('refuses a Grant for another network', async () => {
  await assert.rejects(
    openGrant(await makeGrant({ chainId: 314 }), SESSION_KEY, CALIBRATION),
    /The Grant is for chain id 314, not 314159/
  )
})

test('refuses a Grant that does not cover the attic scope', async () => {
  await assert.rejects(
    openGrant(await makeGrant({ node: 'scope:photos' }), SESSION_KEY, CALIBRATION),
    /cannot write under "attic"/
  )
})
