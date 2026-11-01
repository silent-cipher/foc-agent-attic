import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import type { Agent, AgentSession } from './agent.ts'

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
      const about: AgentSession['about'] = {}
      const title = threadName(home, id)
      if (title !== undefined) about.title = title
      const prompt = firstPrompt(bytes.toString('utf8'))
      if (prompt !== undefined) about.firstPrompt = prompt
      const git = 'git' in meta.payload ? meta.payload.git : undefined
      if (
        typeof git === 'object' &&
        git !== null &&
        'branch' in git &&
        typeof git.branch === 'string' &&
        git.branch !== ''
      ) {
        about.branch = git.branch
      }
      return {
        files: [{ path: relative(home, path), bytes }],
        project: 'cwd' in meta.payload && typeof meta.payload.cwd === 'string' ? meta.payload.cwd : null,
        lastWriteAt: statSync(path).mtime,
        about,
      }
    },
  }
}

function threadName(home: string, id: string): string | undefined {
  let index: string
  try {
    index = readFileSync(join(home, 'session_index.jsonl'), 'utf8')
  } catch {
    // The optional title index must never prevent a rollout backup.
    return undefined
  }
  let title: string | undefined
  for (const line of index.split('\n')) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      entry.id === id &&
      'thread_name' in entry &&
      typeof entry.thread_name === 'string'
    ) {
      title = entry.thread_name || undefined
    }
  }
  return title
}

const PROMPT_LENGTH = 80

function firstPrompt(rollout: string): string | undefined {
  for (const line of rollout.split('\n')) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('type' in entry) ||
      entry.type !== 'event_msg' ||
      !('payload' in entry) ||
      typeof entry.payload !== 'object' ||
      entry.payload === null ||
      !('type' in entry.payload) ||
      entry.payload.type !== 'user_message' ||
      !('message' in entry.payload) ||
      typeof entry.payload.message !== 'string'
    )
      continue
    const text = entry.payload.message.replace(/\s+/g, ' ').trim()
    return text === '' ? undefined : text.length > PROMPT_LENGTH ? `${text.slice(0, PROMPT_LENGTH - 1)}…` : text
  }
  return undefined
}
