import { contentUrlForOrigin, extractResolved, type GpTxo } from '../oneSatImport'
import type { Chain } from '../vault'

/**
 * One 1-sat tip held by a saved source, as the 1Sat index describes it.
 * Display only: the name, media, app and signer come from the index
 * (unproven) and the move re-decides the tip from its source transaction.
 */
export type ImportItem = {
  /** `txid_vout`. */
  outpoint: string
  address: string
  /** Origin outpoint `txid_vout`, or null where the index knows none. */
  origin: string | null
  /** Outpoint whose content is the art — a shared reference or the origin. */
  media: string | null
  name: string | null
  mimeType: string | null
  /** MAP `app` on the origin. */
  app: string | null
  collectionId: string | null
  /**
   * Sigma signer address the index reports on the origin. HandCash signs
   * every item it mints with the creator's identity for that app, so items
   * sharing a signer share a creator. Attribution only — never verified here.
   */
  signer: string | null
  /** Thumbnail for image content; null for text, HTML, models and unknown media. */
  imageUrl: string | null
}

export type ImportItemFacts = Omit<ImportItem, 'outpoint' | 'address' | 'imageUrl'>

/** An item the index does not name: listed by outpoint, decided at the move. */
export const NO_FACTS: ImportItemFacts = {
  origin: null,
  media: null,
  name: null,
  mimeType: null,
  app: null,
  collectionId: null,
  signer: null,
}

/** Facts from a GorillaPool txo row; never throws on a malformed row. */
export function importItemFacts(row: unknown, outpoint: string): ImportItemFacts {
  if (!row || typeof row !== 'object') return NO_FACTS
  let resolved: ReturnType<typeof extractResolved> = null
  try {
    resolved = extractResolved(row as GpTxo, outpoint)
  } catch {
    return NO_FACTS
  }
  if (!resolved) return NO_FACTS
  return {
    origin: resolved.origin,
    media: resolved.content ?? resolved.origin,
    name: resolved.name?.trim() || null,
    mimeType: resolved.mimeType?.trim() || null,
    app: resolved.app?.trim() || null,
    collectionId: resolved.collectionId?.trim() || null,
    signer: resolved.signer ?? null,
  }
}

/** The item with its thumbnail URL, where its content is an image. */
export function withImportItemArt(item: ImportItem, chain: Chain): ImportItem {
  const imageUrl =
    item.media && item.mimeType?.toLowerCase().startsWith('image/')
      ? contentUrlForOrigin(item.media, chain)
      : null
  return imageUrl === item.imageUrl ? item : { ...item, imageUrl }
}

/**
 * Shelf an item sits on, in Collect's order: the identity that signed it,
 * else the app named on it, else its collection. `key` is stable for a shelf.
 */
export type ImportItemGroup = {
  key: string
  kind: 'signer' | 'app' | 'collection' | 'none'
  label: string
  app: string | null
  signer: string | null
  collectionId: string | null
}

export const NO_GROUP_KEY = 'none'

function seriesName(name: string | null): string | null {
  const stem = name?.replace(/\s*#\d+\s*$/u, '').trim()
  return stem || null
}

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

export function importItemGroup(
  item: Pick<ImportItem, 'signer' | 'app' | 'collectionId' | 'name'>,
): ImportItemGroup {
  const app = item.app?.trim() || null
  const collectionId = item.collectionId?.trim() || null
  if (item.signer) {
    return { key: `signer:${item.signer}`, kind: 'signer', label: app ?? 'Signed items', app, signer: item.signer, collectionId: null }
  }
  if (app) return { key: `app:${app.toLowerCase()}`, kind: 'app', label: app, app, signer: null, collectionId: null }
  if (collectionId) {
    return {
      key: `collection:${collectionId.toLowerCase()}`,
      kind: 'collection',
      label: seriesName(item.name) ?? `Collection ${shortId(collectionId)}`,
      app: null,
      signer: null,
      collectionId,
    }
  }
  return { key: NO_GROUP_KEY, kind: 'none', label: 'No issuer', app: null, signer: null, collectionId: null }
}

const GROUP_RANK: Record<ImportItemGroup['kind'], number> = { signer: 0, app: 1, collection: 2, none: 3 }

/** Shelf order: signed identities, then apps, then collections, then the rest. */
export function compareImportGroups(a: ImportItemGroup, b: ImportItemGroup): number {
  return (
    GROUP_RANK[a.kind] - GROUP_RANK[b.kind] ||
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) ||
    a.key.localeCompare(b.key)
  )
}
