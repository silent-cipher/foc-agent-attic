import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import pkg from '../../package.json' with { type: 'json' }
import { homeEnv, tempHome } from './helpers.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('the npm package installs an attic command that runs with no dependencies', async () => {
  const home = await tempHome()
  const npm = (args: string[]) =>
    execFileSync('npm', [...args, '--cache', join(home.root, 'npm-cache')], { cwd: ROOT, encoding: 'utf8' })
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', home.root]))
  // Offline with an empty cache, so any runtime dependency fails the install.
  npm(['install', '--global', '--offline', '--prefix', join(home.root, 'npm'), join(home.root, packed.filename)])

  const version = execFileSync(join(home.root, 'npm', 'bin', 'attic'), ['--version'], {
    encoding: 'utf8',
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...homeEnv(home) },
  })
  assert.equal(version, `${pkg.version}\n`)
})
