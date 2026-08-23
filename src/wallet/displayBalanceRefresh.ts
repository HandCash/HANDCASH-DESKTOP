/**
 * Push a fresh display balance to the session chart when money is credited
 * outside Dashboard's refresh loop (BRC-29 internalize during unlock, inbox
 * poll, etc.).
 */
export const DISPLAY_BALANCE_REFRESH_EVENT = 'handcash:balance-refreshed'

export function publishDisplayBalanceRefresh(balanceSats: number): void {
  if (!Number.isSafeInteger(balanceSats) || balanceSats < 0) return
  if (typeof document === 'undefined') return
  document.dispatchEvent(
    new CustomEvent(DISPLAY_BALANCE_REFRESH_EVENT, {
      detail: { balanceSats },
    }),
  )
}
