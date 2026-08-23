/**
 * Last successfully read display balance, used only while a cold wallet opens.
 *
 * This is identity-scoped stale UI state, not custody and never spend
 * authority. Confirm/send paths still read Toolbox and fail closed.
 */
import type { Chain } from './vault'
import { durableGetItem, durableSetItem } from './durableStorage'

const LAST_BALANCE_KEY = 'handcash.balance.lastTrusted'

type TrustedBalanceSnapshot = {
  identityKey: string
  chain: Chain
  sats: number
  readAt: number
}

export function readTrustedBalance(
  identityKey: string,
  chain: Chain,
): number | null {
  try {
    const parsed = JSON.parse(
      durableGetItem(LAST_BALANCE_KEY) ?? '',
    ) as Partial<TrustedBalanceSnapshot>
    const sats = Number(parsed.sats)
    if (
      parsed.identityKey !== identityKey ||
      parsed.chain !== chain ||
      !Number.isSafeInteger(sats) ||
      sats < 0
    ) {
      return null
    }
    return sats
  } catch {
    return null
  }
}

export function writeTrustedBalance(
  identityKey: string,
  chain: Chain,
  sats: number,
): void {
  if (!identityKey || !Number.isSafeInteger(sats) || sats < 0) return
  durableSetItem(
    LAST_BALANCE_KEY,
    JSON.stringify({
      identityKey,
      chain,
      sats,
      readAt: Date.now(),
    } satisfies TrustedBalanceSnapshot),
  )
}

/** An empty local-state read is provisional while BRC-39 is replacing IDB. */
export function shouldKeepTrustedBalance(
  currentSats: number,
  incomingSats: number,
  recomposeInFlight: boolean,
): boolean {
  return currentSats > 0 && incomingSats === 0 && recomposeInFlight
}

/**
 * Confirmed-only toolbox reads omit pending change from live local sends. They
 * must not downgrade the hero or trusted snapshot when a higher display figure
 * is already showing.
 */
export function shouldKeepDisplayBalanceOnConfirmedRead(
  displayedSats: number,
  confirmedSats: number,
): boolean {
  return displayedSats > 0 && confirmedSats < displayedSats
}
