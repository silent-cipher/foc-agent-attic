import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUnits } from 'viem'
import { fundingProblems } from '../../src/backup.ts'

const usdfc = (amount: string) => parseUnits(amount, 18)
const ready = { storageApproved: true, depositNeeded: 0n, availableFunds: usdfc('3') }

test('a funded, approved account has nothing in the way', () => {
  assert.deepEqual(fundingProblems(ready), [])
})

test('each missing step is named on its own line', () => {
  assert.deepEqual(fundingProblems({ ...ready, storageApproved: false }), ['✗ Storage service not approved'])
  assert.deepEqual(
    fundingProblems({ storageApproved: false, depositNeeded: usdfc('0.25'), availableFunds: usdfc('0.1') }),
    ['✗ Storage service not approved', '✗ 0.10 USDFC available, 0.25 short of this upload']
  )
})

test("enough for the upload's cost still needs the headroom setup asks for", () => {
  assert.deepEqual(fundingProblems({ ...ready, availableFunds: usdfc('0.5') }), [
    '✗ 0.50 USDFC available (keep at least 1)',
  ])
})
