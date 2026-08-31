/** BRC-230 index expansion pack types (grade-C overlay catalog mirrors). */

/** What the cached overlay index represents — drives Activity copy and NFT verify hints. */
export type IndexCatalogContext =
  | 'onesat-ordinal'
  | 'bsv21-token'
  | 'social-feed'
  | 'generic'

const INDEX_CATALOG_CONTEXTS = new Set<IndexCatalogContext>([
  'onesat-ordinal',
  'bsv21-token',
  'social-feed',
  'generic',
])

export function isIndexCatalogContext(value: string): value is IndexCatalogContext {
  return INDEX_CATALOG_CONTEXTS.has(value as IndexCatalogContext)
}

/** Resolve explicit manifest field or infer from topic / lookup service / scope. */
export function resolveIndexCatalogContext(
  manifest: Pick<
    IndexExpansionManifest,
    'catalogContext' | 'topic' | 'lookupService' | 'scope'
  >,
): IndexCatalogContext {
  const explicit = manifest.catalogContext
  if (explicit && isIndexCatalogContext(explicit)) return explicit
  const topic = manifest.topic.toLowerCase()
  const lookup = manifest.lookupService.toLowerCase()
  if (
    topic.includes('1sat') ||
    lookup.includes('1sat') ||
    topic.includes('ordinal') ||
    lookup.includes('ordinal') ||
    topic.includes('nft')
  ) {
    return 'onesat-ordinal'
  }
  if (
    topic.includes('bsv21') ||
    lookup.includes('bsv21') ||
    topic.includes('token') ||
    lookup.includes('token')
  ) {
    return 'bsv21-token'
  }
  if (manifest.scope.kind === 'feed') return 'social-feed'
  return 'generic'
}

export function indexCatalogContextLabel(context: IndexCatalogContext): string {
  switch (context) {
    case 'onesat-ordinal':
      return '1Sat ordinal index'
    case 'bsv21-token':
      return 'BSV-21 token index'
    case 'social-feed':
      return 'Feed index'
    default:
      return 'Catalog index'
  }
}

/** True when pack rows describe NFT / ordinal listings (not fungible or social). */
export function isNftIndexCatalog(context: IndexCatalogContext): boolean {
  return context === 'onesat-ordinal'
}

export type OverlayDiscoveryMode = 'auto' | 'slap' | 'url'

export type IndexExpansionDiscovery = {
  /** auto = curator hint + SLAP; slap = SLAP only; url = overlayBaseUrl only */
  mode?: OverlayDiscoveryMode
  /** Extra curator host hints (tried before SLAP in auto mode). */
  hosts?: string[]
  /** Override default BSVA SLAP trackers. */
  slapTrackers?: string[]
}

export type IndexExpansionManifest = {
  v: 1
  packId: string
  name: string
  description?: string
  iconUrl?: string
  curatorIdentityKey?: string
  /** Curator hint — optional when discovery.mode is slap (SLAP resolves hosts). */
  overlayBaseUrl?: string
  topic: string
  lookupService: string
  discovery?: IndexExpansionDiscovery
  scope: {
    kind: 'overlay-query' | 'collection' | 'feed'
    query: Record<string, unknown>
  }
  budget: {
    maxEntries: number
    maxBytes: number
    maxBeefBytes: number
  }
  preview?: { beefB64?: string }
  updatePolicy?: {
    mode?: 'manual' | 'onOpen' | 'interval'
    intervalSeconds?: number
  }
  /** What this overlay mirror indexes — e.g. onesat-ordinal for NFT listing packs. */
  catalogContext?: IndexCatalogContext
  [key: string]: unknown
}

export type IndexPackStatus =
  | 'installing'
  | 'ready'
  | 'partial'
  | 'failed'
  | 'removed'

export type IndexPackRecord = {
  packId: string
  name: string
  description?: string
  iconUrl?: string
  manifest: IndexExpansionManifest
  status: IndexPackStatus
  partial: boolean
  entryCount: number
  bytesUsed: number
  lastSyncedAt?: number
  installedAt: number
  installedByOrigin?: string
  catalogContext: IndexCatalogContext
  lastError?: string
}

/** Stored row mirrored into listOutputs for basket `index`. */
export type IndexEntryRecord = {
  entryKey: string
  packId: string
  outpoint: string
  tags: string[]
  customInstructions: string
  bytes: number
}

export type IndexEntryCustomInstructions = {
  packId: string
  entryKey: string
  name?: string
  imageUrl?: string
  origin?: string
  overlayOutpoint?: string
  beefB64?: string
  updatedAt?: number
}

export const INDEX_STORAGE_BASKET = 'index'
export const INDEX_SCHEME = 'index'

export const INDEX_EXPANSION_STORAGE_KEY = 'handcash.indexExpansion.packs.v1'
export const INDEX_ENTRIES_STORAGE_KEY = 'handcash.indexExpansion.entries.v1'

/** HandCash Market reference profile (BRC-230 §8). */
export const HANDCASH_MARKET_CATALOG_MANIFEST: IndexExpansionManifest = {
  v: 1,
  packId: 'handcash.market.catalog',
  name: 'HandCash Market',
  description: 'Browse active 1Sat listings',
  iconUrl: 'https://market.handcash.io/favicon.ico',
  overlayBaseUrl: 'https://market.handcash.io',
  topic: 'tm_1sat_market',
  lookupService: 'ls_1sat_market',
  scope: { kind: 'overlay-query', query: { mode: 'active', limit: 500 } },
  discovery: { mode: 'auto' },
  budget: {
    maxEntries: 5000,
    maxBytes: 52_428_800,
    maxBeefBytes: 1_048_576,
  },
  updatePolicy: { mode: 'onOpen', intervalSeconds: 0 },
  catalogContext: 'onesat-ordinal',
}
