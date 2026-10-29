import { encodeDelivery, grantDescriptor, keyspaceKeys, publicKeyOf, rootClaim, wrapTo } from '@filoz/keysmith'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// The well-known Anvil development keys #0 to #2: public, never funded anywhere real.
export const OWNER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const STRANGER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
export const SESSION_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

export const CALIBRATION = 314159
export const GROUP_KEY: Hex = '0x02ca08cf7e0222c8432adc159232b7eb'

/** 2100-01-01. */
const FAR_FUTURE = 4102444800

type GrantInput = {
  ownerKey?: Hex
  sessionKey?: Hex
  chainId?: number
  expires?: number
  node?: 'keyspace' | `scope:${string}`
}

/** A Grant (`fgr1_…`) for `sessionKey`, made the way the console makes one. */
export async function makeGrant(input: GrantInput = {}): Promise<string> {
  const owner = privateKeyToAccount(input.ownerKey ?? OWNER_KEY)
  const sessionKey = input.sessionKey ?? SESSION_KEY
  const node = input.node ?? 'keyspace'
  const ref = { owner: owner.address, keyspace: GROUP_KEY }
  const { kk } = await keyspaceKeys(owner, ref)
  const { chain, nodeKey } = await rootClaim(owner, {
    ...ref,
    chainId: BigInt(input.chainId ?? CALIBRATION),
    kk,
    node,
    bearer: privateKeyToAccount(sessionKey).address,
    maxDepth: 0,
    expires: input.expires ?? FAR_FUTURE,
  })
  const grant = await wrapTo(publicKeyOf(sessionKey), nodeKey, grantDescriptor(ref, node))
  return `fgr1_${Buffer.from(encodeDelivery(chain, grant)).toString('base64url')}`
}
