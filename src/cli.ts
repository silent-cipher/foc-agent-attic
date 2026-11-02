import { parseArgs } from 'node:util'
import { BaseError } from 'viem'
import pkg from '../package.json' with { type: 'json' }
import { type BackupOptions, backup } from './backup.ts'
import { claudeCode, claudeHome } from './claude-code.ts'
import { codex, codexHome } from './codex.ts'
import { AtticError, type FixFirst } from './errors.ts'
import { indexEntries, refreshIndex } from './local-index.ts'
import { openLogin } from './login.ts'
import { restore } from './restore.ts'
import { matchingSessions, sessions } from './sessions.ts'
import { setup } from './setup.ts'
import { synapseStorage } from './storage.ts'

type Write = (text: string) => void

/** Exit code for a command whose arguments or ATTIC_* switches are wrong, from sysexits' EX_USAGE. */
const USAGE_ERROR = 64

const EXIT_CODES = `Exit codes:
  0   Done.
  1   Failed. With --json, stdout holds {"error", "message", "retryable"}; a backup run adds its counts. error is
      setup (run attic setup), not_found (refresh the index, or check the ID), update (update Attic), conflict
      (local files or the login don't match the backup, so a person has to move, fix or switch them), or failed.
      Only failed can go away on a retry; every command is safe to retry.
  2   The owner has to act first: paste a Grant, approve the session key, or deposit USDFC in the console.
  64  Usage error: fix the command. With --json, error is usage.
`

const EXAMPLE_ID = '5d1c3e0a-7b2f-4c8e-9a61-0f3b2d4e6a80'

const COMMANDS = {
  setup: {
    summary: 'Log in through the Filecoin Cloud console and check Attic can back up',
    help: `Usage: attic setup [--grant <fgr1_…>] [--json]

Logs this machine in through the Filecoin Cloud console and checks Attic can back up. Without a saved Grant, it
prints a console link: the owner approves the session key there and the console shows a Grant. Run setup again with
it. On a machine without an index, setup also builds it from the backups on chain. Safe to repeat.

Options:
  --grant <fgr1_…>  Optional. The Grant the console showed.
  --json            Print one JSON result on stdout, and progress on stderr: {"needs": "grant", "sessionAddress",
                    "approveUrl"} while no Grant is saved, else the checks {"needs", "authorized",
                    "storageApproved", "funded", "expiresAt", "approveUrl", "fundingUrl", "refresh"}. needs is
                    approval or deposit until every check passes, expiresAt is set once authorized, fundingUrl
                    until funded and approved, and refresh when setup built the index.

Example:
  attic setup --grant fgr1_…
`,
  },
  backup: {
    summary: 'Back up every idle session, or one session now',
    help: `Usage: attic backup [<session id> | --current] [--json]

With no arguments, refreshes the index, then backs up every Claude Code and Codex session idle for 24 hours that
the index lacks or holds with other files. With a session ID, backs up that session now, even while it is active.
One backup runs per machine at a time; another exits 0 without backing anything up.

Arguments:
  <session id>  Optional. The session to back up now.

Options:
  --current  Back up the session Attic runs in, from CLAUDE_SESSION_ID or CODEX_THREAD_ID. Not with an ID.
  --json     Print one JSON result on stdout, and progress on stderr: {"backedUp", "skipped", "failed"}, with
             "locked": true when another backup held the lock, "needs": "setup" when the session key isn't
             authorized, "needs": "deposit" and "fundingUrl" when USDFC is short, or, when a session or the
             removal of old pieces failed, "error": "failed", "retryable": true and the ✗ lines as "message".

Example:
  attic backup ${EXAMPLE_ID} --json
`,
  },
  restore: {
    summary: 'Restore a backed-up session',
    help: `Usage: attic restore <session id> [--json]

Downloads the session's newest backup in the index, checks every file's SHA-256, and writes the missing files into
its agent's home. Writes nothing if a local file differs from the backup.

Arguments:
  <session id>  Required. A session ID from attic sessions.

Options:
  --json  Print one JSON result on stdout, and progress on stderr:
          {"sessionId", "agent", "written", "files", "resumeCommand"}.

Example:
  attic restore ${EXAMPLE_ID} --json
`,
  },
  sessions: {
    summary: 'List the backed-up sessions, offline',
    help: `Usage: attic sessions [--json] [<word>…]

Lists the sessions in this machine's index, newest first, and how the last backup run ended. Reads only local
files, so it needs no login or network.

Arguments:
  <word>…  Optional. List only the sessions whose title, first prompt, project or branch contain every word,
           ignoring case.

Options:
  --json  Print only the matching sessions on stdout, as a JSON array of
          {"sessionId", "agent", "title", "firstPrompt", "project", "branch", "lastWriteAt"}, with title,
          firstPrompt and branch only when recorded.

Example:
  attic sessions --json funding
`,
  },
  refresh: {
    summary: 'Add the sessions other machines backed up to the index',
    help: `Usage: attic refresh [--json]

Adds the sessions other machines backed up to this machine's index. Reads the chain and never uploads. A piece
whose header can't be read now is skipped, and the next refresh tries it again.

Options:
  --json  Print one JSON result on stdout, and progress on stderr:
          {"added", "updated", "sessions", "skippedPieces": [{"pieceCid", "error"}]}.

Example:
  attic refresh --json
`,
  },
}

