import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { indexPath, type Keyholder, keyholderOf, readIndex, sameKeyholder } from './local-index.ts'
import { openPiece, type SessionFile } from './piece.ts'
import { type Network, openLogin } from './session.ts'
import type { Connect } from './storage.ts'

export type RestoreOptions = { network: Network; claudeHome: string }

/**
 * Downloads a session's newest backup, checks it, and writes its files back into Claude Code's home folder.
 * Nothing is written unless the piece decrypts and every file matches its SHA-256 and passes `writeSessionFiles`' checks.
 */
export async function restore(
  options: RestoreOptions,
  id: string,
  print: (line: string) => void,
  connect: Connect
): Promise<number> {
  const entry = readIndex(indexPath()).sessions[id]
  if (entry === undefined) throw new Error(`Session ${id} is not in the Attic index, so it has no backup here.`)
  const login = await openLogin(options.network)
  const keyholder = keyholderOf(options.network, login.grant)
  if (!sameKeyholder(entry, keyholder)) {
    throw new Error(
      `Session ${id} is backed up under ${describe(entry)}, but this login is for ${describe(keyholder)}. ` +
        'It cannot decrypt that backup. Nothing was written.'
    )
  }
  print(`Downloading piece ${entry.pieceCid} (${entry.size} bytes) on ${options.network}`)
  const envelope = await connect(login, options.network, print).download(entry.pieceCid)
  const { header, files } = await openPiece(login.grant, envelope).catch((error: unknown) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Nothing was written.`)
  })
  if (header.sessionId !== id) {
    throw new Error(`The piece for ${id} holds session ${header.sessionId}. Nothing was written.`)
  }
  const written = writeSessionFiles(options.claudeHome, files)
  print(
    written === 0
      ? `✓ Session ${id} is already here, identical to its backup.`
      : `✓ Restored session ${id}: ${written} of ${files.length} files written to ${options.claudeHome}`
  )
  print('Resume it from any folder with:')
  print(`claude --resume ${id}`)
  return 0
}

/**
 * Writes the files missing under `home`, after checking them all: a path outside `home`, or an existing file
 * that differs, writes nothing.
 *
 * @returns How many files were written; existing identical files are left alone.
 */
export function writeSessionFiles(home: string, files: readonly SessionFile[]): number {
  const missing = files.flatMap(({ path, bytes }) => {
    const target = resolve(home, path)
    const inside = relative(home, target)
    if (isAbsolute(path) || inside === '' || inside.split(sep)[0] === '..' || isAbsolute(inside)) {
      throw new Error(`The backup holds ${path}, which is outside ${home}. Nothing was written.`)
    }
    if (!existsSync(target)) return [{ target, bytes }]
    const local = readFileSync(target)
    if (local.equals(bytes)) return []
    // Transcripts only grow, so a local file that starts with the backup's bytes was used after the backup.
    if (local.length > bytes.length && local.subarray(0, bytes.length).equals(bytes)) {
      throw new Error(
        `${target} is newer than the backup: the session was used after it was backed up. ` +
          'Nothing was written. Resume it as it is, or run /attic:backup with its ID to back up the newer version.'
      )
    }
    throw new Error(
      `${target} already exists and differs from the backup. Move it away to restore. Nothing was written.`
    )
  })
  for (const { target, bytes } of missing) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' })
  }
  return missing.length
}

const describe = (k: Keyholder) => `group key ${k.groupKey} of ${k.owner} on ${k.network}`
