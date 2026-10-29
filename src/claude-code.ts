import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import type { SessionFile } from './piece.ts'

/** Claude Code's home folder, which holds `projects/`. */
export function claudeHome(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

export type ClaudeSession = {
  /** Sorted by path, which is relative to the Claude Code home folder. */
  files: SessionFile[]
  project: string | null
  lastWriteAt: Date
}

/**
 * Reads a session's transcript (`projects/<project>/<id>.jsonl`) and its folder of subagents and tool
 * results (`projects/<project>/<id>/`), once, so what is hashed is what is uploaded.
 *
 * @returns undefined when no project holds the session.
 */
export function readClaudeSession(home: string, id: string): ClaudeSession | undefined {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return undefined
  const project = readdirSync(projects).find((name) => existsSync(join(projects, name, `${id}.jsonl`)))
  if (project === undefined) return undefined
  const transcript = join(projects, project, `${id}.jsonl`)
  const folder = join(projects, project, id)
  const paths = [transcript]
  if (existsSync(folder)) {
    for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) paths.push(join(entry.parentPath, entry.name))
    }
  }
  const files = paths.map((path) => ({ path: relative(home, path), bytes: readFileSync(path) }))
  const lastWrite = Math.max(...paths.map((path) => statSync(path).mtimeMs))
  return {
    files: files.toSorted(byPath),
    project: projectOf(new TextDecoder().decode(files[0]?.bytes)),
    lastWriteAt: new Date(lastWrite),
  }
}

const byPath = (a: SessionFile, b: SessionFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

// The folder name encodes the path lossily (every / and . becomes -), so it is read from the transcript.
function projectOf(transcript: string): string | null {
  for (const line of transcript.split('\n')) {
    try {
      const { cwd } = JSON.parse(line)
      if (typeof cwd === 'string') return cwd
    } catch {
      // A line cut short by a crash; the rest may still name the folder.
    }
  }
  return null
}
