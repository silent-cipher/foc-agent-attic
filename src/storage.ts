import { COMMITMENT_KEY, commitment, KEYSPACE_ID_KEY } from '@filoz/keysmith'
import { paginate } from '@filoz/synapse-core'
import { getAccountSummary, isFwssMaxApproved } from '@filoz/synapse-core/pay'
import { getPieces } from '@filoz/synapse-core/pdp-verifier'
import {
  AddPiecesPermission,
  CreateDataSetPermission,
  fromSecp256k1,
  SchedulePieceRemovalsPermission,
} from '@filoz/synapse-core/session-key'
import { findMatchingDataSets, getPdpDataSets } from '@filoz/synapse-core/warm-storage'
import { Synapse } from '@filoz/synapse-sdk'
import { CHAINS, type Login } from './login.ts'

/** What every Attic session key is authorized for. */
const PERMISSIONS = [CreateDataSetPermission, AddPiecesPermission, SchedulePieceRemovalsPermission]

/** Tags Attic's data sets, apart from other apps' data sets on the same wallet. */
const SOURCE = 'attic'

/** One stored copy of a piece. Ids are decimal strings, since JSON has no bigint. */
export type Copy = { providerId: string; dataSetId: string; pieceId: string }

/** The owner's account. USDFC in base units (18 decimals). */
export type Account = { storageApproved: boolean; availableFunds: bigint }

/** The owner's account, and the deposit it lacks to store more bytes. */
export type Quote = Account & { depositNeeded: bigint }

