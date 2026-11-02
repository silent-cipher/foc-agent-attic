import { formatUnits, parseUnits } from 'viem'
import type { Network } from './login.ts'
import type { Quote } from './storage.ts'

// The spike's exact deposit left 0 USDFC available, and the next upload then failed.
const MIN_AVAILABLE_USDFC = 1
const SUGGESTED_DEPOSIT_USDFC = 2

/** The console page that deposits USDFC and approves the storage service in one step. */
export function fundingUrl(consoleUrl: string, network: Network): string {
  return `${consoleUrl}/console?deposit=${SUGGESTED_DEPOSIT_USDFC}&operator=fwss&network=${network}`
}

/**
 * Checks the owner's account can pay for the quoted upload and still keep the headroom for the next one.
 *
 * @returns One ✓ or ✗ line per check, whether the funds suffice, and whether every check passed.
 */
export function checkFunding(quote: Quote): { ready: boolean; funded: boolean; lines: string[] } {
  const available = usdfc(quote.availableFunds)
  const short = quote.depositNeeded > 0n
  const headroom = quote.availableFunds >= parseUnits(String(MIN_AVAILABLE_USDFC), 18)
  const funds = short
    ? `✗ ${available} USDFC available, ${usdfc(quote.depositNeeded)} short of this upload`
    : headroom
      ? `✓ ${available} USDFC available`
      : `✗ ${available} USDFC available (keep at least ${MIN_AVAILABLE_USDFC})`
  return {
    ready: quote.storageApproved && !short && headroom,
    funded: !short && headroom,
    lines: [quote.storageApproved ? '✓ Storage service approved' : '✗ Storage service not approved', funds],
  }
}

/** USDFC base units (18 decimals) as a number with two decimals. */
function usdfc(amount: bigint): string {
  return Number(formatUnits(amount, 18)).toFixed(2)
}
