import type { Header, SessionFile } from './piece.ts'

/** A coding agent whose sessions Attic backs up, and where it keeps them. */
export type Agent = {
  name: Header['agent']
  /** The folder the agent keeps its sessions under; session file paths are relative to it. */
  home: string
  /** @returns undefined when the agent has no session with this ID. */
  readSession(id: string): AgentSession | undefined
  /** The command that resumes a session, from any folder. */
  resumeCommand(id: string): string
}

export type AgentSession = {
  /** Sorted by path, which is relative to the agent's home folder. */
  files: SessionFile[]
  /** The folder the session ran in, or null when its files never say. */
  project: string | null
  lastWriteAt: Date
  /** What the session is about, as far as its files say. */
  about: Pick<Header, 'title' | 'firstPrompt' | 'branch'>
}
