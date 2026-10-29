import { type Grant, openDelivery, writeTarget } from '@filoz/keysmith'
import type { Address, Hex } from 'viem'

/** The Keysmith scope every Attic piece is written under. */
export const SCOPE = 'attic'

/** A Grant opened by this session key: the owner's group key, which the console wrapped to the key. */
export type OpenedGrant = {
  /** The Grant as stored: `fgr1_` and base64url, without whitespace. */
  text: string
  owner: Address
  /** Unix seconds after which the Grant no longer opens. */
  expires: number
  grant: Grant
  key: Uint8Array
}

/**
 * Opens a Grant the console showed for `sessionKey` (`fgr1_` + base64url of a Keysmith delivery)
 * and checks it is for `chainId` and covers the `attic` scope.
 *
 * @throws With the reason the Grant is refused, safe to print.
 */
export async function openGrant(
  text: string,
  sessionKey: Hex,
  chainId: number,
  now = Math.floor(Date.now() / 1000)
): Promise<OpenedGrant> {
  // Consoles and terminals wrap long lines.
  const compact = text.replace(/\s+/g, '')
  if (!/^fgr1_[A-Za-z0-9_-]+$/.test(compact)) {
    throw new Error('This is not a Grant: a Grant starts with fgr1_. Copy it again from the console.')
  }
  let opened: Awaited<ReturnType<typeof openDelivery>>
  try {
    opened = await openDelivery(sessionKey, Buffer.from(compact.slice('fgr1_'.length), 'base64url'), { now })
  } catch (error) {
    throw new Error(`The Grant does not open: ${error instanceof Error ? error.message : String(error)}.`)
  }
  const { claim, grant, key } = opened
  if (claim.chainId !== BigInt(chainId)) {
    throw new Error(`The Grant is for chain id ${claim.chainId}, not ${chainId}.`)
  }
  writeTarget(grant, key, SCOPE)
  return { text: compact, owner: claim.owner, expires: claim.expires, grant, key }
}
