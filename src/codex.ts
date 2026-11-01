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
      const folders = [sessions]
      let path: string | undefined
      for (const folder of folders) {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          if (entry.isDirectory()) folders.push(join(folder, entry.name))
          else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) {
            path = join(folder, entry.name)
            break
          }
        }
        if (path !== undefined) break
      }
      if (path === undefined) return undefined
      const bytes = readFileSync(path)
      const firstLineEnd = bytes.indexOf(0x0a)
      let meta: unknown
      try {
        meta = JSON.parse(bytes.subarray(0, firstLineEnd < 0 ? bytes.length : firstLineEnd).toString('utf8'))
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
        about: {},
      }
    },
  }
}
