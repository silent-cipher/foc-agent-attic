import { lastRun } from './last-run.ts'
import { indexEntries } from './local-index.ts'
import { type Network, openLogin } from './login.ts'

const WARN_DAYS = 7

/**
 * Lists the backed-up sessions in the index, newest first, then how the last run ended and whether the session
 * key expires soon. With `words`, lists only the sessions whose title, first prompt, project or branch contain
 * every word, ignoring case. Reads only local files, so it works offline.
 */
export async function sessions(
  network: Network,
  words: readonly string[],
  print: (line: string) => void,
  now = Math.floor(Date.now() / 1000)
): Promise<number> {
  const all = indexEntries()
  const needles = words.map((word) => word.toLowerCase())
  const entries = all
    .filter((e) => {
      const text = [e.title, e.firstPrompt, e.project, e.branch].join('\n').toLowerCase()
      return needles.every((needle) => text.includes(needle))
    })
    .toSorted((a, b) => b.lastWriteAt.localeCompare(a.lastWriteAt))
  if (all.length === 0) {
    print('No sessions in the Attic index. Back one up with /attic:backup <session id>.')
    print('Backed up on another machine? Run /attic:refresh to add it to the index.')
  } else if (entries.length === 0) {
    print(`No sessions in the Attic index match ${words.join(' ')}.`)
  } else {
    const header = ['Session ID', 'Agent', 'Project', 'Last write (UTC)', 'Size', 'Title']
    const rows = [
      header,
      ...entries.map((e) => [
        e.sessionId,
        e.agent,
        e.project ?? '?',
        dateTime(e.lastWriteAt),
        `${(e.size / 1024).toFixed(1)} KiB`,
        e.title ?? e.firstPrompt ?? '',
      ]),
    ]
    const widths = header.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)))
    for (const row of rows)
      print(
        row
          .map((cell, column) => cell.padEnd(widths[column] ?? 0))
          .join('  ')
          .trimEnd()
      )
  }

  const run = lastRun()
  if (run === undefined) {
    print('No backup run has finished on this machine yet.')
  } else {
    print(`Last run ${dateTime(run.finishedAt)} UTC ${run.ok ? 'succeeded' : 'failed'}:`)
    for (const line of run.lines) print(`  ${line}`)
  }

  let expires: number
  try {
    expires = (await openLogin(network)).grant.expires
  } catch (error) {
    print(`✗ ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
  const date = new Date(expires * 1000).toISOString().slice(0, 10)
  if (expires <= now) {
    print(`✗ The session key expired on ${date}. Run /attic:setup to log in again.`)
  } else if (expires - now <= WARN_DAYS * 86_400) {
    const days = Math.floor((expires - now) / 86_400)
    print(`⚠ The session key expires on ${date} (in ${days} days). Run /attic:setup to renew it.`)
  }
  return 0
}

const dateTime = (iso: string) => iso.slice(0, 16).replace('T', ' ')
