import type { ActivityItem } from './appActivity'
import { getCachedCollectables } from './collectables'
import { getCachedFungibles } from './fungibles'
import { getTokenIconDataUrl } from './tokenIconCache'
import { getResolvedInscription, isThinResolution } from './inscriptionCache'
import { contentUrlForOrigin } from './oneSatImport'
import { getProvenVerdict } from './provenCache'
import { getActiveWallet } from './session'

const asOutpoint = (v: string) => v.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
const asOrigin = (v: string) => v.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')

export function viewActivityItem(item: ActivityItem): ActivityItem {
  if (item.tokenId?.trim()) {
    const tokenId = item.tokenId.trim().toLowerCase()
    const held = getCachedFungibles().find(
      (t) =>
        t.tokenId === tokenId ||
        t.tokenIds?.some((x) => x.toLowerCase() === tokenId),
    )
    if (held) {
      return {
        ...item,
        name: held.sym || item.name,
        origin: held.tokenId,
        tokenId: held.tokenId,
        imageUrl:
          held.iconUrl ||
          (held.icon ? getTokenIconDataUrl(held.icon) : undefined) ||
          item.imageUrl,
      }
    }
    const iconUrl = item.imageUrl || (item.origin ? getTokenIconDataUrl(item.origin) : undefined)
    return iconUrl ? { ...item, imageUrl: iconUrl } : item
  }

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

  // A tip since sent on is gone from the list, but its identity is not. A verdict
  // outlives the output it judged, so a lineage proof earned while the item was
  // still held keeps repairing the record of the transfer that sent it away —
  // which is the only trace of it left in this wallet.
  const resolved = getResolvedInscription(outpoint)
  const usable = resolved && !isThinResolution(resolved) ? resolved : null
  const origin = getProvenVerdict(outpoint)?.origin ?? (usable ? asOrigin(usable.origin) : null)
  if (!origin) return item
  return {
    ...item,
    name: usable?.name?.trim() || item.name,
    origin,
    imageUrl: contentUrlForOrigin(origin, getActiveWallet()?.chain ?? 'main'),
    ...(usable?.app ? { app: usable.app } : {}),
  }
}
