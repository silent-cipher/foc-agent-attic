import { keyResolver, newSalt, pieceKey, pieceMetadata, writeTarget } from '@filoz/keysmith'
import * as fee from 'filecoin-encryption-envelope'
import { type OpenedGrant, SCOPE } from './grant.ts'

/** Encrypts `plaintext` as a FEE chunked envelope, under a fresh piece key in the `attic` scope. */
export function encrypt(grant: OpenedGrant, plaintext: Uint8Array): Promise<Uint8Array> {
  const target = writeTarget(grant.grant, grant.key, SCOPE)
  const salt = newSalt()
  const appMetadata = pieceMetadata(target.ref, { salt, scope: SCOPE })
  return pipe(plaintext, fee.encrypt({ cek: pieceKey(target.key, salt), contentLength: plaintext.length, appMetadata }))
}

/** Decrypts an envelope the Grant's group key reaches, deriving its piece key from the envelope's labels. */
export function decrypt(grant: OpenedGrant, envelope: Uint8Array): Promise<Uint8Array> {
  return pipe(envelope, fee.decrypt(keyResolver(grant.key, grant.grant)))
}

function pipe(bytes: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  return new Response(ReadableStream.from([bytes]).pipeThrough(transform)).bytes()
}
