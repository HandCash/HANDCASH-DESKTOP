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

export type SpendAccount = { identityKey: string; accountIndex: number; vaultMaster: VaultMaster }

export type SpendMoveSteps = {
  move: (account: SpendAccount) => Promise<{ ok: true } | { ok: false; message: string }>
  /** Merge the history the previous holder flushed; throws if it cannot be trusted. */
  arrive: () => Promise<void>
}

const inFlight = new Map<string, Promise<void>>()

async function defaultSteps(): Promise<SpendMoveSteps> {
  const [{ moveAccountHere }, { mergeArrivedForSpend }] = await Promise.all([
    import('./accountMove'),
    import('./spendArrival'),
  ])
  return {
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
  const existing = inFlight.get(account.identityKey)
  if (existing) return existing
  const run = (async () => {
    const use = steps ?? (await defaultSteps())
    appendAppLog('info', `[account-holding] spend on a${account.accountIndex} held elsewhere — moving it here`)
    const moved = await use.move(account)
    if (!moved.ok) throw new Error(moved.message)
    // A merge that fails leaves coins the old holder may already have spent.
    await use.arrive()
    if (activeAccountSpendRefusal(account) != null) {
      throw new Error('This wallet could not be moved here. Try again.')
    }
  })().finally(() => {
    inFlight.delete(account.identityKey)
  })
  inFlight.set(account.identityKey, run)
  return run
}
