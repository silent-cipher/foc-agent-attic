import assert from 'node:assert/strict'
import { test } from 'node:test'
import pkg from '../../package.json' with { type: 'json' }
import { runAttic, tempHome } from './helpers.ts'

test('the bundle prints its version in a bare environment', async () => {
  const result = runAttic(await tempHome(), ['--version'])
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `${pkg.version}\n`)
})
