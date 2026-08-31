import { durableGetItem, durableSetItem } from './durableStorage'
import type {
  IndexEntryCustomInstructions,
  IndexEntryRecord,
  IndexPackRecord,
} from './indexExpansionTypes'
import {
  INDEX_ENTRIES_STORAGE_KEY,
  INDEX_EXPANSION_STORAGE_KEY,
  INDEX_STORAGE_BASKET,
} from './indexExpansionTypes'

type PackMap = Record<string, IndexPackRecord>
type EntryMap = Record<string, Record<string, IndexEntryRecord>>

function readPacks(): PackMap {
  try {
    const raw = durableGetItem(INDEX_EXPANSION_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PackMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePacks(packs: PackMap): void {
  durableSetItem(INDEX_EXPANSION_STORAGE_KEY, JSON.stringify(packs))
}

function readEntries(): EntryMap {
  try {
    const raw = durableGetItem(INDEX_ENTRIES_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as EntryMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeEntries(entries: EntryMap): void {
  durableSetItem(INDEX_ENTRIES_STORAGE_KEY, JSON.stringify(entries))
}

export function listStoredIndexPacks(): IndexPackRecord[] {
  return Object.values(readPacks())
    .filter((p) => p.status !== 'removed')
    .sort((a, b) => b.installedAt - a.installedAt)
}

export function getStoredIndexPack(packId: string): IndexPackRecord | null {
  const pack = readPacks()[packId]
  if (!pack || pack.status === 'removed') return null
  return pack
}

export function upsertStoredIndexPack(pack: IndexPackRecord): void {
  const packs = readPacks()
  packs[pack.packId] = pack
  writePacks(packs)
}

export function removeStoredIndexPack(packId: string): void {
  const packs = readPacks()
  if (packs[packId]) {
    packs[packId] = { ...packs[packId], status: 'removed', entryCount: 0, bytesUsed: 0 }
  }
  writePacks(packs)
  const entries = readEntries()
  delete entries[packId]
  writeEntries(entries)
}

export function listStoredIndexEntries(packId: string): IndexEntryRecord[] {
  const bucket = readEntries()[packId]
  if (!bucket) return []
  return Object.values(bucket)
}

export function replaceStoredIndexEntries(
  packId: string,
  rows: IndexEntryRecord[],
): { entryCount: number; bytesUsed: number } {
  const entries = readEntries()
  entries[packId] = Object.fromEntries(rows.map((row) => [row.entryKey, row]))
  writeEntries(entries)
  const bytesUsed = rows.reduce((sum, row) => sum + row.bytes, 0)
  return { entryCount: rows.length, bytesUsed }
}

export function mergeStoredIndexEntries(
  packId: string,
  rows: IndexEntryRecord[],
  maxEntries: number,
): { entryCount: number; bytesUsed: number; partial: boolean } {
  const entries = readEntries()
  const bucket = { ...(entries[packId] ?? {}) }
  for (const row of rows) {
    if (Object.keys(bucket).length >= maxEntries) {
      const merged = Object.values(bucket)
      entries[packId] = Object.fromEntries(merged.map((r) => [r.entryKey, r]))
      writeEntries(entries)
      const bytesUsed = merged.reduce((sum, r) => sum + r.bytes, 0)
      return { entryCount: merged.length, bytesUsed, partial: true }
    }
    bucket[row.entryKey] = row
  }
  const merged = Object.values(bucket)
  entries[packId] = Object.fromEntries(merged.map((r) => [r.entryKey, r]))
  writeEntries(entries)
  const bytesUsed = merged.reduce((sum, r) => sum + r.bytes, 0)
  return { entryCount: merged.length, bytesUsed, partial: false }
}

export function entryBytes(row: IndexEntryRecord): number {
  return row.customInstructions.length + row.tags.join(',').length + row.outpoint.length
}

export function buildIndexEntryRecord(args: {
  packId: string
  entryKey: string
  overlayOutpoint: string
  ci: IndexEntryCustomInstructions
  extraTags?: string[]
}): IndexEntryRecord {
  const customInstructions = JSON.stringify({
    ...args.ci,
    packId: args.packId,
    entryKey: args.entryKey,
    updatedAt: args.ci.updatedAt ?? Math.floor(Date.now() / 1000),
  })
  const tags = [
    `pack:${args.packId}`,
    `entry:${args.entryKey}`,
    ...(args.extraTags ?? []),
  ]
  const row: IndexEntryRecord = {
    packId: args.packId,
    entryKey: args.entryKey,
    outpoint: args.overlayOutpoint.replace('_', '.'),
    tags,
    customInstructions,
    bytes: 0,
  }
  row.bytes = entryBytes(row)
  return row
}

/** Shape a stored row for BRC-100 listOutputs / listIndexExpansionEntries. */
export function indexEntryToListOutput(row: IndexEntryRecord): Record<string, unknown> {
  return {
    outpoint: row.outpoint,
    basket: INDEX_STORAGE_BASKET,
    satoshis: 0,
    tags: row.tags,
    customInstructions: row.customInstructions,
  }
}

export function queryStoredIndexEntries(args: {
  packId: string
  tags?: string[]
  limit?: number
  offset?: number
}): { outputs: Record<string, unknown>[]; totalOutputs: number } {
  let rows = listStoredIndexEntries(args.packId)
  const filterTags = (args.tags ?? []).filter((t) => typeof t === 'string' && t.trim())
  if (filterTags.length > 0) {
    rows = rows.filter((row) => filterTags.every((tag) => row.tags.includes(tag)))
  }
  const totalOutputs = rows.length
  const offset = Math.max(0, args.offset ?? 0)
  const limit = Math.max(1, Math.min(args.limit ?? 50, 500))
  const page = rows.slice(offset, offset + limit)
  return {
    outputs: page.map(indexEntryToListOutput),
    totalOutputs,
  }
}

export function clearIndexExpansionStoreForTests(): void {
  writePacks({})
  writeEntries({})
}
