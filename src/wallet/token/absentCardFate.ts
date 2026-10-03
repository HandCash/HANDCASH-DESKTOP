/**
 * A token card the basket stopped listing, past its settle grace.
 *
 * Absence from one read is not proof — the basket lags a receive, and a
 * reinstall can hold a tip on chain that local state lost. The chain decides:
 * every tip spent retires the card; a tip still unspent is reclaimed through
 * the recover-from-transaction import (which only claims outputs that pay this
 * wallet); no answer keeps the card for the next read.
 */
import type { OutpointSpendProbe } from '../createActionInputFate'

export type AbsentCardFate =
  | { kind: 'keep'; reason: 'no-tips' | 'spend-unknown' }
  | { kind: 'retire'; spenders: string[] }
  | { kind: 'reclaim'; txids: string[] }

export function chooseAbsentCardFate(
  tipOutpoints: readonly string[],
  probes: ReadonlyMap<string, OutpointSpendProbe>,
): AbsentCardFate {
  if (tipOutpoints.length === 0) return { kind: 'keep', reason: 'no-tips' }
  const unspent = tipOutpoints.filter((op) => probes.get(op)?.kind === 'unspent')
  if (unspent.length > 0) {
    return { kind: 'reclaim', txids: [...new Set(unspent.map((op) => op.split('.')[0]!))] }
  }
  const spenders = tipOutpoints.flatMap((op) => {
    const probe = probes.get(op)
    return probe?.kind === 'spent' ? [probe.spender] : []
  })
  if (spenders.length === tipOutpoints.length) return { kind: 'retire', spenders }
  return { kind: 'keep', reason: 'spend-unknown' }
}
