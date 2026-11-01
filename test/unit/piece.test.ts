import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { newSalt, pieceKey, pieceMetadata, writeTarget } from '@filoz/keysmith'
import * as fee from 'filecoin-encryption-envelope'
import { openGrant, SCOPE } from '../../src/grant.ts'
import { CONTENT_TYPE, fileEntries, type Header, openPiece, sealPiece } from '../../src/piece.ts'
import { CALIBRATION, makeGrant, SESSION_KEY, STRANGER_KEY } from '../make-grant.ts'

const FIELDS: Omit<Header, 'v' | 'files'> = {
  agent: 'claude-code',
  sessionId: 'f6c998dd-bca7-4fcc-9e4c-d0fb49ced1b4',
  project: '/Users/me/work/app',
  machine: 'laptop',
  lastWriteAt: '2026-10-28T09:12:00.000Z',
}
const FILES = [
  { path: 'projects/-Users-me-work-app/f6c998dd.jsonl', bytes: new TextEncoder().encode('{"cwd":"/Users/me"}\n') },
  { path: 'projects/-Users-me-work-app/f6c998dd/subagents/a1.jsonl', bytes: new Uint8Array([0, 1, 2]) },
  { path: 'projects/-Users-me-work-app/f6c998dd/empty.txt', bytes: new Uint8Array() },
]

const grantFor = async (input: Parameters<typeof makeGrant>[0] = {}) =>
  openGrant(await makeGrant(input), SESSION_KEY, CALIBRATION)

const asBytes = (files: { path: string; bytes: Uint8Array }[]) =>
  files.map((file) => ({ path: file.path, bytes: [...file.bytes] }))

// An envelope around any plaintext, the way `sealPiece` encrypts, to reach `openPiece`'s checks.
async function encryptRaw(plaintext: Uint8Array, contentType = CONTENT_TYPE): Promise<Uint8Array> {
  const grant = await grantFor()
  const target = writeTarget(grant.grant, grant.key, SCOPE)
  const salt = newSalt()
  const encrypt = fee.encrypt({
    cek: pieceKey(target.key, salt),
    contentLength: plaintext.length,
    contentType,
    appMetadata: pieceMetadata(target.ref, { salt, scope: SCOPE }),
  })
  return new Response(ReadableStream.from([plaintext]).pipeThrough(encrypt)).bytes()
}

// A piece's plaintext: a 4-byte big-endian header length, the header as JSON, then the files' bytes.
function plaintext(header: unknown, ...files: Uint8Array[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, json.length)
  return Buffer.concat([length, json, ...files])
}

test('a sealed session opens to the same header and files', async () => {
  const grant = await grantFor()
  const { header, envelope } = await sealPiece(grant, FIELDS, FILES)
  assert.deepEqual(header.files[1], {
    path: FILES[1]?.path,
    size: 3,
    sha256: 'ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc',
  })
  const opened = await openPiece(grant, envelope)
  assert.deepEqual(opened.header, header)
  assert.deepEqual(asBytes(opened.files), asBytes(FILES))
})

test('a session over one FEE chunk seals and opens', async () => {
  const grant = await grantFor()
  // Over FEE's 256 KiB chunk, so the chunked scheme writes more than one chunk.
  const files = [{ path: 'projects/big.jsonl', bytes: new Uint8Array(randomBytes(600 * 1024)) }]
  const { envelope } = await sealPiece(grant, FIELDS, files)
  assert.deepEqual(asBytes((await openPiece(grant, envelope)).files), asBytes(files))
})

test('pieces land in the attic scope, so an attic-only Grant opens them', async () => {
  const { envelope } = await sealPiece(await grantFor(), FIELDS, FILES)
  const opened = await openPiece(await grantFor({ node: 'scope:attic' }), envelope)
  assert.equal(opened.header.sessionId, FIELDS.sessionId)
})

test("another owner's Grant cannot open a piece", async () => {
  const { envelope } = await sealPiece(await grantFor(), FIELDS, FILES)
  await assert.rejects(
    openPiece(await grantFor({ ownerKey: STRANGER_KEY }), envelope),
    /^Error: The backup does not decrypt: .*the piece belongs to/
  )
})

test('an envelope of another content type is refused', async () => {
  await assert.rejects(
    openPiece(await grantFor(), await encryptRaw(new TextEncoder().encode('photo'), 'image/png')),
    /does not decrypt: it is image\/png, not an Attic session/
  )
})

test('a changed byte fails its SHA-256 check', async () => {
  const { header } = await sealPiece(await grantFor(), FIELDS, FILES)
  const damaged = plaintext(header, ...FILES.map((file) => file.bytes))
  damaged[damaged.length - 1] = 9
  await assert.rejects(openPiece(await grantFor(), await encryptRaw(damaged)), /a1\.jsonl does not match its SHA-256/)
})

test('a cut-short or padded piece is damaged', async () => {
  const grant = await grantFor()
  const { header } = await sealPiece(grant, FIELDS, FILES)
  const whole = plaintext(header, ...FILES.map((file) => file.bytes))
  await assert.rejects(openPiece(grant, await encryptRaw(whole.subarray(0, 10))), /header is cut short/)
  await assert.rejects(
    openPiece(grant, await encryptRaw(whole.subarray(0, whole.length - 1))),
    /does not match its SHA-256/
  )
  await assert.rejects(
    openPiece(grant, await encryptRaw(Buffer.concat([whole, new Uint8Array([0])]))),
    /bytes after its last file/
  )
})

test('a header from a newer format asks for an Attic update', async () => {
  await assert.rejects(
    openPiece(await grantFor(), await encryptRaw(plaintext({ ...FIELDS, v: 2, files: [] }))),
    /format 2, newer than this Attic. Update Attic/
  )
})

test('a header without the session fields is refused', async () => {
  await assert.rejects(
    openPiece(await grantFor(), await encryptRaw(plaintext({ ...FIELDS, v: 1, sessionId: 7, files: [] }))),
    /not an Attic session header/
  )
  await assert.rejects(
    openPiece(await grantFor(), await encryptRaw(plaintext({ ...FIELDS, v: 1, title: 7, files: [] }))),
    /not an Attic session header/
  )
})

test('a header carries what the session is about, within format 1', async () => {
  const grant = await grantFor()
  const about = { title: 'Speed up the index', firstPrompt: 'Fix the slow index', branch: 'feat/index' }
  const { envelope } = await sealPiece(grant, { ...FIELDS, ...about }, FILES)
  assert.deepEqual((await openPiece(grant, envelope)).header, { v: 1, ...FIELDS, ...about, files: fileEntries(FILES) })
})
