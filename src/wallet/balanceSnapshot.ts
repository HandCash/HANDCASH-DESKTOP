/**
 * Last successfully read display balance, used only while a cold wallet opens
 * or a vault account switch paints before the local toolbox read returns.
 *
 * This is identity-scoped stale UI state, not custody and never spend
 * authority. Confirm/send paths still read Toolbox and fail closed.
 *
 * Each identity+chain has its own durable key so vault sibling credit cannot
 * clobber the sender's trusted snapshot (and switch can paint instantly).
 */
import type { Chain } from './vault'
import { durableGetItem, durableSetItem } from './durableStorage'

const LEGACY_BALANCE_KEY = 'handcash.balance.lastTrusted'

type TrustedBalanceSnapshot = {
  identityKey: string
  chain: Chain
  sats: number
  readAt: number
}

function balanceKey(identityKey: string, chain: Chain): string {
  return `handcash.balance.lastTrusted:${chain}:${identityKey}`
}

function parseSnapshot(raw: string | null): TrustedBalanceSnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<TrustedBalanceSnapshot>
    const sats = Number(parsed.sats)
    if (
      typeof parsed.identityKey !== 'string' ||
      !parsed.identityKey ||
      (parsed.chain !== 'main' && parsed.chain !== 'test') ||
      !Number.isSafeInteger(sats) ||
      sats < 0
    ) {
      return null
    }
    return {
      identityKey: parsed.identityKey,
      chain: parsed.chain,
      sats,
      readAt: Number(parsed.readAt) || 0,
    }
  } catch {
    return null
  }
}

export function readTrustedBalance(
  identityKey: string,
  chain: Chain,
): number | null {
  if (!identityKey) return null
  const scoped = parseSnapshot(durableGetItem(balanceKey(identityKey, chain)))
  if (scoped && scoped.identityKey === identityKey && scoped.chain === chain) {
    return scoped.sats
  }
  // Legacy single-slot snapshot (pre multi-account).
  const legacy = parseSnapshot(durableGetItem(LEGACY_BALANCE_KEY))
  if (legacy && legacy.identityKey === identityKey && legacy.chain === chain) {
    return legacy.sats
  }
  return null
}

export function writeTrustedBalance(
  identityKey: string,
  chain: Chain,
  sats: number,
): void {
  if (!identityKey || !Number.isSafeInteger(sats) || sats < 0) return
  const snapshot: TrustedBalanceSnapshot = {
    identityKey,
    chain,
    sats,
    readAt: Date.now(),
  }
  durableSetItem(balanceKey(identityKey, chain), JSON.stringify(snapshot))
  // Keep legacy slot updated for the most recent write so older readers still
  // see *some* cold-start figure (identity-checked on read).
  durableSetItem(LEGACY_BALANCE_KEY, JSON.stringify(snapshot))
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
