import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import { type Hex, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { makeGrant } from '../make-grant.ts'
import { type Home, runAttic, tempHome } from './helpers.ts'

const sessionFile = (home: Home) => join(home.root, '.attic', 'session.env')
const CALIBRATION = { ATTIC_NETWORK: 'calibration' }

function savedSession(home: Home): Record<string, string | undefined> {
  return parseEnv(readFileSync(sessionFile(home), 'utf8'))
}

function savedKey(home: Home): Hex {
  const key = savedSession(home).SESSION_KEY
  if (key === undefined || !isHex(key)) throw new Error(`No session key in ${sessionFile(home)}`)
  return key
}

test('setup saves a new session key, owner-readable only, and prints the console link', async () => {
  const home = await tempHome()
  const result = runAttic(home, ['setup'])
  assert.equal(result.stderr, '')
  assert.equal(result.status, 2)
  assert.equal(statSync(sessionFile(home)).mode & 0o777, 0o600)
  assert.equal(statSync(join(home.root, '.attic')).mode & 0o777, 0o700)

  assert.equal(savedSession(home).NETWORK, 'mainnet')
  const address = privateKeyToAccount(savedKey(home)).address
  assert.ok(result.stdout.includes(`The console must show session address ${address}.`), result.stdout)
  const link = result.stdout.split('\n').find((line) => line.startsWith('https://'))
  assert.ok(link !== undefined, result.stdout)
  const url = new URL(link)
  assert.equal(url.origin + url.pathname, 'https://pay.filecoin.cloud/console/setup')
  assert.equal(url.searchParams.get('authorize'), address.toLowerCase())
  assert.equal(url.searchParams.get('scopes'), 'createDataSet,addPieces,schedulePieceRemovals')
  assert.equal(url.searchParams.get('network'), 'mainnet')
  assert.equal(url.searchParams.get('node'), 'keyspace')
  assert.match(url.searchParams.get('pubkey') ?? '', /^0x04[0-9a-f]{128}$/)
  assert.match(url.searchParams.get('pubkeysig') ?? '', /^0x[0-9a-f]{130}$/)
})

test('setup again resumes the saved key', async () => {
  const home = await tempHome()
  runAttic(home, ['setup'], CALIBRATION)
  const key = savedKey(home)
  const again = runAttic(home, ['setup'], CALIBRATION)
  assert.equal(again.status, 2)
  assert.equal(savedKey(home), key)
  assert.match(again.stdout, /on calibration/)
  assert.doesNotMatch(again.stdout, /New session key/)
})

test('setup refuses a calibration test key once ATTIC_NETWORK is unset', async () => {
  const home = await tempHome()
  runAttic(home, ['setup'], CALIBRATION)
  const result = runAttic(home, ['setup'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^Error: The saved session key is for calibration, not mainnet/)
})

test('setup refuses a bad Grant and saves nothing', async () => {
  const home = await tempHome()
  runAttic(home, ['setup'], CALIBRATION)
  const sessionKey = savedKey(home)
  const cases = [
    ['fak1_abc', /This is not a Grant/],
    [await makeGrant(), /another bearer/],
    [await makeGrant({ sessionKey, chainId: 314 }), /chain id 314, not 314159/],
  ] as const
  for (const [grant, reason] of cases) {
    const result = runAttic(home, ['setup', '--grant', grant], CALIBRATION)
    assert.equal(result.status, 1)
    assert.match(result.stderr, reason)
    assert.equal(savedSession(home).GRANT, undefined)
  }
})

test('ATTIC_CONSOLE_URL points the console links at another console, for testing', async () => {
  const home = await tempHome()
  const result = runAttic(home, ['setup'], { ATTIC_CONSOLE_URL: 'http://localhost:3000/' })
  assert.equal(result.status, 2)
  assert.match(result.stdout, /\nhttp:\/\/localhost:3000\/console\/setup\?authorize=0x/)
  const bad = runAttic(home, ['setup'], { ATTIC_CONSOLE_URL: 'localhost:3000' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /ATTIC_CONSOLE_URL must be an http\(s\) URL/)
})

test('setup has no network option, and ATTIC_NETWORK takes only calibration', async () => {
  const home = await tempHome()
  const flag = runAttic(home, ['setup', '--network', 'calibration'])
  assert.equal(flag.status, 1)
  assert.match(flag.stderr, /Unknown option '--network'/)
  const env = runAttic(home, ['setup'], { ATTIC_NETWORK: 'devnet' })
  assert.equal(env.status, 1)
  assert.match(env.stderr, /ATTIC_NETWORK can only be calibration/)
})
