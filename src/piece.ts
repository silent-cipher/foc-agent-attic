import { createHash } from 'node:crypto'
import { keyResolver, newSalt, pieceKey, pieceMetadata, writeTarget } from '@filoz/keysmith'
import * as fee from 'filecoin-encryption-envelope'
import { type OpenedGrant, SCOPE } from './grant.ts'

/** The FEE `content_type` of every Attic piece. */
export const CONTENT_TYPE = 'application/vnd.filecoin.attic-session.v1'

/** The plaintext header every session piece starts with. Paths are relative to the agent's home folder. */
export type Header = {
  v: 1
  agent: 'claude-code'
  sessionId: string
  /** The folder the session ran in, or null when its files never say. */
  project: string | null
  machine: string
  lastWriteAt: string
  files: FileEntry[]
}

type FileEntry = { path: string; size: number; sha256: string }

export type SessionFile = { path: string; bytes: Uint8Array }

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Each file's path, size and SHA-256, as a piece's header lists them. */
export function fileEntries(files: readonly SessionFile[]): FileEntry[] {
  return files.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) }))
}

/**
 * Packs a session into a piece and encrypts it as a FEE chunked envelope, under a fresh piece key in the
 * `attic` scope. The plaintext is a 4-byte big-endian header length, the header as JSON, then each file's
 * bytes in header order.
 */
export async function sealPiece(
  grant: OpenedGrant,
  fields: Omit<Header, 'files'>,
  files: readonly SessionFile[]
): Promise<{ header: Header; envelope: Uint8Array }> {
  const header = { ...fields, files: fileEntries(files) }
  const json = new TextEncoder().encode(JSON.stringify(header))
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, json.length)
  const plaintext = Buffer.concat([length, json, ...files.map((file) => file.bytes)])
  const target = writeTarget(grant.grant, grant.key, SCOPE)
  const salt = newSalt()
  const envelope = await pipe(
    plaintext,
    fee.encrypt({
      cek: pieceKey(target.key, salt),
      contentLength: plaintext.length,
      contentType: CONTENT_TYPE,
      appMetadata: pieceMetadata(target.ref, { salt, scope: SCOPE }),
    })
  )
  return { header, envelope }
}

/**
 * Decrypts a piece the Grant's group key reaches, deriving its piece key from the envelope's labels, and
 * splits it back into its header and files, checking each file's size and SHA-256.
 *
 * @throws With the reason, safe to print, when the piece does not decrypt, is damaged or is from a newer Attic.
 */
export async function openPiece(
  grant: OpenedGrant,
  envelope: Uint8Array
): Promise<{ header: Header; files: SessionFile[] }> {
  const resolve = keyResolver(grant.key, grant.grant)
  let piece: Uint8Array
  try {
    piece = await pipe(
      envelope,
      fee.decrypt((info) => {
        if (info.contentType !== CONTENT_TYPE) {
          throw new Error(`it is ${String(info.contentType)}, not an Attic session; update Attic if it is newer`)
        }
        return resolve(info)
      })
    )
  } catch (error) {
    // FEE wraps the key resolver's own reason as the cause.
    const reason = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error)
    throw new Error(`The backup does not decrypt: ${reason}.`)
  }
  const view = new DataView(piece.buffer, piece.byteOffset, piece.byteLength)
  const length = piece.length >= 4 ? view.getUint32(0) : Number.POSITIVE_INFINITY
  if (4 + length > piece.length) throw new Error('The backup is damaged: its header is cut short.')
  let header: unknown
  try {
    header = JSON.parse(new TextDecoder().decode(piece.subarray(4, 4 + length)))
  } catch {
    throw new Error('The backup is damaged: its header is not JSON.')
  }
  if (typeof header === 'object' && header !== null && 'v' in header && header.v !== 1) {
    throw new Error(`The backup is format ${String(header.v)}, newer than this Attic. Update Attic to restore it.`)
  }
  if (!isHeader(header)) throw new Error('The backup is damaged: its header is not an Attic session header.')
  const files: SessionFile[] = []
  let offset = 4 + length
  for (const { path, size, sha256: expected } of header.files) {
    const bytes = piece.subarray(offset, offset + size)
    offset += size
    if (bytes.length !== size || sha256(bytes) !== expected) {
      throw new Error(`The backup is damaged: ${path} does not match its SHA-256.`)
    }
    files.push({ path, bytes })
  }
  if (offset !== piece.length) throw new Error('The backup is damaged: it has bytes after its last file.')
  return { header, files }
}

function pipe(bytes: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  return new Response(ReadableStream.from([bytes]).pipeThrough(transform)).bytes()
}

function isHeader(h: unknown): h is Header {
  return (
    typeof h === 'object' &&
    h !== null &&
    'v' in h &&
    h.v === 1 &&
    'agent' in h &&
    h.agent === 'claude-code' &&
    'sessionId' in h &&
    typeof h.sessionId === 'string' &&
    'project' in h &&
    (typeof h.project === 'string' || h.project === null) &&
    'machine' in h &&
    typeof h.machine === 'string' &&
    'lastWriteAt' in h &&
    typeof h.lastWriteAt === 'string' &&
    'files' in h &&
    Array.isArray(h.files) &&
    h.files.every(isFileEntry)
  )
}

function isFileEntry(f: unknown): f is FileEntry {
  return (
    typeof f === 'object' &&
    f !== null &&
    'path' in f &&
    typeof f.path === 'string' &&
    'size' in f &&
    typeof f.size === 'number' &&
    Number.isSafeInteger(f.size) &&
    f.size >= 0 &&
    'sha256' in f &&
    typeof f.sha256 === 'string'
  )
}
