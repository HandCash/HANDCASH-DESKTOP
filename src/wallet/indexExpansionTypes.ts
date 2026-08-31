/** BRC-230 index expansion pack types (grade-C overlay catalog mirrors). */

export type IndexExpansionManifest = {
  v: 1
  packId: string
  name: string
  description?: string
  iconUrl?: string
  curatorIdentityKey?: string
  overlayBaseUrl: string
  topic: string
  lookupService: string
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
  scope: { kind: 'overlay-query', query: {} },
  budget: {
    maxEntries: 5000,
    maxBytes: 52_428_800,
    maxBeefBytes: 1_048_576,
  },
  updatePolicy: { mode: 'onOpen', intervalSeconds: 0 },
}
