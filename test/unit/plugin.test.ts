import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import codexMarketplace from '../../.agents/plugins/marketplace.json' with { type: 'json' }
import claudeMarketplace from '../../.claude-plugin/marketplace.json' with { type: 'json' }
import pkg from '../../package.json' with { type: 'json' }
import claudeManifest from '../../plugins/attic/.claude-plugin/plugin.json' with { type: 'json' }
import manifest from '../../plugins/attic/plugin.json' with { type: 'json' }

test('plugin manifests carry the package version', () => {
  assert.equal(manifest.version, pkg.version)
  assert.equal(claudeManifest.version, pkg.version)
})

test('both agents discover the same plugin and its manifests agree', () => {
  const { $schema, extensions, ...shared } = manifest
  assert.deepEqual(claudeManifest, shared)
  const [codex] = codexMarketplace.plugins
  const [claude] = claudeMarketplace.plugins
  assert.equal(codex?.name, manifest.name)
  assert.equal(claude?.name, manifest.name)
  assert.equal(codex?.source.path, claude?.source)
  assert.ok(existsSync(new URL(`../../${codex?.source.path}/plugin.json`, import.meta.url)))
  assert.ok(existsSync(new URL('../../plugins/attic/skills/attic/SKILL.md', import.meta.url)))
})
