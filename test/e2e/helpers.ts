import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../../plugins/attic/dist/attic.mjs', import.meta.url))

/** A temporary home folder with the agents' folders inside it. */
export type Home = { root: string; claude: string; codex: string }

/** Creates a temporary home folder, removed after the current test file. */
export async function tempHome(): Promise<Home> {
  const root = await mkdtemp(join(tmpdir(), 'attic-e2e-'))
  after(() => rm(root, { recursive: true, force: true }))
  return { root, claude: join(root, '.claude'), codex: join(root, '.codex') }
}

/** Runs the bundle in `home` with a bare environment, as launchd and systemd do. */
export function runAttic(home: Home, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: home.root, CLAUDE_CONFIG_DIR: home.claude, CODEX_HOME: home.codex },
  })
}
