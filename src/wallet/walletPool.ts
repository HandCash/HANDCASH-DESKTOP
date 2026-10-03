/**
 * Warm vault-account wallets (BRC-146).
 *
 * Every booted account is a self-contained unit: its own Toolbox IndexedDB,
 * services and monitor. Units share no mutable state — account-local durable
 * keys carry the unit's identity, and only the selected unit binds the ambient
 * account scope (`accountLocalStores`). That is what lets them run side by side:
 *
 * - Selecting an account reuses its unit instead of rebuilding the Toolbox,
 *   reinstalling services and reopening IndexedDB on every switch.
 * - An unselected unit keeps its monitor running, so its own transactions keep
 *   proving while another account is in the foreground.
 * - Foreground-only work (Activity, inventory, ingest) still belongs to the
 *   runtime, which is disposed on every switch exactly as before.
 *
 * Locking clears the pool; no unit outlives the unlocked vault.
 */
import type { ActiveWallet } from './session'

/** Units beyond this are evicted least-recently-selected first, never the selected one. */
export const MAX_WARM_WALLETS = 6

export type WarmWalletUnit = {
  /** `chain:accountIndex:identityKey` — one unit per vault account. */
  key: string
  /** Toolbox database the unit opened; a recovery that selects another one rebuilds it. */
  databaseName: string
}

type Entry = {
  unit: WarmWalletUnit
  wallet: Promise<ActiveWallet>
  usedAt: number
}

const units = new Map<string, Entry>()
let selectedKey: string | null = null
let poolGeneration = 0
let clock = 0

export function warmWalletUnit(args: {
  chain: string
  accountIndex: number
  identityKey: string
  databaseName: string
}): WarmWalletUnit {
  return {
    key: `${args.chain}:${args.accountIndex}:${args.identityKey}`,
    databaseName: args.databaseName,
  }
}

function stopMonitor(entry: Entry): void {
  void entry.wallet.then(
    (wallet) => {
      try {
        wallet.monitor?.stopTasks?.()
      } catch {
        // optional
      }
    },
    () => {},
  )
}

function drop(key: string): void {
  const entry = units.get(key)
  if (!entry) return
  units.delete(key)
  if (selectedKey === key) selectedKey = null
  stopMonitor(entry)
}

function evictOverflow(): void {
  while (units.size > MAX_WARM_WALLETS) {
    let oldest: Entry | null = null
    for (const entry of units.values()) {
      if (entry.unit.key === selectedKey) continue
      if (!oldest || entry.usedAt < oldest.usedAt) oldest = entry
    }
    if (!oldest) return
    drop(oldest.unit.key)
  }
}

export function hasWarmWallet(unit: WarmWalletUnit): boolean {
  return units.get(unit.key)?.unit.databaseName === unit.databaseName
}

/**
 * The unit's wallet, building it once. Concurrent callers share one build; a
 * build that fails leaves no entry behind, and one that finishes after the
 * vault locked is stopped and refused.
 */
export function warmWallet(
  unit: WarmWalletUnit,
  build: () => Promise<ActiveWallet>,
): Promise<ActiveWallet> {
  const hit = units.get(unit.key)
  if (hit && hit.unit.databaseName === unit.databaseName) {
    hit.usedAt = ++clock
    return hit.wallet
  }
  if (hit) drop(unit.key)
  const generation = poolGeneration
  const wallet = build().then((built) => {
    if (generation === poolGeneration) return built
    try {
      built.monitor?.stopTasks?.()
    } catch {
      // optional
    }
    throw new DOMException('Wallet locked while it was starting', 'AbortError')
  })
  const entry: Entry = { unit, wallet, usedAt: ++clock }
  units.set(unit.key, entry)
  wallet.catch(() => {
    if (units.get(unit.key) === entry) units.delete(unit.key)
  })
  evictOverflow()
  return wallet
}

/** Build the unit fresh: unlock and history restore must not reuse a stale Toolbox. */
export function replaceWarmWallet(
  unit: WarmWalletUnit,
  build: () => Promise<ActiveWallet>,
): Promise<ActiveWallet> {
  drop(unit.key)
  return warmWallet(unit, build)
}

export function markWarmWalletSelected(unit: WarmWalletUnit): void {
  selectedKey = unit.key
  const entry = units.get(unit.key)
  if (entry) entry.usedAt = ++clock
}

/** Lock / wipe: stop every unit's monitor and forget them all. */
export function clearWarmWallets(): void {
  poolGeneration += 1
  for (const key of [...units.keys()]) drop(key)
  selectedKey = null
}

/** Same generation means the vault has not locked since `generation` was read. */
export function warmPoolGeneration(): number {
  return poolGeneration
}

export function warmWalletKeys(): string[] {
  return [...units.keys()]
}
