/**
 * Push a fresh display balance to the session chart when money is credited
 * outside Dashboard's refresh loop (BRC-29 internalize during unlock, inbox
 * poll, etc.).
 *
 * Events are identity-stamped so an abandoned ingest for a prior vault account
 * cannot paint that account's balance onto the active child/root.
 */
export const DISPLAY_BALANCE_REFRESH_EVENT = 'handcash:balance-refreshed'

export type DisplayBalanceRefreshDetail = {
  balanceSats: number
  /** Vault account the figure belongs to; omit/null = legacy unscoped. */
  identityKey?: string | null
}

export function publishDisplayBalanceRefresh(
  balanceSats: number,
  identityKey?: string | null,
): void {
  if (!Number.isSafeInteger(balanceSats) || balanceSats < 0) return
  if (typeof document === 'undefined') return
  document.dispatchEvent(
    new CustomEvent(DISPLAY_BALANCE_REFRESH_EVENT, {
      detail: {
        balanceSats,
        identityKey: identityKey ?? null,
      } satisfies DisplayBalanceRefreshDetail,
    }),
  )
}
