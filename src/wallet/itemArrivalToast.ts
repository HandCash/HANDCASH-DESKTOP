/**
 * User-facing toasts for collectable landings.
 *
 * Receive fires when a tip paints in inventory — not when ingest/classify first
 * sees it on the address. Verify fires later when authenticity settles — unless
 * the tip was already proven before receive was announced, in which case receive
 * carries the verified copy alone.
 *
 * Announced receives are durable: unlock must not re-toast "Item received /
 * Authenticity verified" for foxes that were proven days ago.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import { toastSuccess } from './toast'
import { isItemProven } from './provenCache'
import {
  clearAwaitingVerification,
  noteAwaitingVerification,
} from './verificationProgress'
import { noteInboundReceiveComplete } from './appActivity'

const ANNOUNCED_MAX = 500
const DURABLE_RECEIVE_KEY = 'handcash.items.receiveAnnounced.v1'
const DURABLE_RECEIVE_MAX = 2_000

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

function loadDurableReceives(): Set<string> {
  try {
    const raw = durableGetItem(DURABLE_RECEIVE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed
        .filter((v): v is string => typeof v === 'string' && !!v.trim())
        .map(normalize),
    )
  } catch {
    return new Set()
  }
}

function persistDurableReceives(set: Set<string>): void {
  try {
    const values = [...set]
    const trimmed =
      values.length > DURABLE_RECEIVE_MAX
        ? values.slice(values.length - DURABLE_RECEIVE_MAX)
        : values
    durableSetItem(DURABLE_RECEIVE_KEY, JSON.stringify(trimmed))
  } catch {
    // Toast dedupe must never break ingest.
  }
}

/** True the first time this tip is announced as received (session + durable). */
export function noteItemReceived(outpoint: string): boolean {
  const key = normalize(outpoint)
  if (!key) return false
  if (!note(receivedThisSession, key)) return false
  const durable = loadDurableReceives()
  if (durable.has(key)) return false
  durable.add(key)
  persistDurableReceives(durable)
  return true
}

export function wasItemReceivedAnnounced(outpoint: string): boolean {
  const key = normalize(outpoint)
  if (receivedThisSession.has(key)) return true
  return loadDurableReceives().has(key)
}

/**
 * Toast that a tip landed in inventory. Starts the corner spinner for unproven
 * tips. Call from the collectables cache once the card is on the list — not
 * from address classify / ingest.
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
  // Inventory authenticity is settled — Activity must not stay on Verifying…
  const txid = key.split('.')[0] ?? ''
  if (/^[0-9a-f]{64}$/i.test(txid)) {
    noteInboundReceiveComplete({
      txid: txid.toLowerCase(),
      item: true,
      outpoint: key,
    })
  }
  if (!wasItemReceivedAnnounced(outpoint)) {
    // Receive toast still ahead — do not toast verify first.
    note(verifiedThisSession, key)
    return
  }
  if (!note(verifiedThisSession, key)) return
  toastSuccess('Item verified', detail?.trim() || 'Authenticity proven on chain')
}

/** Test helper — clear session + durable announce state. */
export function resetItemArrivalAnnouncementsForTests(): void {
  receivedThisSession.clear()
  verifiedThisSession.clear()
  try {
    durableSetItem(DURABLE_RECEIVE_KEY, '[]')
  } catch {
    // ignore
  }
}
