import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../../src/cli.ts'

test('anything else prints usage and fails', async () => {
  for (const args of [[], ['nope'], ['--version', 'extra']]) {
    let stdout = ''
    const result = await run(args, (text) => {
      stdout += text
    })
    assert.equal(result.code, 1)
    assert.equal(stdout, '')
    assert.match(result.stderr, /^Usage: attic/)
  }
})

test('backup and restore take exactly one session ID that cannot leave the projects folder', async () => {
  for (const command of ['backup', 'restore']) {
    for (const [args, reason] of [
      [[], /Give one session ID/],
      [['a', 'b'], /Give one session ID/],
      [['../a'], /\.\.\/a is not a session ID/],
      [['a/b'], /a\/b is not a session ID/],
    ] as const) {
      const result = await run([command, ...args], () => undefined)
      assert.equal(result.code, 1)
      assert.match(result.stderr, reason)
    }
  }
})

test('sessions takes no arguments', async () => {
  const result = await run(['sessions', 'extra'], () => undefined)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Unexpected argument 'extra'/)
})
