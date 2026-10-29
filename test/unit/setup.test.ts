import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUnits } from 'viem'
import { type Readiness, reportReadiness } from '../../src/setup.ts'

const NOW = 1_800_000_000
const DAY = 86_400

const ready: Readiness = {
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  authorizedUntil: NOW + 30 * DAY,
  grantExpires: NOW + 10 * DAY,
  storageApproved: true,
  availableFunds: parseUnits('3.456', 18),
  approveUrl: 'https://pay.filecoin.cloud/console/setup?authorize=0xabc',
  fundingUrl: 'https://pay.filecoin.cloud/console?deposit=2&operator=fwss&network=calibration',
}

function report(changes: Partial<Readiness>): { code: number; text: string } {
  const lines: string[] = []
  const code = reportReadiness({ ...ready, ...changes }, (line) => lines.push(line), NOW)
  return { code, text: lines.join('\n') }
}

test('a ready account exits 0 and names the earlier of the two expiries', () => {
  const { code, text } = report({})
  assert.equal(code, 0)
  assert.match(text, /✓ Session key authorized/)
  assert.match(text, /✓ Storage service approved/)
  assert.match(text, /✓ 3\.46 USDFC available/)
  assert.match(text, /Session key expires 2027-01-25 \(in 10 days\)/)
  assert.doesNotMatch(text, /pay\.filecoin\.cloud/)
})

test('an unauthorized key prints the approve link', () => {
  const { code, text } = report({ authorizedUntil: 0 })
  assert.equal(code, 2)
  assert.match(text, /✗ Session key not authorized by 0xf39F/)
  assert.match(text, /\nhttps:\/\/pay\.filecoin\.cloud\/console\/setup\?authorize=0xabc/)
})

test('an expired authorization counts as unauthorized', () => {
  assert.equal(report({ authorizedUntil: NOW - 1 }).code, 2)
})

test('low funds or no storage approval print the pre-filled funding link', () => {
  for (const changes of [{ availableFunds: parseUnits('0.99', 18) }, { storageApproved: false }]) {
    const { code, text } = report(changes)
    assert.equal(code, 2)
    assert.ok(text.includes(ready.fundingUrl), text)
  }
  assert.match(report({ availableFunds: 0n }).text, /✗ 0\.00 USDFC available \(keep at least 1\)/)
})
