import { storageRegistry } from '../storage/registry'
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
import {
  accountLocalKey,
  accountLocalKeyFor,
  peekAccountLocalKeyScope,
  type BoundAccountKeyScope,
} from './accountLocalKeys'
import { toastSuccess } from './toast'
import { isItemProven } from './provenCache'
import {
  clearAwaitingVerification,
  noteAwaitingVerification,
} from './verificationProgress'
import {
  noteInboundReceiveComplete,
  noteInboundReceivePending,
} from './appActivity'

const ANNOUNCED_MAX = 500
const DURABLE_RECEIVE_KEY = storageRegistry.itemReceiveAnnounced.key
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

let cachedReceivesRaw: string | null = null
let cachedReceives = new Set<string>()

function ownerIsCurrent(owner?: BoundAccountKeyScope): boolean {
  if (!owner) return true
  const current = peekAccountLocalKeyScope()
  return (
    current.accountIndex === owner.accountIndex &&
    current.identityKey === owner.identityKey &&
    current.chain === owner.chain
  )
}

function durableReceiveKey(owner?: BoundAccountKeyScope): string {
  return owner
    ? accountLocalKeyFor(DURABLE_RECEIVE_KEY, owner)
    : accountLocalKey(DURABLE_RECEIVE_KEY)
}

/** Read-only — `wasItemReceivedAnnounced` is asked once per arriving tip. */
function loadDurableReceives(owner?: BoundAccountKeyScope): Set<string> {
  try {
    const raw = durableGetItem(durableReceiveKey(owner))
    if (!raw) return new Set()
    if (raw === cachedReceivesRaw) return cachedReceives
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const set = new Set(
      parsed
        .filter((v): v is string => typeof v === 'string' && !!v.trim())
        .map(normalize),
    )
    cachedReceivesRaw = raw
    cachedReceives = set
    return set
  } catch {
    return new Set()
  }
}

function persistDurableReceives(
  set: Set<string>,
  owner?: BoundAccountKeyScope,
): void {
  try {
    const values = [...set]
    const trimmed =
      values.length > DURABLE_RECEIVE_MAX
        ? values.slice(values.length - DURABLE_RECEIVE_MAX)
        : values
    durableSetItem(durableReceiveKey(owner), JSON.stringify(trimmed))
  } catch {
    // Toast dedupe must never break ingest.
  }
}

/** True the first time this tip is announced as received (session + durable). */
export function noteItemReceived(
  outpoint: string,
  owner?: BoundAccountKeyScope,
): boolean {
  if (!ownerIsCurrent(owner)) return false
  const key = normalize(outpoint)
  if (!key) return false
  if (!note(receivedThisSession, key)) return false
  const stored = loadDurableReceives(owner)
  if (stored.has(key)) return false
  const durable = new Set(stored)
  durable.add(key)
  persistDurableReceives(durable, owner)
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
export function announceItemsReceived(
  outpoints: string[],
  owner?: BoundAccountKeyScope,
): boolean {
  const canPresent = ownerIsCurrent(owner)
  const fresh: string[] = []
  for (const op of outpoints) {
    const key = normalize(op)
    const txid = key.split('.')[0] ?? ''
    const proven = isItemProven(op) || verifiedThisSession.has(key)

    // Activity is the durable custody projection, not notification state.
    // Always ensure the receive row exists, even when a prior toast consumed
    // the durable dedupe key or this wallet's send finished in the background.
    // The Activity upsert is idempotent and cannot demote a settled row.
    if (proven) {
      noteInboundReceiveComplete({ txid, item: true, outpoint: key }, owner)
    } else {
      noteInboundReceivePending({ txid, item: true, outpoint: key }, owner)
    }

    // Foreground spinner/toast state belongs only to the selected wallet.
    if (!canPresent || !noteItemReceived(op, owner)) continue
    fresh.push(key)
    if (proven) {
      note(verifiedThisSession, op)
      clearAwaitingVerification(key)
    } else {
      noteAwaitingVerification(key)
    }
  }
  if (fresh.length === 0) return false
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
  return true
}

/**
 * Toast when authenticity newly settles for a tip that was already announced
 * as received. If receive has not been toasted yet (proven during classify),
 * only record the verdict — announceItemsReceived will include it.
 */
export function announceItemVerified(
  outpoint: string,
  detail?: string | null,
  owner?: BoundAccountKeyScope,
): void {
  const key = normalize(outpoint)
  if (!key) return
  // Inventory authenticity is settled — Activity must not stay on Verifying…
  const txid = key.split('.')[0] ?? ''
  if (!ownerIsCurrent(owner)) {
    if (/^[0-9a-f]{64}$/i.test(txid)) {
      noteInboundReceiveComplete(
        { txid: txid.toLowerCase(), item: true, outpoint: key },
        owner,
      )
    }
    return
  }
  clearAwaitingVerification(key)
  if (/^[0-9a-f]{64}$/i.test(txid)) {
    noteInboundReceiveComplete(
      {
        txid: txid.toLowerCase(),
        item: true,
        outpoint: key,
      },
      owner,
    )
  }
  if (!wasItemReceivedAnnounced(outpoint)) {
    // Receive toast still ahead — do not toast verify first.
    note(verifiedThisSession, key)
    return
  }
  if (!note(verifiedThisSession, key)) return
  toastSuccess('Item verified', detail?.trim() || 'Authenticity proven on chain')
}

/** Drop account-owned toast memory without deleting either account's history. */
export function rebindItemArrivalToastForAccount(): void {
  receivedThisSession.clear()
  verifiedThisSession.clear()
  cachedReceivesRaw = null
  cachedReceives = new Set()
}

/** Test helper — clear session + current account's durable announce state. */
export function resetItemArrivalAnnouncementsForTests(): void {
  rebindItemArrivalToastForAccount()
  try {
    durableSetItem(durableReceiveKey(), '[]')
  } catch {
    // ignore
  }
}
