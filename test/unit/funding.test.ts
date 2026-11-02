import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUnits } from 'viem'
import { checkFunding } from '../../src/funding.ts'

const usdfc = (amount: string) => parseUnits(amount, 18)
const ready = { storageApproved: true, depositNeeded: 0n, availableFunds: usdfc('3.456') }

test('a funded, approved account is ready, and says so line by line', () => {
  assert.deepEqual(checkFunding(ready), {
    ready: true,
    funded: true,
    lines: ['✓ Storage service approved', '✓ 3.46 USDFC available'],
  })
})

test('each missing step is named on its own line', () => {
  assert.deepEqual(checkFunding({ ...ready, storageApproved: false }), {
    ready: false,
    funded: true,
    lines: ['✗ Storage service not approved', '✓ 3.46 USDFC available'],
  })
  assert.deepEqual(
    checkFunding({ storageApproved: false, depositNeeded: usdfc('0.25'), availableFunds: usdfc('0.1') }).lines,
    ['✗ Storage service not approved', '✗ 0.10 USDFC available, 0.25 short of this upload']
  )
})

test("enough for the upload's cost still needs the headroom for the next one", () => {
  assert.deepEqual(checkFunding({ ...ready, availableFunds: usdfc('0.5') }), {
    ready: false,
    funded: false,
    lines: ['✓ Storage service approved', '✗ 0.50 USDFC available (keep at least 1)'],
  })
  assert.equal(checkFunding({ ...ready, availableFunds: usdfc('1') }).ready, true)
})
