import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Header, pack, unpack } from '../../src/piece.ts'

const FIELDS: Omit<Header, 'files'> = {
  v: 1,
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

test('a packed session unpacks to the same header and files', () => {
  const { header, bytes } = pack(FIELDS, FILES)
  assert.deepEqual(header.files[1], {
    path: FILES[1]?.path,
    size: 3,
    sha256: 'ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc',
  })
  const unpacked = unpack(bytes)
  assert.deepEqual(unpacked.header, header)
  assert.deepEqual(
    unpacked.files.map((file) => ({ path: file.path, bytes: [...file.bytes] })),
    FILES.map((file) => ({ path: file.path, bytes: [...file.bytes] }))
  )
})

test('a changed byte fails its SHA-256 check', () => {
  const { bytes } = pack(FIELDS, FILES)
  const damaged = bytes.slice()
  damaged[damaged.length - 1] = 9
  assert.throws(() => unpack(damaged), /damaged: .*a1\.jsonl does not match its SHA-256/)
})

test('a cut-short or padded piece is damaged', () => {
  const { bytes } = pack(FIELDS, FILES)
  assert.throws(() => unpack(bytes.subarray(0, 10)), /header is cut short/)
  assert.throws(() => unpack(bytes.subarray(0, bytes.length - 1)), /does not match its SHA-256/)
  assert.throws(() => unpack(Buffer.concat([bytes, new Uint8Array([0])])), /bytes after its last file/)
})

test('a header from a newer format asks for an Attic update', () => {
  const { bytes } = pack({ ...FIELDS, v: 2 } as unknown as Omit<Header, 'files'>, FILES)
  assert.throws(() => unpack(bytes), /format 2, newer than this Attic. Update Attic/)
})

test('a header without the session fields is refused', () => {
  const { bytes } = pack({ ...FIELDS, sessionId: 7 } as unknown as Omit<Header, 'files'>, FILES)
  assert.throws(() => unpack(bytes), /not an Attic session header/)
})
