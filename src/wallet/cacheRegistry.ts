export type WalletCache =
  | 'activity'
  | 'activitySeen'
  | 'collectables'
  | 'connectedApps'
  | 'friends'
  | 'fungibles'
  | 'messages'
  | 'paymentProgress'

type Invalidator = () => void

const invalidators = new Map<WalletCache, Invalidator>()

/** Register once during composition; replacing cache ownership is forbidden. */
export function registerWalletCache(name: WalletCache, invalidate: Invalidator): void {
  if (invalidators.has(name)) {
    throw new Error(`Wallet cache already registered: ${name}`)
  }
  invalidators.set(name, invalidate)
}

export function invalidateWalletCaches(
  names: readonly WalletCache[],
  reason: string,
): void {
  for (const name of names) {
    const invalidate = invalidators.get(name)
    if (!invalidate) throw new Error(`Wallet cache is not registered: ${name} (${reason})`)
    invalidate()
  }
}

export function registeredWalletCaches(): readonly WalletCache[] {
  return [...invalidators.keys()]
}

export function resetWalletCacheRegistryForTests(): void {
  invalidators.clear()
}
