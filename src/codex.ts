import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import type { Agent } from './agent.ts'

/** Codex's home folder, which holds `sessions/`. */
export function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME ?? join(homedir(), '.codex')
}

/** Codex, keeping its rollouts under `home/sessions/`. */
export function codex(home: string): Agent {
  return {
    name: 'codex',
    home,
    resumeCommand: (id) => `codex resume ${id}`,
    readSession: (id) => {
      const sessions = join(home, 'sessions')
      if (!existsSync(sessions)) return undefined
      const entry = readdirSync(sessions, { recursive: true, withFileTypes: true }).find(
        (entry) => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)
      )
      if (entry === undefined) return undefined
      const path = join(entry.parentPath, entry.name)
      const bytes = readFileSync(path)
      let meta: unknown
      try {
        meta = JSON.parse(bytes.toString('utf8').split('\n', 1)[0] ?? '')
      } catch {
        throw new Error(`Codex rollout ${path} has invalid session metadata.`)
      }
      if (
        typeof meta !== 'object' ||
        meta === null ||
        !('type' in meta) ||
        meta.type !== 'session_meta' ||
        !('payload' in meta) ||
        typeof meta.payload !== 'object' ||
        meta.payload === null ||
        !('id' in meta.payload) ||
        typeof meta.payload.id !== 'string'
      ) {
        throw new Error(`Codex rollout ${path} has invalid session metadata.`)
      }
      if (meta.payload.id !== id) return undefined
      return {
        files: [{ path: relative(home, path), bytes }],
        project: 'cwd' in meta.payload && typeof meta.payload.cwd === 'string' ? meta.payload.cwd : null,
        lastWriteAt: statSync(path).mtime,
      }
    },
  }
}