type Command = keyof typeof COMMANDS

const HELP = `Usage: attic <command> [options]

Backs up Claude Code and Codex sessions, encrypted, to Filecoin Onchain Cloud.

Commands:
${Object.entries(COMMANDS)
  .map(([name, { summary }]) => `  ${name.padEnd(10)}${summary}`)
  .join('\n')}

Options:
  --help     Show this help. attic <command> --help shows a command's arguments.
  --version  Print the version.

${EXIT_CODES}`

/**
 * Runs the Attic CLI with `args`, the arguments after the script path, and returns the exit code.
 * Output goes to `stdout` as it is printed, so a long upload shows where it is; with --json, only the result does.
 */
export async function run(args: readonly string[], stdout: Write, stderr: Write): Promise<number> {
  const [name, ...rest] = args
  if (args.length === 1 && name === '--version') {
    stdout(`${pkg.version}\n`)
    return 0
  }
  if (args.length === 1 && (name === '--help' || name === '-h')) {
    stdout(HELP)
    return 0
  }
  const known = isCommand(name)
  if (known && (rest.includes('--help') || rest.includes('-h'))) {
    stdout(`${COMMANDS[name].help}\n${EXIT_CODES}`)
    return 0
  }
  const json = rest.includes('--json')
  try {
    if (!known) {
      throw new AtticError('usage', `Give a command: ${Object.keys(COMMANDS).join(', ')}.`)
    }
    const { code, result } = await command(name, rest, json, (line) => (json ? stderr : stdout)(`${line}\n`))
    if (json) stdout(`${JSON.stringify(result)}\n`)
    return code
  } catch (error) {
    const message = errorMessage(error)
    const type = errorType(error)
    const help = known ? `attic ${name} --help for its arguments` : 'attic --help for the commands'
    const hint = type === 'usage' ? `\nRun ${help}.` : ''
    stderr(`Error: ${message}${hint}\n`)
    if (json) stdout(`${JSON.stringify({ error: type, message, retryable: type === 'failed' })}\n`)
    return type === 'usage' ? USAGE_ERROR : 1
  }
}

