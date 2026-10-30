import { COMMITMENT_KEY, commitment, KEYSPACE_ID_KEY } from '@filoz/keysmith'
import { getAccountSummary } from '@filoz/synapse-core/pay'
import { AddPiecesPermission, CreateDataSetPermission, fromSecp256k1 } from '@filoz/synapse-core/session-key'
import { Synapse } from '@filoz/synapse-sdk'
import { CHAINS, type Login, type Network, SOURCE } from './session.ts'

/** What every Attic session key is authorized for. */
export const PERMISSIONS = [CreateDataSetPermission, AddPiecesPermission]

/** One stored copy of a piece. Ids are decimal strings, since JSON has no bigint. */
export type Copy = { providerId: string; dataSetId: string; pieceId: string }

/** What the owner's account has, and lacks, to store more bytes. USDFC in base units (18 decimals). */
export type Quote = { storageApproved: boolean; depositNeeded: bigint; availableFunds: bigint }

/** Attic's pieces on Filecoin, as one login reaches them. */
export type Storage = {
  /** Whether the owner authorized the session key to store pieces, and that has not expired. */
  isAuthorized(): Promise<boolean>
  quote(size: number): Promise<Quote>
  /** Resolves once the envelope is committed on chain. */
  store(envelope: Uint8Array): Promise<{ pieceCid: string; copies: Copy[] }>
  download(pieceCid: string): Promise<Uint8Array>
}

/** Reaches Attic's storage for `login`, reporting slow steps to `progress`. */
export type Connect = (login: Login, network: Network, progress: (line: string) => void) => Storage

export const synapseStorage: Connect = (login, network, progress) => {
  const owner = login.grant.owner
  const chain = CHAINS[network]
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
      pieceBatching: false,
    })
    // One copy for v1: on calibnet the second provider's copy has stalled at "pending" for the SDK's full wait.
    const contexts = await synapse.storage.createContexts({
      copies: 1,
      // filecoin-pin's tags for an encrypted data set, so the console reads it as one.
      metadata: {
        'foc/enc': '1',
        [KEYSPACE_ID_KEY]: login.grant.grant.keyspace,
        [COMMITMENT_KEY]: commitment(login.grant.key),
      },
    })
    return { synapse, contexts }
  }
  const getUploads = () => {
    uploads ??= openUploads()
    return uploads
  }

  return {
    async isAuthorized() {
      await sync()
      return sessionKey.hasPermissions(PERMISSIONS)
    },
    async quote(size) {
      const { synapse, contexts } = await getUploads()
      progress(`Checking funds for provider ${contexts.map((context) => context.provider.id).join(', ')}`)
      const [costs, account] = await Promise.all([
        synapse.storage.calculateMultiContextCosts(contexts, { pieceSizes: [BigInt(size)] }),
        getAccountSummary(synapse.client, { address: owner }),
      ])
      return {
        storageApproved: !costs.needsFwssMaxApproval,
        depositNeeded: costs.depositNeeded,
        availableFunds: account.availableFunds,
      }
    },
    async store(envelope) {
      const { synapse, contexts } = await getUploads()
      const result = await synapse.storage.upload(envelope, {
        contexts,
        callbacks: {
          onStored: (providerId, pieceCid) => progress(`Stored on provider ${providerId} as piece ${pieceCid}`),
          onPiecesAdded: (hash, providerId) => progress(`Committing on provider ${providerId}, transaction ${hash}`),
          onPiecesConfirmed: (dataSetId, providerId) =>
            progress(`Committed on provider ${providerId} in data set ${dataSetId}`),
        },
      })
      return {
        pieceCid: result.pieceCid.toString(),
        copies: result.copies.map((copy) => ({
          providerId: String(copy.providerId),
          dataSetId: String(copy.dataSetId),
          pieceId: String(copy.pieceId),
        })),
      }
    },
    download(pieceCid) {
      return Synapse.create({ account: owner, chain, source: SOURCE }).storage.download({ pieceCid })
    },
  }
}
