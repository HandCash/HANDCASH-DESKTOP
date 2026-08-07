/**
 * User-facing toasts for collectable landings.
 *
 * Receive fires as soon as a tip is first seen (imported or latch-proven and
 * still awaiting an origin). Verify fires later when authenticity settles —
 * unless the tip was already proven at the moment it was announced as received.
 */
import { toastSuccess } from './toast'
import { isItemProven } from './provenCache'

const ANNOUNCED_MAX = 500
const receivedThisSession = new Set<string>()
const verifiedThisSession = new Set<string>()

function normalize(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

function note(set: Set<string>, outpoint: string): boolean {
  const key = normalize(outpoint)
  if (!key || set.has(key)) return false
  set.add(key)
  if (set.size <= ANNOUNCED_MAX) return true
  const drop = set.size - ANNOUNCED_MAX
  let i = 0
  for (const existing of set) {
    if (i++ >= drop) break
    set.delete(existing)
  }
  return true
}

/** True the first time this tip is announced as received this session. */
export function noteItemReceived(outpoint: string): boolean {
  return note(receivedThisSession, outpoint)
}

export function wasItemReceivedAnnounced(outpoint: string): boolean {
  return receivedThisSession.has(normalize(outpoint))
}

/**
 * Toast that a tip landed. Call with every newly seen tip outpoint (imports and
 * latch-proven pending tips). Already-proven tips are marked verified so a
 * later authenticity pass does not double-toast.
 */
export function announceItemsReceived(outpoints: string[]): void {
  const fresh: string[] = []
  for (const op of outpoints) {
    if (!noteItemReceived(op)) continue
    fresh.push(normalize(op))
    if (isItemProven(op)) note(verifiedThisSession, op)
  }
  if (fresh.length === 0) return
  const allProven = fresh.every((op) => isItemProven(op))
  toastSuccess(
    fresh.length === 1 ? 'Item received' : 'Items received',
    allProven
      ? fresh.length === 1
        ? 'Authenticity verified'
        : `${fresh.length} collectables · authenticity verified`
      : fresh.length === 1
        ? 'Verifying authenticity…'
        : `${fresh.length} collectables`,
  )
}

/**
 * Toast when authenticity newly settles for a tip.
 * If receive was never announced (remittance path, etc.), announce that first.
 */
export function announceItemVerified(
  outpoint: string,
  detail?: string | null,
): void {
  const key = normalize(outpoint)
  if (!key) return
  if (!receivedThisSession.has(key)) {
    noteItemReceived(key)
    toastSuccess('Item received', 'Verifying authenticity…')
  }
  if (!note(verifiedThisSession, key)) return
  toastSuccess('Item verified', detail?.trim() || 'Authenticity proven on chain')
}
