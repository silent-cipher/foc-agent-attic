import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { COMMITMENT_KEY, commitment, KEYSPACE_ID_KEY } from '@filoz/keysmith'
import { from } from '@filoz/synapse-core/piece'
import * as sessionKeys from '@filoz/synapse-core/session-key'
import type { CreateContextsOptions, UploadCallbacks } from '@filoz/synapse-sdk'
import { openLogin } from '../../src/login.ts'
import { logIn, tempHome } from '../e2e/helpers.ts'

const cid = from('bafkzcibcaapeh2qvtlm6tdodcaa6s3jfohqc6rqmfhwdgbm2nj4bsgzddlqbu3a')
const context: { dataSetId: bigint | undefined; provider: { id: bigint } } = {
  dataSetId: undefined,
  provider: { id: 1n },
}
type Uploaded = {
  pieceCid: typeof cid
  complete: boolean
  copies: { providerId: bigint; dataSetId: bigint; pieceId: bigint }[]
}
let dataSets: { live: boolean; dataSetId: bigint; metadata: Record<string, string> }[] = []
let targets: CreateContextsOptions[] = []
let pending: { id: number; result: ReturnType<typeof Promise.withResolvers<Uploaded>> }[] = []
let batches: number[][] = []
let removals: { dataSetId: bigint; pieces: bigint[] }[] = []
let inFlight = 0
let maxInFlight = 0
let failStore = -1
let incomplete = -1
let providerDown = false
let creations = 0

mock.module('@filoz/synapse-core/session-key', {
  namedExports: {
    ...sessionKeys,
    fromSecp256k1: () => ({ syncExpirations: async () => undefined }),
  },
})
mock.module('@filoz/synapse-core/warm-storage', {
  namedExports: {
    getPdpDataSets: async () => ({ items: dataSets }),
  },
})
mock.module('@filoz/synapse-sdk', {
  namedExports: {
    Synapse: {
      create: () => ({
        client: {},
        storage: {
          async createContexts(options: CreateContextsOptions) {
            targets.push(options)
            if (providerDown) throw new Error('known provider is down')
            context.dataSetId = options.dataSetIds?.[0]
            return [context]
          },
          async upload(bytes: Uint8Array, options: { callbacks?: UploadCallbacks }) {
            const id = bytes[0] ?? 0
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            await setImmediate()
            inFlight--
            if (id === failStore) throw new Error('transfer failed')
            const result = Promise.withResolvers<Uploaded>()
            pending.push({ id, result })
            options.callbacks?.onStored?.(1n, cid)
            return result.promise
          },
          async flush() {
            if (pending.length === 0) return
            batches.push(pending.map(({ id }) => id))
            if (context.dataSetId === undefined) creations++
            context.dataSetId ??= 99n
            for (const { id, result } of pending)
              result.resolve({
                pieceCid: cid,
                complete: id !== incomplete,
                copies: [{ providerId: 1n, dataSetId: context.dataSetId, pieceId: BigInt(id) }],
              })
            pending = []
          },
          async createContext({ dataSetId }: { dataSetId: bigint }) {
            return {
              async deletePieces({ pieces }: { pieces: bigint[] }) {
                removals.push({ dataSetId, pieces })
                return '0x123'
              },
            }
          },
        },
      }),
    },
  },
})
const { synapseStorage } = await import('../../src/storage.ts')

beforeEach(() => {
  dataSets = []
  targets = []
  pending = []
  batches = []
  removals = []
  inFlight = 0
  maxInFlight = 0
  failStore = -1
  incomplete = -1
  providerDown = false
  creations = 0
  context.dataSetId = undefined
})

async function fixture(known = true) {
  const home = await tempHome()
  process.env.HOME = home.root
  await logIn(home)
  const login = await openLogin('calibration')
  if (known)
    dataSets = [
      {
        live: true,
        dataSetId: 7n,
        metadata: {
          source: 'attic',
          'foc/enc': '1',
          [KEYSPACE_ID_KEY]: login.grant.grant.keyspace,
          [COMMITMENT_KEY]: commitment(login.grant.key),
        },
      },
    ]
  return synapseStorage(login, () => undefined)
}
const envelopes = () => Array.from({ length: 10 }, (_, id) => new Uint8Array([id]))

test('known data sets receive one batch, at most four transfers, and ordered results despite a failed transfer', async () => {
  const storage = await fixture()
  failStore = 3
  const results = await storage.storeBatch(envelopes())
  assert.deepEqual(
    targets.map((target) => target.dataSetIds),
    [[7n]]
  )
  assert.equal(maxInFlight, 4)
  assert.equal(batches.length, 1)
  assert.equal(batches[0]?.length, 9)
  assert.equal(creations, 0)
  assert.equal(results.length, 10)
  for (const [index, result] of results.entries()) {
    if (index === 3) assert.equal(result.status, 'rejected')
    else {
      assert.equal(result.status, 'fulfilled')
      if (result.status === 'fulfilled') assert.equal(result.value.copies[0]?.pieceId, String(index))
    }
  }
})

test('a first run establishes one data set alone before batching the rest', async () => {
  const storage = await fixture(false)
  const results = await storage.storeBatch(envelopes())
  assert.equal(
    results.every((result) => result.status === 'fulfilled'),
    true
  )
  assert.equal(creations, 1)
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [1, 9]
  )
  assert.equal(maxInFlight, 4)
})

test('a failed first transfer does not prevent another session establishing the data set', async () => {
  const storage = await fixture(false)
  failStore = 0
  const results = await storage.storeBatch(envelopes())
  assert.equal(results[0]?.status, 'rejected')
  assert.equal(
    results.slice(1).every((result) => result.status === 'fulfilled'),
    true
  )
  assert.equal(creations, 1)
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [1, 8]
  )
})

test('incomplete SDK results fail rather than recording successful backups', async () => {
  const storage = await fixture()
  incomplete = 2
  const results = await storage.storeBatch(envelopes())
  assert.equal(results[2]?.status, 'rejected')
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 9)
  await assert.rejects(storage.store(new Uint8Array([2])), /did not commit all configured copies/)
})

test('a known provider outage fails without falling back to a new data set', async () => {
  const storage = await fixture()
  providerDown = true
  await assert.rejects(storage.storeBatch(envelopes()), /known provider is down/)
  assert.deepEqual(
    targets.map((target) => target.dataSetIds),
    [[7n]]
  )
  assert.equal(creations, 0)
})

test('removals are grouped into one call per data set', async () => {
  const storage = await fixture()
  await storage.remove([
    { providerId: '1', dataSetId: '7', pieceId: '1' },
    { providerId: '1', dataSetId: '7', pieceId: '2' },
    { providerId: '2', dataSetId: '8', pieceId: '3' },
  ])
  assert.deepEqual(removals, [
    { dataSetId: 7n, pieces: [1n, 2n] },
    { dataSetId: 8n, pieces: [3n] },
  ])
})
