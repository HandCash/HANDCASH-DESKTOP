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

function tokenIconUrl(iconOutpoint: string | undefined | null): string | undefined {
  if (!iconOutpoint?.trim()) return undefined
  return getTokenIconDataUrl(iconOutpoint)
}

export function viewActivityItem(item: ActivityItem): ActivityItem {
  if (item.tokenId?.trim()) {
    const tokenId = item.tokenId.trim().toLowerCase()
    const held = getCachedFungibles().find(
      (t) =>
        t.tokenId === tokenId ||
        t.tokenIds?.some((x) => x.toLowerCase() === tokenId),
    )
    if (held) {
      const icon = held.icon || item.icon
      return {
        ...item,
        name: held.sym || item.name,
        origin: held.tokenId,
        tokenId: held.tokenId,
        ...(held.amt && !item.amt ? { amt: held.amt } : {}),
        ...(held.dec != null && item.dec == null ? { dec: held.dec } : {}),
        ...(icon ? { icon } : {}),
        imageUrl:
          held.iconUrl ||
          tokenIconUrl(held.icon) ||
          tokenIconUrl(item.icon) ||
          item.imageUrl,
      }
    }
    // Icons are keyed by the icon inscription outpoint — never by token id.
    // Looking up `item.origin` (tokenId) was a no-op and left mint rows blank.
    const imageUrl =
      item.imageUrl || tokenIconUrl(item.icon) || undefined
    return imageUrl || item.icon
      ? { ...item, ...(item.icon ? { icon: item.icon } : {}), ...(imageUrl ? { imageUrl } : {}) }
      : item
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
