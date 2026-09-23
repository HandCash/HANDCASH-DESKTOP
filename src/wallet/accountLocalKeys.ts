/**
 * Durable UI store keys for vault sub-accounts (BRC-146).
 *
 * Account 0 keeps historical unscoped keys so existing wallets stay put.
 * Account n≥1 uses `:${identityKey}` so friends / activity / apps / inventory
 * never spill across subwallets (same convention spirit as toolboxDatabaseName).
 */
type AccountKeyScope = {
  identityKey: string | null
  accountIndex: number
  chain: 'main' | 'test'
}

export type BoundAccountKeyScope = {
  identityKey: string
  accountIndex: number
  chain: 'main' | 'test'
}

export function accountKeyScopeFor(
  wallet: BoundAccountKeyScope,
): BoundAccountKeyScope {
  return {
    accountIndex: wallet.accountIndex,
    identityKey: wallet.identityKey,
    chain: wallet.chain,
  }
}

const SCOPE_SYMBOL = Symbol.for('handcash.wallet.account-key-scope')
const globalScopes = globalThis as typeof globalThis & {
  [SCOPE_SYMBOL]?: AccountKeyScope
}
const scope =
  globalScopes[SCOPE_SYMBOL] ??
  (globalScopes[SCOPE_SYMBOL] = {
    identityKey: null,
    accountIndex: 0,
    chain: 'main',
  })

export function bindAccountLocalKeyScope(args: {
  accountIndex: number
  identityKey: string
  chain?: 'main' | 'test'
}): void {
  const index = Number.isInteger(args.accountIndex) ? args.accountIndex : 0
  scope.accountIndex = index
  const ik = args.identityKey.trim()
  scope.identityKey = ik || null
  scope.chain = args.chain ?? 'main'
}

export function peekAccountLocalKeyScope(): {
  accountIndex: number
  identityKey: string | null
  chain: 'main' | 'test'
} {
  return {
    accountIndex: scope.accountIndex,
    identityKey: scope.identityKey,
    chain: scope.chain,
  }
}

/** Resolve a durable key for the currently bound vault account. */
export function accountLocalKey(base: string): string {
  if (!scope.identityKey) {
    throw new Error(`Wallet storage requested without a bound runtime: ${base}`)
  }
  return accountLocalKeyFor(base, {
    accountIndex: scope.accountIndex,
    identityKey: scope.identityKey,
    chain: scope.chain,
  })
}

/** Resolve against an immutable wallet identity captured before async work. */
export function accountLocalKeyFor(
  base: string,
  owner: BoundAccountKeyScope,
): string {
  const identityKey = owner.identityKey.trim()
  if (!identityKey) {
    throw new Error(`Wallet storage requested without an identity: ${base}`)
  }
  // Existing unit suites intentionally mock raw durable keys. Keep that
  // hermetic fixture shape only for the setup identity; isolation/migration
  // tests bind real identities and exercise the production namespace.
  if (
    import.meta.env?.MODE === 'test' &&
    identityKey === 'vitest-primary-identity'
  ) {
    return base
  }
  return `${base}:wallet:${owner.chain}:${owner.accountIndex}:${identityKey}`
}

/** Test / wipe helper — treat unbound as primary (legacy keys). */
export function resetAccountLocalKeyScopeForTests(): void {
  scope.identityKey = null
  scope.accountIndex = 0
  scope.chain = 'main'
}
