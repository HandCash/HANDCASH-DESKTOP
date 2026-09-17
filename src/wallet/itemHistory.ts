import { getProvenVerdict } from './provenCache'
import type { Collectable } from './collectables'
import {
  activityEntryTitle,
  activityMatchesFriend,
  activityRecipientLabel,
  isTokenActivity,
  type ActivityEntry,
} from './appActivity'
import { activityActionMark, type ActivityActionMark } from './activityActionMark'
import { listFriends } from './friends'

export type HistoryContactLink = {
  label: string
  friendId?: string
  identityKey?: string
}

export type HistoryAssetLink =
  | { kind: 'collectable'; outpoint: string; name: string }
  | { kind: 'token'; tokenId: string; name: string }

export type ItemHistoryEvent = {
  id: string
  kind: 'mint' | 'transfer' | 'hold' | 'activity'
  mark: ActivityActionMark
  title: string
  detail: string
  at?: number
  contact?: HistoryContactLink | null
  asset?: HistoryAssetLink | null
}

function normalizePoint(value: string): string {
  return value.trim().toLowerCase().replace('.', '_')
}

function hopTxid(outpoint: string): string {
  return outpoint.replace(/[._]\d+$/u, '')
}

function hopLabel(outpoint: string): string {
  const txid = hopTxid(outpoint)
  if (txid.length < 12) return outpoint
  return `${txid.slice(0, 8)}…${txid.slice(-6)}`
}

export function activityContactLink(entry: ActivityEntry): HistoryContactLink | null {
  const friends = listFriends()
  const friend = friends.find((row) => activityMatchesFriend(entry, row))
  if (friend) {
    const handle = friend.handle?.trim()
    return {
      label: handle || friend.label,
      friendId: friend.id,
      identityKey: friend.identityKey,
    }
  }
  const label = activityRecipientLabel(entry)?.trim()
  if (!label || label.toLowerCase() === 'myself') return null
  const identityKey = entry.retry?.recipientIdentityKey?.trim() || undefined
  return { label, identityKey }
}

function assetForEntry(entry: ActivityEntry): HistoryAssetLink | null {
  const item = entry.item
  if (!item) return null
  const name = item.name?.trim() || (item.tokenId ? 'BSV-21 token' : 'Collectable')
  const tokenId = item.tokenId?.trim()
  if (tokenId) return { kind: 'token', tokenId, name }
  const outpoint = (item.outpoint || item.origin || '').trim()
  if (!outpoint) return null
  return { kind: 'collectable', outpoint, name }
}

function activityTouchesItem(entry: ActivityEntry, item: Collectable): boolean {
  if (isTokenActivity(entry) || !entry.item) return false
  const origin = normalizePoint(item.origin)
  const tip = normalizePoint(item.outpoint)
  const entryOrigin = entry.item.origin ? normalizePoint(entry.item.origin) : ''
  const entryPoint = entry.item.outpoint ? normalizePoint(entry.item.outpoint) : ''
  return Boolean(
    (origin && (entryOrigin === origin || entryPoint === origin)) ||
      (tip && (entryPoint === tip || entryOrigin === tip)),
  )
}

function hydrateActivityItem(
  entry: ActivityEntry,
  item: Collectable,
): ActivityEntry {
  if (!entry.item) return entry
  const generic =
    !entry.item.name?.trim() || /^collectable$/i.test(entry.item.name.trim())
  if (!generic) return entry
  return {
    ...entry,
    item: {
      ...entry.item,
      name: item.name,
      origin: entry.item.origin || item.origin,
      outpoint: entry.item.outpoint || item.outpoint,
    },
  }
}

