import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { decrypt, encrypt } from '../../src/envelope.ts'
import { openGrant } from '../../src/grant.ts'
import { CALIBRATION, makeGrant, SESSION_KEY, STRANGER_KEY } from '../make-grant.ts'

const open = async (input: Parameters<typeof makeGrant>[0] = {}) =>
  openGrant(await makeGrant(input), SESSION_KEY, CALIBRATION)

test('a whole group key Grant encrypts and decrypts a multi-chunk envelope', async () => {
  const grant = await open()
  // Over FEE's 256 KiB chunk, so the chunked scheme writes more than one chunk.
  const plaintext = new Uint8Array(randomBytes(600 * 1024))
  const envelope = await encrypt(grant, plaintext)
  assert.notDeepEqual(envelope.subarray(-plaintext.length), plaintext)
  assert.deepEqual(await decrypt(grant, envelope), plaintext)
})

test('pieces land in the attic scope, so an attic-only Grant reads them', async () => {
  const plaintext = new TextEncoder().encode('session')
  const envelope = await encrypt(await open(), plaintext)
  assert.deepEqual(await decrypt(await open({ node: 'scope:attic' }), envelope), plaintext)
})

test("another owner's Grant cannot decrypt", async () => {
  const envelope = await encrypt(await open(), new TextEncoder().encode('session'))
  await assert.rejects(decrypt(await open({ ownerKey: STRANGER_KEY }), envelope), (error: Error) => {
    assert.match(String(error.cause), /the piece belongs to/)
    return true
  })
})
