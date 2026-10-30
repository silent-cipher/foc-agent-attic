import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeGrant, SESSION_KEY } from '../make-grant.ts'

const BUNDLE = fileURLToPath(new URL('../../plugins/attic/dist/attic.mjs', import.meta.url))

/** A temporary home folder with the agents' folders inside it. */
export type Home = { root: string; claude: string; codex: string }

/** Creates a temporary home folder, removed after the current test file. */
export async function tempHome(): Promise<Home> {
  const root = await mkdtemp(join(tmpdir(), 'attic-e2e-'))
  after(() => rm(root, { recursive: true, force: true }))
  return { root, claude: join(root, '.claude'), codex: join(root, '.codex') }
}

// A bare environment, as launchd and systemd give the daily job.
const bareEnv = (home: Home, env: Record<string, string>) => ({
  PATH: '/usr/bin:/bin',
  HOME: home.root,
  CLAUDE_CONFIG_DIR: home.claude,
  CODEX_HOME: home.codex,
  ...env,
})

/** Runs the bundle in `home` with a bare environment, plus `env`. */
export function runAttic(
  home: Home,
  args: readonly string[],
  env: Record<string, string> = {}
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf8', env: bareEnv(home, env) })
}

/**
 * Runs the bundle like `runAttic`, copying its output to the test log as it prints, so a slow upload shows
 * where it is. Killed after `timeout` ms, keeping what it printed.
 */
export async function runAtticLive(
  home: Home,
  args: readonly string[],
  env: Record<string, string>,
  timeout: number
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [BUNDLE, ...args], { env: bareEnv(home, env), timeout })
  const output = { stdout: '', stderr: '' }
  for (const name of ['stdout', 'stderr'] as const) {
    child[name].setEncoding('utf8').on('data', (text: string) => {
      output[name] += text
      process.stderr.write(text.replace(/^(?=.)/gm, `attic ${args[0]}> `))
    })
  }
  const [status] = await once(child, 'close')
  return { status: typeof status === 'number' ? status : null, ...output }
}

/** Logs `home` in on calibration as the console leaves a login, written directly: opening it needs no network. */
export async function logIn(home: Home): Promise<void> {
  mkdirSync(join(home.root, '.attic'), { recursive: true })
  const grant = await makeGrant()
  writeFileSync(
    join(home.root, '.attic', 'session.env'),
    `SESSION_KEY=${SESSION_KEY}\nNETWORK=calibration\nGRANT=${grant}\n`
  )
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