function fromActivity(
  entry: ActivityEntry,
  item?: Collectable,
): ItemHistoryEvent {
  const hydrated = item ? hydrateActivityItem(entry, item) : entry
  const title = activityEntryTitle(hydrated)
  const note = hydrated.note?.trim() || ''
  const detail =
    !note || note === title || /^received collectable$/i.test(note)
      ? hopLabel(hydrated.txid ?? hydrated.item?.outpoint ?? item?.outpoint ?? '')
      : note
  return {
    id: `activity:${entry.id}`,
    kind: 'activity',
    mark: activityActionMark(entry) ?? (entry.kind === 'spent' ? 'send' : 'receive'),
    title,
    detail,
    at: entry.at,
    contact: activityContactLink(hydrated),
    asset: item
      ? {
          kind: 'collectable',
          outpoint: item.outpoint,
          name: item.name,
        }
      : assetForEntry(hydrated),
  }
}

/**
 * Newest-first story for an item: wallet activity, transfers, then mint.
 * Current hold is omitted when a receive already says we have it.
 */
export function itemHistory(
  item: Collectable,
  activity: readonly ActivityEntry[] = [],
): ItemHistoryEvent[] {
  const verdict = getProvenVerdict(item.outpoint) ?? getProvenVerdict(item.origin)
  const path = (verdict?.path?.length ? verdict.path : [item.outpoint, item.origin])
    .map(normalizePoint)
    .filter((point, index, all) => point && all.indexOf(point) === index)
  const chronological = [...path].reverse()
  const originPoint = normalizePoint(item.origin)
  const tipPoint = normalizePoint(item.outpoint)
  const selfAsset: HistoryAssetLink = {
    kind: 'collectable',
    outpoint: item.outpoint,
    name: item.name,
  }
  const lineage: ItemHistoryEvent[] = []

  chronological.forEach((point, index) => {
    const isOrigin = point === originPoint || index === 0
    const isTip = point === tipPoint
    if (isOrigin) {
      lineage.push({
        id: `mint:${point}`,
        kind: 'mint',
        mark: 'mint',
        title: 'Minted',
        detail: `Inscribed at origin ${hopLabel(point)}`,
        asset: selfAsset,
      })
      return
    }
    if (isTip && index === chronological.length - 1) {
      lineage.push({
        id: `hold:${point}`,
        kind: 'hold',
        mark: 'receive',
        title: 'Held in this wallet',
        detail: `Current tip ${hopLabel(point)}`,
        asset: selfAsset,
      })
      return
    }
    lineage.push({
      id: `hop:${point}`,
      kind: 'transfer',
      mark: 'send',
      title: 'Moved on chain',
      detail: `Transfer ${hopLabel(point)}`,
      asset: selfAsset,
    })
  })

  const seen = new Set<string>()
  const acts: ItemHistoryEvent[] = []
  for (const entry of [...activity].sort((a, b) => b.at - a.at)) {
    if (!activityTouchesItem(entry, item)) continue
    const key = `${entry.txid ?? ''}:${entry.id}`
    if (seen.has(key)) continue
    seen.add(key)
    acts.push(fromActivity(entry, item))
  }

  const alreadyHere = acts.some(
    (event) => event.mark === 'receive' || event.mark === 'purchase',
  )
  const chain = alreadyHere
    ? lineage.filter((event) => event.kind !== 'hold')
    : lineage

  return [...acts, ...chain.reverse()]
}

/** Newest-first local history for a BSV-21 balance. */
export function tokenHistory(
  token: { tokenId: string; tokenIds?: string[]; sym: string },
  activity: readonly ActivityEntry[],
): ItemHistoryEvent[] {
  const ids = new Set(
    [token.tokenId, ...(token.tokenIds ?? [])].map((id) => id.trim().toLowerCase()),
  )
  const selfAsset: HistoryAssetLink = {
    kind: 'token',
    tokenId: token.tokenId,
    name: token.sym || 'BSV-21',
  }
  const seen = new Set<string>()
  const events: ItemHistoryEvent[] = []
  for (const entry of [...activity].sort((a, b) => b.at - a.at)) {
    const id = entry.item?.tokenId?.trim().toLowerCase()
    if (!id || !ids.has(id)) continue
    const key = `${entry.txid ?? ''}:${entry.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const event = fromActivity(entry)
    events.push({
      ...event,
      asset: event.asset ?? selfAsset,
    })
  }
  return events
}
