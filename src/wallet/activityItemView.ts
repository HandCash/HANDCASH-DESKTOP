/**
 * Paints an activity row's collectable from what the wallet knows now.
 *
 * A row stores the item's name, origin and image URL as they looked the moment
 * the transfer was recorded. Identity is not part of that event, though: an
 * origin the sender had wrong — or one the indexer had not indexed yet — is
 * frozen into the row, so its thumbnail 404s forever even after Collect repairs
 * the very same tip. Read identity through here instead of off the stored row.
 */
import type { ActivityItem } from './appActivity'
import { getCachedCollectables } from './collectables'
import { getResolvedInscription, isThinResolution } from './inscriptionCache'
import { contentUrlForOrigin } from './oneSatImport'
import { getActiveWallet } from './session'

const asOutpoint = (v: string) => v.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
const asOrigin = (v: string) => v.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')

export function viewActivityItem(item: ActivityItem): ActivityItem {
  const outpoint = item.outpoint ? asOutpoint(item.outpoint) : null
  if (!outpoint) return item

  // A tip still held has already been through the list's repair pass.
  const held = getCachedCollectables().find((c) => asOutpoint(c.outpoint) === outpoint)
  if (held) {
    return {
      ...item,
      name: held.name,
      origin: held.origin,
      imageUrl: held.imageUrl,
      ...(held.app ? { app: held.app } : {}),
    }
  }

  // A tip since sent on is gone from the list, but its identity is not.
  const resolved = getResolvedInscription(outpoint)
  if (!resolved || isThinResolution(resolved)) return item
  return {
    ...item,
    name: resolved.name?.trim() || item.name,
    origin: asOrigin(resolved.origin),
    imageUrl: contentUrlForOrigin(resolved.origin, getActiveWallet()?.chain ?? 'main'),
    ...(resolved.app ? { app: resolved.app } : {}),
  }
}
