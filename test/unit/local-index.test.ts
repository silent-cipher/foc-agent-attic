import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { AtticError } from '../../src/errors.ts'
import { type IndexEntry, indexEntry, isUpToDate, recordEntry } from '../../src/local-index.ts'
import type { Keyholder } from '../../src/login.ts'
import { tempHome } from '../e2e/helpers.ts'

const KEYHOLDER: Keyholder = {
  network: 'mainnet',
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  groupKey: '0x02ca08cf7e0222c8432adc159232b7eb',
}
const FILES = [{ path: 'projects/-tmp-app/s1.jsonl', size: 10, sha256: 'ab' }]
const ENTRY: IndexEntry = {
  v: 1,
  agent: 'claude-code',
  sessionId: 's1',
  project: '/tmp/app',
  machine: 'laptop',
  lastWriteAt: '2026-10-28T09:12:00.000Z',
  files: FILES,
  ...KEYHOLDER,
  pieceCid: 'bafk',
  size: 100,
  copies: [],
}

// The index lives under HOME.
async function home(): Promise<string> {
  const { root } = await tempHome()
  process.env.HOME = root
  return root
}

test('the same files under the same login are already backed up', () => {
  assert.equal(isUpToDate(ENTRY, KEYHOLDER, structuredClone(FILES)), true)
})

test('changed files are not', () => {
  assert.equal(isUpToDate(ENTRY, KEYHOLDER, [{ path: 'projects/-tmp-app/s1.jsonl', size: 11, sha256: 'cd' }]), false)
})

test('a backup this login cannot decrypt is not, even with the same files', () => {
  const others: Partial<Keyholder>[] = [
    { network: 'calibration' },
    { owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
    { groupKey: '0x0000000000000000000000000000000a' },
  ]
  for (const other of others)
    assert.equal(isUpToDate(ENTRY, { ...KEYHOLDER, ...other }, FILES), false, JSON.stringify(other))
})

test('an entry written before entries recorded their keyholder is not', () => {
  const { owner: _, groupKey: __, ...old } = ENTRY
  // Read back from JSON, as readIndex does: nothing checks old entries' shape.
  assert.equal(isUpToDate(JSON.parse(JSON.stringify(old)), KEYHOLDER, FILES), false)
})

test('recording a session keeps every other session and replaces its own older entry', async () => {
  await home()
  assert.equal(indexEntry('s1'), undefined)
  recordEntry(ENTRY)
  recordEntry({ ...ENTRY, sessionId: 's2', pieceCid: 'bafk2' })
  recordEntry({ ...ENTRY, pieceCid: 'bafk3' })
  assert.equal(indexEntry('s1')?.pieceCid, 'bafk3')
  assert.equal(indexEntry('s2')?.pieceCid, 'bafk2')
})

test('a file that is not an index, or not even JSON, is refused as a conflict, not replaced', async () => {
  const root = await home()
  mkdirSync(join(root, '.attic'))
  const conflict = (error: unknown) =>
    error instanceof AtticError && error.type === 'conflict' && /index\.json is not an Attic index/.test(error.message)
  for (const text of ['{"backups":[]}', '{"sessions": {"s1": {']) {
    writeFileSync(join(root, '.attic', 'index.json'), text)
    assert.throws(() => indexEntry('s1'), conflict, text)
    assert.throws(() => recordEntry(ENTRY), conflict, text)
  }
})
