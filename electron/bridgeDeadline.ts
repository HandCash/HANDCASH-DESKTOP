/**
 * How long the bridge waits for the renderer, per BRC-100 method.
 *
 * A read can be given up on: nothing happened, and the caller can ask again.
 * A spend cannot. `createAction` / `signAction` / `internalizeAction` sign and
 * queue a transaction, so abandoning one does not undo it — the renderer keeps
 * going and may well succeed after the HTTP call has already been answered.
 *
 * A BSV-21 mint studio run hit exactly that: the mint spent an auth tip from a
 * genesis deployed seconds earlier, proof hydration for the unmined ancestry
 * outran the flat 120s deadline, and the studio reported "mint stopped" for a
 * transaction the wallet was still building. So spends get a longer budget, and
 * when even that passes they come back as `WALLET_BRIDGE_PENDING` — "may still
 * land, go and reconcile" — never as a plain failure.
 */

export const BRIDGE_DEADLINE_MS = 120_000
export const SPEND_DEADLINE_MS = 300_000

/** Methods that sign or queue a transaction, so a timeout is not a rollback. */
const SPEND_METHODS = new Set([
  'createaction',
  'signaction',
  'internalizeaction',
])

function methodOf(path: string): string {
  return path.trim().toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '')
}

export function isSpendMethodPath(path: string): boolean {
  return SPEND_METHODS.has(methodOf(path))
}

export function bridgeDeadlineMs(path: string): number {
  return isSpendMethodPath(path) ? SPEND_DEADLINE_MS : BRIDGE_DEADLINE_MS
}

/**
 * `WALLET_BRIDGE_PENDING` tells a client the wallet may still complete the
 * action; `WALLET_BRIDGE_TIMEOUT` means it can be treated as not having run.
 */
export function bridgeDeadlineCode(
  path: string,
): 'WALLET_BRIDGE_PENDING' | 'WALLET_BRIDGE_TIMEOUT' {
  return isSpendMethodPath(path) ? 'WALLET_BRIDGE_PENDING' : 'WALLET_BRIDGE_TIMEOUT'
}

export function bridgeDeadlineMessage(method: string, path: string): string {
  const code = bridgeDeadlineCode(path)
  const ms = bridgeDeadlineMs(path)
  return code === 'WALLET_BRIDGE_PENDING'
    ? `WALLET_BRIDGE_PENDING: ${method} ${path} is still running in the wallet after ${ms}ms — it may still complete; reconcile before retrying`
    : `WALLET_BRIDGE_TIMEOUT: no renderer reply for ${method} ${path} within ${ms}ms`
}
