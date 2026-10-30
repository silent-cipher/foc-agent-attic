import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import { isHex, parseUnits } from 'viem'
import { type Readiness, reportReadiness, type SetupOptions, setup } from '../../src/setup.ts'
import { type Home, logIn, tempHome } from '../e2e/helpers.ts'
import { makeGrant, STRANGER_KEY } from '../make-grant.ts'
import { memoryStorage } from '../memory-storage.ts'

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
  assert.ok(!text.includes(ready.fundingUrl), text)
})

test('an authorized key still prints the approve link, so it can be renewed before it expires', () => {
  const { text } = report({})
  assert.match(text, /To renew it before then, approve it again in the console and run setup with the new Grant:/)
  assert.ok(text.split('\n').includes(ready.approveUrl), text)
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

// Attic keeps its login under HOME.
async function home(): Promise<Home> {
  const home = await tempHome()
  process.env.HOME = home.root
  return home
}

const saved = (home: Home) => parseEnv(readFileSync(join(home.root, '.attic', 'session.env'), 'utf8'))

async function runSetup(grant?: string): Promise<{ code: number; text: string }> {
  const options: SetupOptions = { network: 'calibration', consoleUrl: 'https://pay.filecoin.cloud' }
  const lines: string[] = []
  const code = await setup(
    grant === undefined ? options : { ...options, grant },
    (line) => lines.push(line),
    memoryStorage().connect
  )
  return { code, text: lines.join('\n') }
}

test('setup saves a pasted Grant and reports a ready account', async () => {
  const root = await home()
  assert.equal((await runSetup()).code, 2)
  const sessionKey = saved(root).SESSION_KEY
  assert.ok(sessionKey !== undefined && isHex(sessionKey))

  const { code, text } = await runSetup(await makeGrant({ sessionKey }))
  assert.equal(code, 0, text)
  assert.match(text, /✓ Grant saved for group key 0x/)
  assert.match(text, /✓ Session key authorized\n✓ Storage service approved\n✓ 5\.00 USDFC available/)
  assert.ok(saved(root).GRANT?.startsWith('fgr1_'))
  assert.equal((await runSetup()).code, 0)
})

test('a saved Grant that no longer opens says why and prints the approve link', async () => {
  const root = await home()
  await logIn(root, await makeGrant({ sessionKey: STRANGER_KEY }))

  const result = await runSetup()
  assert.equal(result.code, 2)
  assert.match(result.text, /✗ The saved Grant no longer opens\. /)
  assert.match(result.text, /Approve this session key in the Filecoin Cloud console, then copy the Grant/)
})
