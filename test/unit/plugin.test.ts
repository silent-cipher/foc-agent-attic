import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

test('every CLI command has a Claude Code command and a line in the $attic skill', () => {
  const read = (path: string) => readFileSync(new URL(`../../plugins/attic/${path}`, import.meta.url), 'utf8')
  const skill = read('skills/attic/SKILL.md')
  for (const name of ['setup', 'backup', 'restore', 'sessions', 'refresh']) {
    assert.ok(read(`commands/${name}.md`).includes(`dist/attic.mjs" ${name}`), name)
    assert.ok(skill.includes(`dist/attic.mjs" ${name}`), name)
  }
})

test('both restore instructions search descriptions, require a choice and refresh missing sessions once', () => {
  for (const path of ['commands/restore.md', 'skills/attic/SKILL.md']) {
    const text = readFileSync(new URL(`../../plugins/attic/${path}`, import.meta.url), 'utf8')
    for (const requirement of [
      /sessions --json/,
      /description or no arguments/,
      /title, project and date/,
      /Never restore without the user choosing, unless an ID was given/,
      /refresh once/,
      /run.*sessions --json.*again/,
      /ID.*restore directly without asking/,
    ]) {
      assert.match(text, requirement, path)
    }
    assert.doesNotMatch(text, /ask for (?:a session ID|one) and stop|Ask for a session ID if restore/)
  }
  const command = readFileSync(new URL('../../plugins/attic/commands/restore.md', import.meta.url), 'utf8')
  assert.match(command, /AskUserQuestion/)
  assert.match(command, /allowed-tools:.*sessions:\*.*refresh.*AskUserQuestion/)
  const skill = readFileSync(new URL('../../plugins/attic/skills/attic/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /In Codex, ask a plain question/)
})
