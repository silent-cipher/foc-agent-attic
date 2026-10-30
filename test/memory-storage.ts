import { createHash } from 'node:crypto'
import { parseUnits } from 'viem'
import type { Connect, Quote } from '../src/storage.ts'

/** An account that can store anything: storage approved, nothing to deposit, 5 USDFC available. */
export const FUNDED: Quote = { storageApproved: true, depositNeeded: 0n, availableFunds: parseUnits('5', 18) }

type MemoryState = {
  pieces: Map<string, Uint8Array>
  authorized: boolean
  quote: Quote
  storeError?: Error | undefined
}

/**
 * Attic's storage held in memory, for tests: the real envelopes, by piece CID.
 * Change `authorized`, `quote` or `storeError` to play an account in another state.
 */
export function memoryStorage() {
  const state: MemoryState = { pieces: new Map(), authorized: true, quote: FUNDED }
  const connect: Connect = () => ({
    isAuthorized: async () => state.authorized,
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
      return envelope
    },
  })
  return { state, connect }
}
