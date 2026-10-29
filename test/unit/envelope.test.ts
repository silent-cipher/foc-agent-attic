import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { newSalt, pieceKey, pieceMetadata, writeTarget } from '@filoz/keysmith'
import * as fee from 'filecoin-encryption-envelope'
import { decrypt, encrypt } from '../../src/envelope.ts'
import { openGrant, SCOPE } from '../../src/grant.ts'
import { CALIBRATION, makeGrant, SESSION_KEY, STRANGER_KEY } from '../make-grant.ts'

const open = async (input: Parameters<typeof makeGrant>[0] = {}) =>
  openGrant(await makeGrant(input), SESSION_KEY, CALIBRATION)

test('a whole group key Grant encrypts and decrypts a multi-chunk envelope', async () => {
  const grant = await open()
  // Over FEE's 256 KiB chunk, so the chunked scheme writes more than one chunk.
  const plaintext = new Uint8Array(randomBytes(600 * 1024))
  const envelope = await encrypt(grant, plaintext)
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

test('an envelope of another content type is refused', async () => {
  const grant = await open()
  const target = writeTarget(grant.grant, grant.key, SCOPE)
  const salt = newSalt()
  const plaintext = new TextEncoder().encode('photo')
  const other = await new Response(
    ReadableStream.from([plaintext]).pipeThrough(
      fee.encrypt({
        cek: pieceKey(target.key, salt),
        contentLength: plaintext.length,
        contentType: 'image/png',
        appMetadata: pieceMetadata(target.ref, { salt, scope: SCOPE }),
      })
    )
  ).bytes()
  await assert.rejects(decrypt(grant, other), (error: Error) => {
    assert.match(String(error.cause), /it is image\/png, not an Attic session/)
    return true
  })
})
