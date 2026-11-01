import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
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
  listError?: Error | undefined
  /** Thrown by range reads of these pieces, as by a provider that is down. */
  unreadable: Set<string>
  /** Bytes downloaded or read by range. */
  bytesRead: number
  /** The piece CID of each range read, in order. */
  rangeReads: string[]
  readsInFlight: number
  maxReadsInFlight: number
}

/**
 * Attic's storage held in memory, for tests: the real envelopes, by piece CID.
 * Change `authorizedUntil`, `quote`, `storeError`, `listError` or `unreadable` to play an account in another state.
 */
export function memoryStorage() {
  // 2100-01-01.
  const state: MemoryState = {
    pieces: new Map(),
    authorizedUntil: 4102444800,
    quote: FUNDED,
    unreadable: new Set(),
    bytesRead: 0,
    rangeReads: [],
    readsInFlight: 0,
    maxReadsInFlight: 0,
  }
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
      if (state.listError !== undefined) throw state.listError
      return [...state.pieces].map(([pieceCid, envelope], index) => ({
        pieceCid,
        size: envelope.length,
        copies: [{ providerId: '1', dataSetId: '1', pieceId: String(index) }],
        read: async (offset: number, length: number) => {
          state.rangeReads.push(pieceCid)
          state.readsInFlight++
          state.maxReadsInFlight = Math.max(state.maxReadsInFlight, state.readsInFlight)
          // Yields, as a network read does, so concurrent reads overlap.
          await setImmediate()
          state.readsInFlight--
          if (state.unreadable.has(pieceCid)) throw new Error(`provider answered 503 for ${pieceCid}`)
          state.bytesRead += length
          return envelope.slice(offset, offset + length)
        },
      }))
    },
  })
  return { state, connect }
}
