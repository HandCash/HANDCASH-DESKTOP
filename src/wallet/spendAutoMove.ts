/**
 * Spending moves the wallet (draft BRC-249, "Moving on demand").
 *
 * A spend on an account another install holds does not fail: it asks the
 * holder to release, takes the account, merges the history the holder
 * flushed, and only then enters the spend region. The user sees a payment
 * that takes a little longer, not a refusal.
 *
 * Runs before the spend region opens: the arrival merge takes the recompose
 * region, which excludes spends, so doing it inside one would wait on itself.
 * Spends already in flight for the same account share one move.
 */
import { appendAppLog } from './appLog'
import { ACCOUNT_HELD_ELSEWHERE } from './vaultAccounts'
import { activeAccountSpendRefusal } from './vaultAccountHolding'
import type { VaultMaster } from './vaultMaster'
import { assertRuntimeCurrent, getWalletRuntime } from './walletRuntime'

export type SpendAccount = { identityKey: string; accountIndex: number; vaultMaster: VaultMaster }

export type SpendMoveSteps = {
  /** Reject a stale signing intent before it can merge into another account. */
  assertCurrent?: () => void
  move: (account: SpendAccount) => Promise<{ ok: true } | { ok: false; message: string }>
  /** Merge the history the previous holder flushed; throws if it cannot be trusted. */
  arrive: () => Promise<void>
}

const inFlight = new Map<string, Promise<void>>()

async function defaultSteps(account: SpendAccount): Promise<SpendMoveSteps> {
  const runtime = getWalletRuntime()
  if (!runtime) throw new Error('WALLET_LOCKED')
  // The caller may itself have waited across a switch before reaching this gate.
  if (runtime.instance.identityKey !== account.identityKey || runtime.instance.accountIndex !== account.accountIndex) {
    throw new DOMException('Wallet account changed', 'AbortError')
  }
  const [{ moveAccountHere }, { mergeArrivedForSpend }] = await Promise.all([
    import('./accountMove'),
    import('./spendArrival'),
  ])
  return {
    assertCurrent: () => assertRuntimeCurrent(runtime),
    move: async (account) => {
      const result = await moveAccountHere({ master: account.vaultMaster, index: account.accountIndex })
      return result.kind === 'moved' ? { ok: true } : { ok: false, message: result.message }
    },
    arrive: mergeArrivedForSpend,
  }
}

/** True when the refusal is "another device holds it" — the only one a move can cure. */
export function spendNeedsMove(refusal: string | null): boolean {
  return refusal === ACCOUNT_HELD_ELSEWHERE
}

/**
 * For sends that guard themselves (coins, USDC): move the account here first
 * when another install holds it. Any other refusal is left to the caller's own
 * guard. Call before the send takes its own serial lock.
 */
export async function moveIfHeldElsewhere(
  active: { identityKey: string; accountIndex: number; vaultMaster?: VaultMaster | null } | null,
): Promise<void> {
  if (!active?.vaultMaster || !spendNeedsMove(activeAccountSpendRefusal({ ...active, vaultMaster: active.vaultMaster }))) return
  await moveActiveAccountForSpend({ identityKey: active.identityKey, accountIndex: active.accountIndex, vaultMaster: active.vaultMaster })
}

/**
 * Bring the active account here so a spend can run. Resolves once this install
 * holds it and its history is merged; rejects with plain copy when it cannot.
 */
export function moveActiveAccountForSpend(account: SpendAccount, steps?: SpendMoveSteps): Promise<void> {
  // BRC-249 Moving on demand: coalesce only within one runtime generation.
  // A reopened account must not inherit a move belonging to its disposed signer.
  const runtime = steps ? null : getWalletRuntime()
  const key = runtime ? `${account.identityKey}:${account.accountIndex}:${runtime.runtimeId}` : `${account.identityKey}:${account.accountIndex}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const run = (async () => {
    const use = steps ?? (await defaultSteps(account))
    use.assertCurrent?.()
    appendAppLog('info', `[account-holding] spend on a${account.accountIndex} held elsewhere — moving it here`)
    const moved = await use.move(account)
    if (!moved.ok) throw new Error(moved.message)
    // The move may finish after a switch/lock. Never merge into the new scope.
    use.assertCurrent?.()
    // A merge that fails leaves coins the old holder may already have spent.
    await use.arrive()
    use.assertCurrent?.()
    if (activeAccountSpendRefusal(account) != null) {
      throw new Error('This wallet could not be moved here. Try again.')
    }
  })().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, run)
  return run
}
