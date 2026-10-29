import assert from 'node:assert/strict'
import { test } from 'node:test'
import pkg from '../../package.json' with { type: 'json' }
import claudeManifest from '../../plugins/attic/.claude-plugin/plugin.json' with { type: 'json' }
import manifest from '../../plugins/attic/plugin.json' with { type: 'json' }

test('plugin manifests carry the package version', () => {
  assert.equal(manifest.version, pkg.version)
  assert.equal(claudeManifest.version, pkg.version)
})
