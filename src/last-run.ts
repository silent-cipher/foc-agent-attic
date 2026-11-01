import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writePrivateFile } from './login.ts'

/** How the last run on this machine ended, as `~/.attic/status.json` holds it. */
export type LastRun = {
  backedUp?: number
  skipped?: number
  failed?: number
  finishedAt: string
  ok: boolean
  /** The ✓ and ✗ lines the run printed. */
  lines: string[]
}

export function recordRun(run: LastRun): void {
  writePrivateFile(statusPath(), `${JSON.stringify(run, null, 2)}\n`)
}

/**
 * The last run, or undefined when none has finished here.
 *
 * @throws When the file is not a run status.
 */
export function lastRun(): LastRun | undefined {
  const path = statusPath()
  if (!existsSync(path)) return undefined
  const run: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isLastRun(run)) throw new Error(`${path} is not an Attic run status. Fix it, or delete it.`)
  return run
}

function isLastRun(r: unknown): r is LastRun {
  return (
    typeof r === 'object' &&
    r !== null &&
    'finishedAt' in r &&
    typeof r.finishedAt === 'string' &&
    'ok' in r &&
    typeof r.ok === 'boolean' &&
    'lines' in r &&
    Array.isArray(r.lines) &&
    r.lines.every((line) => typeof line === 'string')
  )
}

function statusPath(): string {
  return join(homedir(), '.attic', 'status.json')
}
