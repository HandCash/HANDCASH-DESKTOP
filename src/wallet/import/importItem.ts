import { contentUrlForOrigin, extractResolved, type GpTxo } from '../oneSatImport'
import type { Chain } from '../vault'

/**
 * One 1-sat tip held by a saved source, as the 1Sat index describes it.
 * Display only: the name and media come from the index (unproven) and the
 * move re-decides the tip from its source transaction.
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
  /** Thumbnail for image content; null for text, HTML, models and unknown media. */
  imageUrl: string | null
}

export type ImportItemFacts = Pick<ImportItem, 'origin' | 'media' | 'name' | 'mimeType'>

const NO_FACTS: ImportItemFacts = { origin: null, media: null, name: null, mimeType: null }

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
