/**
 * Durable UI store keys for vault sub-accounts (BRC-146).
 *
 * Account 0 keeps historical unscoped keys so existing wallets stay put.
 * Account n≥1 uses `:${identityKey}` so friends / activity / apps / inventory
 * never spill across subwallets (same convention spirit as toolboxDatabaseName).
 */
let boundIdentityKey: string | null = null
let boundAccountIndex = 0

export function bindAccountLocalKeyScope(args: {
  accountIndex: number
  identityKey: string
}): void {
  const index = Number.isInteger(args.accountIndex) ? args.accountIndex : 0
  boundAccountIndex = index
  const ik = args.identityKey.trim()
  boundIdentityKey = index <= 0 || !ik ? null : ik
}

export function peekAccountLocalKeyScope(): {
  accountIndex: number
  identityKey: string | null
} {
  return { accountIndex: boundAccountIndex, identityKey: boundIdentityKey }
}

/** Resolve a durable key for the currently bound vault account. */
export function accountLocalKey(base: string): string {
  if (!boundIdentityKey) return base
  return `${base}:${boundIdentityKey}`
}

/** Test / wipe helper — treat unbound as primary (legacy keys). */
export function resetAccountLocalKeyScopeForTests(): void {
  boundIdentityKey = null
  boundAccountIndex = 0
}
