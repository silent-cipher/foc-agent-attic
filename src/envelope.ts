import { keyResolver, newSalt, pieceKey, pieceMetadata, writeTarget } from '@filoz/keysmith'
import * as fee from 'filecoin-encryption-envelope'
import { type OpenedGrant, SCOPE } from './grant.ts'

/** The FEE `content_type` of every Attic piece. */
export const CONTENT_TYPE = 'application/vnd.filecoin.attic-session.v1'

/** Encrypts `plaintext` as a FEE chunked envelope, under a fresh piece key in the `attic` scope. */
export function encrypt(grant: OpenedGrant, plaintext: Uint8Array): Promise<Uint8Array> {
  const target = writeTarget(grant.grant, grant.key, SCOPE)
  const salt = newSalt()
  const appMetadata = pieceMetadata(target.ref, { salt, scope: SCOPE })
  return pipe(
    plaintext,
    fee.encrypt({
      cek: pieceKey(target.key, salt),
      contentLength: plaintext.length,
      contentType: CONTENT_TYPE,
      appMetadata,
    })
  )
}

/** Decrypts an Attic envelope the Grant's group key reaches, deriving its piece key from the envelope's labels. */
export function decrypt(grant: OpenedGrant, envelope: Uint8Array): Promise<Uint8Array> {
  const resolve = keyResolver(grant.key, grant.grant)
  return pipe(
    envelope,
    fee.decrypt((info) => {
      if (info.contentType !== CONTENT_TYPE) {
        throw new Error(`it is ${String(info.contentType)}, not an Attic session; update Attic if it is newer`)
      }
      return resolve(info)
    })
  )
}

function pipe(bytes: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  return new Response(ReadableStream.from([bytes]).pipeThrough(transform)).bytes()
}
