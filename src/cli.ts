import { parseArgs } from 'node:util'
import { BaseError } from 'viem'
import pkg from '../package.json' with { type: 'json' }
import { type SetupOptions, setup } from './setup.ts'

/** What one CLI run prints and its exit code. */
export type Result = { code: number; stdout: string; stderr: string }

const USAGE = 'Usage: attic --version | attic setup [--network mainnet|calibration] [--grant <fgr1_…>]\n'

/** Runs the Attic CLI with `args`, the arguments after the script path. */
export async function run(args: readonly string[]): Promise<Result> {
  if (args.length === 1 && args[0] === '--version') return { code: 0, stdout: `${pkg.version}\n`, stderr: '' }
  if (args[0] !== 'setup') return { code: 1, stdout: '', stderr: USAGE }
  const lines: string[] = []
  const stdout = () => lines.map((line) => `${line}\n`).join('')
  try {
    const code = await setup(setupOptions(args.slice(1)), (line) => lines.push(line))
    return { code, stdout: stdout(), stderr: '' }
  } catch (error) {
    return { code: 1, stdout: stdout(), stderr: `Error: ${errorMessage(error)}\n` }
  }
}

function setupOptions(args: string[]): SetupOptions {
  const { values } = parseArgs({ args, options: { network: { type: 'string' }, grant: { type: 'string' } } })
  const { network, grant } = values
  if (network !== undefined && network !== 'mainnet' && network !== 'calibration') {
    throw new Error(`--network must be mainnet or calibration, not ${network}`)
  }
  return { ...(network !== undefined && { network }), ...(grant !== undefined && { grant }) }
}

// viem's full message adds request arguments, a docs link and its version over several lines.
function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage
  return error instanceof Error ? error.message : String(error)
}