/** A piece in Attic's data sets, readable by byte range without downloading all of it. */
export type StoredPiece = {
  pieceCid: string
  /** Bytes of the encrypted piece. */
  size: number
  copies: Copy[]
  /** The `length` bytes from `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>
}

export type Stored = { pieceCid: string; copies: Copy[] }

/** Attic's pieces on Filecoin, as one login reaches them. */
export type Storage = {
  /** Unix seconds until which the owner authorized the session key to store pieces; 0 when never. */
  authorizedUntil(): Promise<number>
  account(): Promise<Account>
  quote(sizes: readonly number[]): Promise<Quote>
  /** Commits the envelopes in one add-pieces call where they fit, settling each once it is committed on chain. */
  storeBatch(envelopes: readonly Uint8Array[]): Promise<PromiseSettledResult<Stored>[]>
  /** Schedules the providers to remove these copies, in one call per data set. */
  scheduleRemoval(copies: readonly Copy[]): Promise<void>
  download(pieceCid: string): Promise<Uint8Array>
  /** Every piece in the owner's Attic data sets under this login's group key. */
  pieces(): Promise<StoredPiece[]>
}

/** Reaches Attic's storage for `login`, reporting slow steps to `progress`. */
export type Connect = (login: Login, progress: (line: string) => void) => Storage

export const synapseStorage: Connect = (login, progress) => {
  const owner = login.grant.owner
  const chain = CHAINS[login.keyholder.network]
  const sessionKey = fromSecp256k1({ privateKey: login.sessionKey, root: owner, chain })
  let synced: Promise<void> | undefined
  const sync = () => {
    synced ??= sessionKey.syncExpirations(PERMISSIONS)
    return synced
  }
  // Quote and store share one provider choice, so the quoted provider is the one that stores.
  let uploads: ReturnType<typeof openUploads> | undefined
  async function openUploads() {
    await sync()
    const synapse = Synapse.create({
      account: owner,
      chain,
      sessionKey,
      requiredPermissions: PERMISSIONS,
      source: SOURCE,
      pieceBatching: { wait: { kind: 'limiter' } },
    })
    const metadata = {
      source: SOURCE,
      'foc/enc': '1',
      [KEYSPACE_ID_KEY]: login.grant.grant.keyspace,
      [COMMITMENT_KEY]: commitment(login.grant.key),
    }
    const dataSets = await Array.fromAsync(
      paginate(({ cursor }) => getPdpDataSets(synapse.client, { address: owner, cursor }))
    )
    // The SDK's choice among data sets that can still take pieces: live, managed and not terminated.
    const known = findMatchingDataSets(dataSets, metadata, chain.legacyPieceStorageIdLimit)[0]?.dataSetId
    // One copy for v1; explicit IDs prevent a provider outage from creating another data set.
    const contexts = await synapse.storage.createContexts({
      copies: 1,
      metadata,
      ...(known === undefined ? {} : { dataSetIds: [known] }),
    })
    return { synapse, contexts }
  }
  const getUploads = () => {
    uploads ??= openUploads()
    return uploads
  }
  // Reads and downloads need no session key, so they work before the owner authorizes it.
  let reader: Synapse | undefined
  const getReader = () => {
    reader ??= Synapse.create({ account: owner, chain, source: SOURCE })
    return reader
  }

  async function storeBatch(envelopes: readonly Uint8Array[]): Promise<PromiseSettledResult<Stored>[]> {
    if (envelopes.length === 0) return []
    const { synapse, contexts } = await getUploads()
    async function uploadBatch(batch: readonly Uint8Array[]): Promise<PromiseSettledResult<Stored>[]> {
      if (batch.length === 0) return []
      const tasks: Promise<Stored>[] = []
      const queue = batch.entries()
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (const [index, envelope] of queue) {
            const parked = Promise.withResolvers<void>()
            const result = synapse.storage
              .upload(envelope, {
                contexts,
                callbacks: {
                  onStored: (providerId, pieceCid) => {
                    progress(`Stored on provider ${providerId} as piece ${pieceCid}`)
                    parked.resolve()
                  },
                  onPiecesAdded: (hash, providerId) =>
                    progress(`Committing on provider ${providerId}, transaction ${hash}`),
                  onPiecesConfirmed: (dataSetId, providerId) =>
                    progress(`Committed on provider ${providerId} in data set ${dataSetId}`),
                },
              })
              .then((result) => {
                if (!result.complete || result.copies.length !== contexts.length) {
                  throw new Error('The upload did not commit all configured copies. Retry the backup.')
                }
                return {
                  pieceCid: result.pieceCid.toString(),
                  copies: result.copies.map((copy) => ({
                    providerId: String(copy.providerId),
                    dataSetId: String(copy.dataSetId),
                    pieceId: String(copy.pieceId),
                  })),
                }
              })
            void result.then(
              () => parked.resolve(),
              () => parked.resolve()
            )
            tasks[index] = result
            await parked.promise
          }
        })
      )
      // Upload failures still leave the other parked pieces to commit.
      await synapse.storage.flush().catch((error: unknown) => {
        progress(`Batch commit failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return Promise.allSettled(tasks)
    }
    const results: PromiseSettledResult<Stored>[] = []
    let next = 0
    // Establish the data set before parallel uploads can try to create it.
    while (next < envelopes.length && contexts.some((context) => context.dataSetId === undefined)) {
      results.push(...(await uploadBatch(envelopes.slice(next, next + 1))))
      next++
    }
    results.push(...(await uploadBatch(envelopes.slice(next))))
    return results
  }

  return {
    async authorizedUntil() {
      await sync()
      return Math.min(...PERMISSIONS.map((permission) => Number(sessionKey.expirations[permission])))
    },
    async account() {
      const { client } = getReader()
      const [storageApproved, account] = await Promise.all([
        isFwssMaxApproved(client, { clientAddress: owner }),
        getAccountSummary(client, { address: owner }),
      ])
      return { storageApproved, availableFunds: account.availableFunds }
    },
    async quote(sizes) {
      const { synapse, contexts } = await getUploads()
      progress(`Checking funds for provider ${contexts.map((context) => context.provider.id).join(', ')}`)
      const [costs, account] = await Promise.all([
        synapse.storage.calculateMultiContextCosts(contexts, {
          pieceSizes: sizes.map((bytes) => BigInt(bytes)),
        }),
        getAccountSummary(synapse.client, { address: owner }),
      ])
      return {
        storageApproved: !costs.needsFwssMaxApproval,
        depositNeeded: costs.depositNeeded,
        availableFunds: account.availableFunds,
      }
    },
    storeBatch,
    async scheduleRemoval(copies) {
      const { synapse } = await getUploads()
      const groups = Map.groupBy(copies, (copy) => copy.dataSetId)
      for (const [id, held] of groups) {
        const context = await synapse.storage.createContext({ dataSetId: BigInt(id) })
        const hash = await context.deletePieces({ pieces: held.map((copy) => BigInt(copy.pieceId)) })
        progress(`Scheduled old pieces for removal from data set ${id}, transaction ${hash}`)
      }
    },
    download(pieceCid) {
      return getReader().storage.download({ pieceCid })
    },
    async pieces() {
      const { client } = getReader()
      const groupKey = login.keyholder.groupKey.toLowerCase()
      const found = new Map<string, StoredPiece>()
      for await (const dataSet of paginate(({ cursor }) => getPdpDataSets(client, { address: owner, cursor }))) {
        const { metadata } = dataSet
        if (!dataSet.live || metadata.source !== SOURCE || metadata[KEYSPACE_ID_KEY]?.toLowerCase() !== groupKey)
          continue
        for await (const piece of paginate(({ cursor }) => getPieces(client, { dataSet, address: owner, cursor }))) {
          const pieceCid = piece.cid.toString()
          const copy = {
            providerId: String(dataSet.providerId),
            dataSetId: String(dataSet.dataSetId),
            pieceId: String(piece.id),
          }
          const known = found.get(pieceCid)
          if (known !== undefined) {
            known.copies.push(copy)
            continue
          }
          const { url } = piece
          found.set(pieceCid, {
            pieceCid,
            size: piece.cid.size,
            copies: [copy],
            read: async (offset, length) => {
              if (url === null) throw new Error(`no provider serves piece ${pieceCid} now`)
              return readRange(url, offset, length)
            },
          })
        }
      }
      return [...found.values()]
    },
  }
}

async function readRange(url: string, offset: number, length: number): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } })
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  const bytes = await response.bytes()
  // A server that ignores Range sends the whole piece with 200.
  return response.status === 206 ? bytes : bytes.subarray(offset, offset + length)
}
