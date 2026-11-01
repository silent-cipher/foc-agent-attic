import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import type { Agent, AgentSession } from './agent.ts'
import type { SessionFile } from './piece.ts'

/** Claude Code's home folder, which holds `projects/`. */
export function claudeHome(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/** Claude Code, keeping its sessions under `home`. */
export function claudeCode(home: string): Agent {
  return {
    name: 'claude-code',
    home,
    readSession: (id) => readClaudeSession(home, id),
    resumeCommand: (id) => `claude --resume ${id}`,
  }
}

/**
 * Reads a session's transcript (`projects/<project>/<id>.jsonl`) and its folder of subagents and tool
 * results (`projects/<project>/<id>/`), once, so what is hashed is what is uploaded.
 *
 * @returns undefined when no project holds the session.
 */
function readClaudeSession(home: string, id: string): AgentSession | undefined {
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
    ...describe(new TextDecoder().decode(files[0]?.bytes)),
    lastWriteAt: new Date(lastWrite),
  }
}

const byPath = (a: SessionFile, b: SessionFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

const PROMPT_LENGTH = 80

// The folder name encodes the project path lossily (every / and . becomes -), so it is read from the transcript.
function describe(transcript: string): Pick<AgentSession, 'project' | 'about'> {
  let project: string | null = null
  const about: AgentSession['about'] = {}
  for (const line of transcript.split('\n')) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      // A line cut short by a crash; the rest may still say.
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    if (project === null && 'cwd' in entry && typeof entry.cwd === 'string') project = entry.cwd
    if ('gitBranch' in entry && typeof entry.gitBranch === 'string' && entry.gitBranch !== '') {
      about.branch = entry.gitBranch
    }
    if ('type' in entry && entry.type === 'ai-title' && 'aiTitle' in entry && typeof entry.aiTitle === 'string') {
      about.title = entry.aiTitle
    }
    if (about.firstPrompt === undefined) {
      const prompt = promptOf(entry)
      if (prompt !== undefined) about.firstPrompt = prompt
    }
  }
  return { project, about }
}

// Slash commands, shell input and Claude Code's own notes come wrapped in <tags>, and the skill text and
// summaries it injects are flagged; neither says what the session is about.
function promptOf(entry: object): string | undefined {
  if (!('type' in entry) || entry.type !== 'user' || ('isMeta' in entry && entry.isMeta === true)) return undefined
  if ('isCompactSummary' in entry && entry.isCompactSummary === true) return undefined
  if (!('message' in entry) || typeof entry.message !== 'object' || entry.message === null) return undefined
  const content = 'content' in entry.message ? entry.message.content : undefined
  const blocks: unknown[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  const text = blocks
    .map((block) =>
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block
        ? String(block.text)
        : ''
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '' || text.startsWith('<')) return undefined
  return text.length > PROMPT_LENGTH ? `${text.slice(0, PROMPT_LENGTH - 1)}…` : text
}
