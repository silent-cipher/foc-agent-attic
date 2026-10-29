import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

/** Runs the bundle in `home` with a bare environment, as launchd and systemd do, plus `env`. */
export function runAttic(
  home: Home,
  args: readonly string[],
  env: Record<string, string> = {}
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: home.root, CLAUDE_CONFIG_DIR: home.claude, CODEX_HOME: home.codex, ...env },
  })
}

/** Writes a Claude Code session, one message and one subagent, and returns its paths under `home.claude`. */
export function writeClaudeSession(home: Home, id: string): string[] {
  const project = join('projects', '-tmp-attic-e2e')
  // The fields Claude Code needs to list a transcript as a resumable conversation.
  const message = {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: 'hello' },
    uuid: '8e1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a81',
    timestamp: '2026-10-28T09:12:00.000Z',
    sessionId: id,
    cwd: '/tmp/attic-e2e',
    userType: 'external',
    version: '2.1.312',
  }
  const files = {
    [join(project, `${id}.jsonl`)]: `${JSON.stringify(message)}\n`,
    [join(project, id, 'subagents', 'agent-a1.jsonl')]: '{"type":"assistant"}\n',
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home.claude, path)), { recursive: true })
    writeFileSync(join(home.claude, path), text)
  }
  return Object.keys(files)
}
