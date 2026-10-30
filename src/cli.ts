import { parseArgs } from 'node:util'
import { BaseError } from 'viem'
import pkg from '../package.json' with { type: 'json' }
import { type BackupOptions, backup } from './backup.ts'
import { claudeHome } from './claude-code.ts'
import { restore } from './restore.ts'
import { setup } from './setup.ts'
import { synapseStorage } from './storage.ts'

/** How one CLI run ended. Its output went to `write` as it was printed, so a long upload shows where it is. */
export type Result = { code: number; stderr: string }

const USAGE =
  'Usage: attic --version | attic setup [--grant <fgr1_…>] | attic backup <session id> | attic restore <session id>\n'

/** Runs the Attic CLI with `args`, the arguments after the script path, writing its output to `write`. */
export async function run(args: readonly string[], write: (text: string) => void): Promise<Result> {
  if (args.length === 1 && args[0] === '--version') {
    write(`${pkg.version}\n`)
    return { code: 0, stderr: '' }
  }
  const [name, ...rest] = args
  if (name !== 'setup' && name !== 'backup' && name !== 'restore') return { code: 1, stderr: USAGE }
  const print = (line: string) => write(`${line}\n`)
  try {
    const options = envOptions(process.env)
    const code =
      name === 'setup'
        ? await setup({ ...options, ...grantOption(rest) }, print)
        : await (name === 'backup' ? backup : restore)(options, sessionId(rest), print, synapseStorage)
    return { code, stderr: '' }
  } catch (error) {
    return { code: 1, stderr: `Error: ${errorMessage(error)}\n` }
  }
}

// ATTIC_NETWORK and ATTIC_CONSOLE_URL are test switches, never user options: calibration guarantees no
// storage, and a staging or local console is only for trying console changes before they ship.
function envOptions(env: NodeJS.ProcessEnv): BackupOptions {
  const { ATTIC_NETWORK: network, ATTIC_CONSOLE_URL: consoleUrl } = env
  if (network !== undefined && network !== 'calibration') {
    throw new Error(`ATTIC_NETWORK can only be calibration, for testing, not ${network}`)
  }
  return {
    network: network ?? 'mainnet',
    consoleUrl: consoleUrl === undefined ? 'https://pay.filecoin.cloud' : consoleOrigin(consoleUrl),
    claudeHome: claudeHome(env),
  }
}

function grantOption(args: string[]): { grant?: string } {
  const { grant } = parseArgs({ args, options: { grant: { type: 'string' } } }).values
  return grant === undefined ? {} : { grant }
}

// The ID becomes a file name, so nothing that could leave the projects folder gets through.
function sessionId(args: string[]): string {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const [id] = positionals
  if (positionals.length !== 1 || id === undefined) throw new Error(`Give one session ID.\n${USAGE.trimEnd()}`)
  if (!/^[\w-]+$/.test(id)) throw new Error(`${id} is not a session ID.`)
  return id
}

function consoleOrigin(value: string): string {
  const url = URL.parse(value)
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error(`ATTIC_CONSOLE_URL must be an http(s) URL, not ${value}`)
  }
  return url.origin
}

// viem's full message adds request arguments, a docs link and its version over several lines.
function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage
  return error instanceof Error ? error.message : String(error)
}
