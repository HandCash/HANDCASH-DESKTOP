/**
 * Viewing a vault account another device holds.
 *
 * Viewing never moves an account and never builds a signing Toolbox for it:
 * the open runtime stays on the account this device holds, and the viewed
 * account paints only its identity-scoped cached balance (with its age), or
 * "unavailable" when none was ever read here. Never an invented zero.
 *
 * Spending from a viewed account moves it here quietly first
 * (`takeViewedAccountForSpend`): move, then switch, then the arrival merge.
 * Any failure throws before the switch completes the fence, so no spend can
 * run on an account this device does not hold. The `switchVaultAccount` and
 * `setActiveVaultAccountIndex` holding guards stay in force throughout.
 *
 * Shared `src/` layer: no desktop-only assumptions (Mobile inherits it).
 */
import { appendAppLog } from './appLog'
import { readTrustedBalanceSnapshot } from './balanceSnapshot'
import type { Chain } from './vault'
import type { VaultMaster } from './vaultMaster'

export type AccountView = {
  masterIdentityKey: string
  accountIndex: number
  identityKey: string
  chain: Chain
  name: string
}

/** Display-only balance for a viewed account. Never spend authority. */
export type AccountViewBalance =
  | { kind: 'cached'; sats: number; readAt: number }
  | { kind: 'unavailable' }

let current: AccountView | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getAccountView(): AccountView | null {
  return current
}

export function viewAccount(view: AccountView): void {
  current = { ...view }
  emit()
}

export function clearAccountView(): void {
  if (current == null) return
  current = null
  emit()
}

export function subscribeAccountView(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function accountViewBalance(view: Pick<AccountView, 'identityKey' | 'chain'>): AccountViewBalance {
  const snapshot = readTrustedBalanceSnapshot(view.identityKey, view.chain)
  return snapshot ? { kind: 'cached', sats: snapshot.sats, readAt: snapshot.readAt } : { kind: 'unavailable' }
}

export type TakeForSpendSteps<W> = {
  move: (args: { master: VaultMaster; index: number }) => Promise<{ ok: true } | { ok: false; message: string }>
  /** Open the moved account; the holding guard refuses it unless the move landed. */
  switchTo: (index: number) => Promise<W>
  /** Merge the history the previous holder flushed; throws if it cannot be trusted. */
  arrive: () => Promise<void>
}

const inFlight = new Map<string, Promise<unknown>>()

type OpenWallet = Awaited<ReturnType<typeof import('./session').switchVaultAccount>>

/**
 * Production steps: `moveAccountHere`, then `switchVaultAccount` from the open
 * account (its holding guard refuses unless the move landed), then the
 * fail-closed arrival merge. `onSwitched` paints the new account.
 */
export async function defaultTakeSteps(
  from: { vaultMaster: VaultMaster; handle: string; chain: Chain; mnemonic?: string | null },
  onSwitched: (wallet: OpenWallet) => void,
): Promise<TakeForSpendSteps<OpenWallet>> {
  const [{ moveAccountHere }, { switchVaultAccount }, { mergeArrivedForSpend }] = await Promise.all([
    import('./accountMove'),
    import('./session'),
    import('./spendArrival'),
  ])
  return {
    move: async ({ master, index }) => {
      const result = await moveAccountHere({ master, index })
      return result.kind === 'moved' ? { ok: true } : { ok: false, message: result.message }
    },
    switchTo: async (index) => {
      const wallet = await switchVaultAccount({ ...from, accountIndex: index })
      onSwitched(wallet)
      return wallet
    },
    arrive: mergeArrivedForSpend,
  }
}

/**
 * Bring the viewed account here so a spend can run from it. Resolves with the
 * switched-to wallet once this device holds it and its history is merged;
 * rejects with plain copy otherwise, leaving the current account open.
 */
export function takeViewedAccountForSpend<W>(
  args: { view: AccountView; master: VaultMaster },
  steps: TakeForSpendSteps<W>,
): Promise<W> {
  const key = args.view.identityKey
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<W>
  const run = (async () => {
    appendAppLog('info', `[account-holding] spend from viewed a${args.view.accountIndex} — moving it here`)
    const moved = await steps.move({ master: args.master, index: args.view.accountIndex })
    if (!moved.ok) throw new Error(moved.message)
    const wallet = await steps.switchTo(args.view.accountIndex)
    // A merge that fails leaves coins the old holder may already have spent;
    // the spend-time refusal re-checks holding before anything signs.
    await steps.arrive()
    if (current?.identityKey === key) clearAccountView()
    return wallet
  })().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, run)
  return run
}
