import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../../src/cli.ts'

test('anything else prints usage and fails', async () => {
  for (const args of [[], ['nope'], ['--version', 'extra']]) {
    const result = await run(args)
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^Usage: attic/)
  }
})
