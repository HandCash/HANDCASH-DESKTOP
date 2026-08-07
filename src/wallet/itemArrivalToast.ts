/**
 * User-facing toasts for collectable landings.
 *
 * Receive fires as soon as a tip is first seen. Verify fires later when
 * authenticity settles — unless the tip was already proven before receive was
 * announced, in which case receive carries the verified copy alone.
 */
import { toastSuccess } from './toast'
import { isItemProven } from './provenCache'
import {
  clearAwaitingVerification,
  noteAwaitingVerification,
} from './verificationProgress'

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
 * Toast that a tip landed. Starts the corner spinner for unproven tips.
 * Call as soon as the tip is known — do not wait for authenticity.
 */
export function announceItemsReceived(outpoints: string[]): void {
  const fresh: string[] = []
  for (const op of outpoints) {
    if (!noteItemReceived(op)) continue
    const key = normalize(op)
    fresh.push(key)
    if (isItemProven(op) || verifiedThisSession.has(key)) {
      note(verifiedThisSession, op)
      clearAwaitingVerification(key)
    } else {
      noteAwaitingVerification(key)
    }
  }
  if (fresh.length === 0) return
  const allProven = fresh.every(
    (op) => isItemProven(op) || verifiedThisSession.has(op),
  )
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
 * Toast when authenticity newly settles for a tip that was already announced
 * as received. If receive has not been toasted yet (proven during classify),
 * only record the verdict — announceItemsReceived will include it.
 */
export function announceItemVerified(
  outpoint: string,
  detail?: string | null,
): void {
  const key = normalize(outpoint)
  if (!key) return
  clearAwaitingVerification(key)
  if (!receivedThisSession.has(key)) {
    // Receive toast still ahead — do not toast verify first.
    note(verifiedThisSession, key)
    return
  }
  if (!note(verifiedThisSession, key)) return
  toastSuccess('Item verified', detail?.trim() || 'Authenticity proven on chain')
}
