import { getActiveWallet } from './session'

import type { ActivityItem } from './appActivity'
import { bntArtUrl } from './bnt/art'
import { heldBntAssets } from './bnt/heldAssets'
import { getCachedCollectables, type Collectable } from './collectables'
import {
  getResolvedInscription,
  getResolvedInscriptionByOrigin,
  isThinResolution,
} from './inscriptionCache'
import { getItemArtDataUrl } from './localItemArt'
import { contentUrlForOrigin } from './oneSatImport'
import { getProvenVerdict } from './provenCache'


const asOutpoint = (v: string) => v.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
const asOrigin = (v: string) => v.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')

type HeldIndex = {
  list: readonly Collectable[]
  byOutpoint: Map<string, number>
  byOrigin: Map<string, number>
}

let heldIndex: HeldIndex | null = null

/**
 * First held tip matching either key, in list order. Activity rows ask this
 * once per row and once per batch member on every paint; a scan of a
 * 1,500-item inventory per ask was most of the phone's Activity commit time.
 * The cache array is replaced on every change, so identity is the version.
 */
function heldCollectable(
  outpoint: string | null,
  originKey: string | null,
): Collectable | undefined {
  const list = getCachedCollectables()
  if (heldIndex?.list !== list) {
    const byOutpoint = new Map<string, number>()
    const byOrigin = new Map<string, number>()
    list.forEach((c, i) => {
      if (c.outpoint) {
        const key = asOutpoint(c.outpoint)
        if (!byOutpoint.has(key)) byOutpoint.set(key, i)
      }
      if (c.origin) {
        const key = asOrigin(c.origin)
        if (!byOrigin.has(key)) byOrigin.set(key, i)
      }
    })
    heldIndex = { list, byOutpoint, byOrigin }
  }
  const atOutpoint = outpoint ? heldIndex.byOutpoint.get(outpoint) : undefined
  const atOrigin = originKey ? heldIndex.byOrigin.get(originKey) : undefined
  const at =
    atOutpoint === undefined
      ? atOrigin
      : atOrigin === undefined
        ? atOutpoint
        : Math.min(atOutpoint, atOrigin)
  return at === undefined ? undefined : list[at]
}

function isGenericCollectableName(name: string | undefined): boolean {
  return !name?.trim() || /^collectable$/i.test(name.trim())
}

function resolvedInscriptionName(...keys: Array<string | null | undefined>): string | undefined {
  for (const key of keys) {
    const raw = key?.trim()
    if (!raw) continue
    const hit =
      getResolvedInscription(asOutpoint(raw)) ??
      getResolvedInscriptionByOrigin(asOrigin(raw))
    const name = hit && !isThinResolution(hit) ? hit.name?.trim() : ''
    if (name) return name
  }
  return undefined
}

/**
 * A BNT row names its asset id (`tokenId` for tokens, `origin` for items). The
 * activity store drops inlined pictures, so the deploy's art comes back from
 * the BNT art store, which outlives a relaunch and the asset leaving the
 * wallet, or else the held list.
 */
function withBntArt(item: ActivityItem): ActivityItem | null {
  if (item.imageUrl) return null
  const assetId = (item.tokenId ?? item.origin)?.trim().toLowerCase()
  if (!assetId || !/^[0-9a-f]{40}$/.test(assetId)) return null
  const imageUrl =
    bntArtUrl(assetId) ?? heldBntAssets(getActiveWallet()?.identityKey).find((a) => a.assetId === assetId)?.imageUrl
  return imageUrl ? { ...item, imageUrl } : null
}

export function viewActivityItem(item: ActivityItem): ActivityItem {
  const bnt = withBntArt(item)
  if (bnt) return bnt
  if (item.tokenId?.trim()) return item

  const outpoint = item.outpoint ? asOutpoint(item.outpoint) : null
  const originKey = item.origin ? asOrigin(item.origin) : null
  if (!outpoint && !originKey) return item

  // A tip still held has already been through the list's repair pass.
  // After a market list the held tip moves, so also match the 1sat origin.
  const held = heldCollectable(outpoint, originKey)
  if (held) {
    const chain = getActiveWallet()?.chain ?? 'main'
    const mediaOrigin = held.content ?? held.origin
    const named = resolvedInscriptionName(
      held.origin,
      held.outpoint,
      originKey,
      outpoint,
    )
    return {
      ...item,
      name:
        isGenericCollectableName(held.name) && named ? named : held.name,
      origin: held.origin,
      ...(held.content ? { content: held.content } : {}),
      imageUrl:
        getItemArtDataUrl(mediaOrigin) ??
        held.imageUrl ??
        contentUrlForOrigin(mediaOrigin, chain) ??
        item.imageUrl,
      ...(held.app ? { app: held.app } : {}),
    }
  }

  // A tip since sent on is gone from the list, but its identity is not. A verdict
  // outlives the output it judged, so a lineage proof earned while the item was
  // still held keeps repairing the record of the transfer that sent it away —
  // which is the only trace of it left in this wallet.
  const resolved = outpoint ? getResolvedInscription(outpoint) : null
  const byOrigin = originKey ? getResolvedInscriptionByOrigin(originKey) : null
  const usable =
    (resolved && !isThinResolution(resolved) ? resolved : null) ??
    (byOrigin && !isThinResolution(byOrigin) ? byOrigin : null)
  const previousOrigin = item.origin ? asOrigin(item.origin) : null
  const origin =
    (outpoint ? getProvenVerdict(outpoint)?.origin : null) ??
    (usable ? asOrigin(usable.origin) : null) ??
    previousOrigin
  if (!origin) return item

  const chain = getActiveWallet()?.chain ?? 'main'
  const name = usable?.name?.trim() || item.name
  // When origin was repaired, drop a URL that still pointed at the wrong tip.
  const imageUrl =
    getItemArtDataUrl(origin) ??
    (previousOrigin && previousOrigin !== asOrigin(origin)
      ? contentUrlForOrigin(origin, chain)
      : null) ??
    item.imageUrl ??
    contentUrlForOrigin(origin, chain)
  const app = usable?.app?.trim() || undefined

  if (
    name === item.name &&
    asOrigin(origin) === previousOrigin &&
    imageUrl === item.imageUrl &&
    (!app || app === item.app)
  ) {
    return item
  }

  return {
    ...item,
    name,
    origin,
    imageUrl,
    ...(app ? { app } : {}),
  }
}
