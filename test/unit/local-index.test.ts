import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type IndexEntry, isUpToDate } from '../../src/local-index.ts'
import type { Keyholder } from '../../src/login.ts'

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
