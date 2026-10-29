import assert from 'node:assert/strict'
import { test } from 'node:test'
import pkg from '../../package.json' with { type: 'json' }
import { run } from '../../src/cli.ts'

test('--version prints the package version', () => {
  assert.deepEqual(run(['--version']), { code: 0, stdout: `${pkg.version}\n`, stderr: '' })
})

test('anything else prints usage and fails', () => {
  for (const args of [[], ['nope'], ['--version', 'extra']]) {
    const result = run(args)
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^Usage: attic/)
  }
})
