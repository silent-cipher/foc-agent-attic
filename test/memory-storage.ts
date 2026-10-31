import { createHash } from 'node:crypto'
import { parseUnits } from 'viem'
import type { Connect, Quote } from '../src/storage.ts'

/** An account that can store anything: storage approved, nothing to deposit, 5 USDFC available. */
const FUNDED: Quote = { storageApproved: true, depositNeeded: 0n, availableFunds: parseUnits('5', 18) }

type MemoryState = {
  pieces: Map<string, Uint8Array>
  /** Unix seconds, as `Storage.authorizedUntil` returns it. */
  authorizedUntil: number
  quote: Quote
  storeError?: Error | undefined
  /** Bytes downloaded or read by range. */
  bytesRead: number
}

/**
 * Attic's storage held in memory, for tests: the real envelopes, by piece CID.
 * Change `authorizedUntil`, `quote` or `storeError` to play an account in another state.
 */
export function memoryStorage() {
  // 2100-01-01.
  const state: MemoryState = { pieces: new Map(), authorizedUntil: 4102444800, quote: FUNDED, bytesRead: 0 }
  const connect: Connect = () => ({
    authorizedUntil: async () => state.authorizedUntil,
    account: async () => state.quote,
    quote: async () => state.quote,
    async store(envelope) {
      if (state.storeError !== undefined) throw state.storeError
      const pieceCid = `memory-${createHash('sha256').update(envelope).digest('hex')}`
      state.pieces.set(pieceCid, envelope)
      return { pieceCid, copies: [{ providerId: '1', dataSetId: '1', pieceId: String(state.pieces.size - 1) }] }
    },
    async download(pieceCid) {
      const envelope = state.pieces.get(pieceCid)
      if (envelope === undefined) throw new Error(`No piece ${pieceCid}`)
      state.bytesRead += envelope.length
      return envelope
    },
    async pieces() {
      return [...state.pieces].map(([pieceCid, envelope], index) => ({
        pieceCid,
        size: envelope.length,
        copies: [{ providerId: '1', dataSetId: '1', pieceId: String(index) }],
        read: async (offset: number, length: number) => {
          state.bytesRead += length
          return envelope.slice(offset, offset + length)
        },
      }))
    },
  })
  return { state, connect }
}
