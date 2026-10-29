import pkg from '../package.json' with { type: 'json' }

/** What one CLI run prints and its exit code. */
export type Result = { code: number; stdout: string; stderr: string }

/** Runs the Attic CLI with `args`, the arguments after the script path. */
export function run(args: readonly string[]): Result {
  if (args.length === 1 && args[0] === '--version') return { code: 0, stdout: `${pkg.version}\n`, stderr: '' }
  return { code: 1, stdout: '', stderr: 'Usage: attic --version\n' }
}