/** Runs one command, printing its progress, and returns its exit code and the result --json prints. */
async function command(
  name: Command,
  args: string[],
  json: boolean,
  print: (line: string) => void
): Promise<{ code: number; result: unknown }> {
  const options = envOptions(process.env)
  // Declared only so parseArgs accepts it; run reads --json before parsing, to report a parse error as JSON.
  const jsonOption = { json: { type: 'boolean' } } as const
  if (name === 'setup') {
    const { grant } = parseArgs({ args, options: { ...jsonOption, grant: { type: 'string' } } }).values
    return ended(await setup({ ...options, ...(grant === undefined ? {} : { grant }) }, print, synapseStorage))
  }
  if (name === 'sessions') {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: jsonOption })
    if (!json) return { code: await sessions(options.network, positionals, print), result: undefined }
    const found = matchingSessions(indexEntries(), positionals)
    // Only what an agent needs to pick a session: file lists would overflow its tool output.
    const picked = found.map(({ sessionId, agent, title, firstPrompt, project, branch, lastWriteAt }) => ({
      sessionId,
      agent,
      title,
      firstPrompt,
      project,
      branch,
      lastWriteAt,
    }))
    return { code: 0, result: picked }
  }
  if (name === 'refresh') {
    parseArgs({ args, options: jsonOption })
    const login = await openLogin(options.network)
    return { code: 0, result: await refreshIndex(login, synapseStorage(login, print), print) }
  }
  if (name === 'restore') {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: jsonOption })
    return { code: 0, result: await restore(options, sessionId(positionals), print, synapseStorage) }
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...jsonOption, current: { type: 'boolean' } },
  })
  let { agents } = options
  if (values.current) {
    if (positionals.length !== 0) throw new AtticError('usage', 'Use --current or a session ID, not both.')
    const claude = process.env.CLAUDE_SESSION_ID
    const codex = process.env.CODEX_THREAD_ID
    if (claude && codex) {
      throw new AtticError('usage', 'Both agents supply a current session ID. Give an explicit session ID.')
    }
    const id = claude || codex
    if (!id)
      throw new AtticError('usage', 'No current session ID. Run this from an agent, or give an explicit session ID.')
    positionals.push(id)
    agents = agents.filter((agent) => agent.name === (claude ? 'claude-code' : 'codex'))
  }
  const id = positionals.length === 0 ? undefined : sessionId(positionals)
  return ended(await backup({ ...options, agents }, id, print, synapseStorage))
}

// A result that exits 1 carries its message; --json gives it the same error fields as a thrown failure.
const ended = ({ code, ...result }: { code: number }) => ({
  code,
  result: code === 1 ? { error: 'failed', retryable: true, ...result } : result,
})

/** What a failure needs before a retry can help: the first AtticError in its causes, else nothing known. */
function errorType(error: unknown): FixFirst | 'failed' {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof AtticError) return cause.type
  }
  const parse = error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_')
  return parse ? 'usage' : 'failed'
}

function isCommand(name: string | undefined): name is Command {
  return name !== undefined && Object.hasOwn(COMMANDS, name)
}

// ATTIC_NETWORK and ATTIC_CONSOLE_URL are test switches, never user options: calibration guarantees no
// storage, and a staging or local console is only for trying console changes before they ship.
function envOptions(env: NodeJS.ProcessEnv): BackupOptions {
  const { ATTIC_NETWORK: network, ATTIC_CONSOLE_URL: consoleUrl } = env
  if (network !== undefined && network !== 'calibration') {
    throw new AtticError('usage', `ATTIC_NETWORK can only be calibration, for testing, not ${network}`)
  }
  return {
    network: network ?? 'mainnet',
    consoleUrl: consoleUrl === undefined ? 'https://pay.filecoin.cloud' : consoleOrigin(consoleUrl),
    agents: [claudeCode(claudeHome(env)), codex(codexHome(env))],
  }
}

// The ID becomes a file name, so nothing that could leave the agent's folder gets through.
function sessionId(positionals: string[]): string {
  const [id] = positionals
  if (positionals.length !== 1 || id === undefined) throw new AtticError('usage', 'Give one session ID.')
  if (!/^[\w-]+$/.test(id)) throw new AtticError('usage', `${id} is not a session ID.`)
  return id
}

function consoleOrigin(value: string): string {
  const url = URL.parse(value)
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new AtticError('usage', `ATTIC_CONSOLE_URL must be an http(s) URL, not ${value}`)
  }
  return url.origin
}

// viem's full message adds request arguments, a docs link and its version over several lines.
function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage
  return error instanceof Error ? error.message : String(error)
}
