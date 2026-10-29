import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Synapse } from '@filoz/synapse-sdk'
import { SOURCE } from './backup.ts'
import { decrypt } from './envelope.ts'
import { indexPath, readIndex } from './local-index.ts'
import { type SessionFile, sha256, unpack } from './piece.ts'
import { CHAINS, type Network, openLogin } from './session.ts'

export type RestoreOptions = { network: Network; claudeHome: string }

/**
 * Downloads a session's newest backup, checks it, and writes its files back into Claude Code's home folder.
 * Nothing is written unless the piece decrypts and every file matches its SHA-256 and passes `writeSessionFiles`' checks.
 */
export async function restore(options: RestoreOptions, id: string, print: (line: string) => void): Promise<number> {
  const entry = readIndex(indexPath()).sessions[id]
  if (entry === undefined) throw new Error(`Session ${id} is not in the Attic index, so it has no backup here.`)
  const { grant } = await openLogin(options.network)
  const synapse = Synapse.create({ account: grant.owner, chain: CHAINS[options.network], source: SOURCE })
  const envelope = await synapse.storage.download({ pieceCid: entry.pieceCid })
  let plaintext: Uint8Array
  try {
    plaintext = await decrypt(grant, envelope)
  } catch (error) {
    // FEE wraps the key resolver's own reason as the cause.
    const reason = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error)
    throw new Error(`The backup of ${id} does not decrypt: ${reason}. Nothing was written.`)
  }
  const { header, files } = unpack(plaintext)
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
    if (sha256(readFileSync(target)) !== sha256(bytes)) {
      throw new Error(
        `${target} already exists and differs from the backup. Move it away to restore. Nothing was written.`
      )
    }
    return []
  })
  for (const { target, bytes } of missing) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' })
  }
  return missing.length
}
