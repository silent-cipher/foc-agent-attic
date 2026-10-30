import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writePrivateFile } from './login.ts'

/** How the last run on this machine ended, as `~/.attic/status.json` holds it. */
export type LastRun = {
  finishedAt: string
  ok: boolean
  /** The ✓ and ✗ lines the run printed. */
  lines: string[]
}

export function recordRun(run: LastRun): void {
  writePrivateFile(statusPath(), `${JSON.stringify(run, null, 2)}\n`)
}

/** The last run, or undefined when none has finished here. */
export function lastRun(): LastRun | undefined {
  const path = statusPath()
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

function statusPath(): string {
  return join(homedir(), '.attic', 'status.json')
}
