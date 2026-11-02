import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { type Home, logIn, tempHome, writeClaudeSession } from '../e2e/helpers.ts'
import { memoryStorage } from '../memory-storage.ts'

const ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'
const storage = memoryStorage()

mock.module('../../src/storage.ts', { namedExports: { synapseStorage: storage.connect } })
const { run } = await import('../../src/cli.ts')

// The CLI reads its login, index and agent homes from the environment, so switching it switches machines.
async function machine(): Promise<Home> {
  const home = await tempHome()
  await logIn(home)
  Object.assign(process.env, {
    HOME: home.root,
    CLAUDE_CONFIG_DIR: home.claude,
    CODEX_HOME: home.codex,
    ATTIC_NETWORK: 'calibration',
  })
  return home
}

/** Runs the CLI with --json and returns its exit code, the one JSON value on stdout, and stderr. */
async function json(args: string[]): Promise<{ code: number; result: Record<string, unknown>; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await run(
    [...args, '--json'],
    (text) => {
      stdout += text
    },
    (text) => {
      stderr += text
    }
  )
  assert.equal(stdout.split('\n').length, 2, stdout)
  return { code, result: JSON.parse(stdout), stderr }
}

test('a backup run whose sessions failed prints its counts as a retryable JSON error', async () => {
  const home = await machine()
  writeClaudeSession(home, ID)
  storage.state.storeError = new Error('commit timed out')
  try {
    const { code, result, stderr } = await json(['backup', ID])
    assert.equal(code, 1)
    assert.deepEqual(result, {
      error: 'failed',
      message: `✗ Session ${ID}: commit timed out`,
      retryable: true,
      backedUp: 0,
      skipped: 0,
      failed: 1,
    })
    assert.match(stderr, /Checking session key authorization/)
  } finally {
    storage.state.storeError = undefined
  }
})

test('backup, setup, refresh and restore each print one JSON result', async () => {
  const old = await machine()
  writeClaudeSession(old, ID)
  const backedUp = await json(['backup', ID])
  assert.deepEqual([backedUp.code, backedUp.result], [0, { backedUp: 1, skipped: 0, failed: 0 }])

  // A new machine: setup builds its index from the chain, and a later refresh finds nothing more.
  await machine()
  const setup = await json(['setup'])
  assert.equal(setup.code, 0)
  const { approveUrl, expiresAt, ...checks } = setup.result
  assert.match(String(approveUrl), /\/console\/setup\?authorize=0x/)
  assert.match(String(expiresAt), /^\d{4}-\d\d-\d\dT/)
  assert.deepEqual(checks, {
    authorized: true,
    storageApproved: true,
    funded: true,
    refresh: { added: 1, updated: 0, sessions: 1, skippedPieces: [] },
  })
  assert.deepEqual((await json(['refresh'])).result, { added: 0, updated: 0, sessions: 1, skippedPieces: [] })

  const restored = await json(['restore', ID])
  assert.equal(restored.code, 0)
  assert.deepEqual(restored.result, {
    sessionId: ID,
    agent: 'claude-code',
    written: 2,
    files: 2,
    resumeCommand: `claude --resume ${ID}`,
  })
  assert.match(restored.stderr, /✓ Restored session/)
})
