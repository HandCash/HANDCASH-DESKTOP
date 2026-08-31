import { recordWalletEvent } from './appActivity'
import { normalizeOrigin } from './permissions'
import {
  fetchIndexExpansionManifest,
  IndexManifestError,
  validateIndexExpansionManifest,
} from './indexExpansionManifest'
import {
  fetchOverlayLookup,
  liveOverlayLookup,
  overlayOutputsToIndexEntries,
  overlayOutputsToListOutputs,
} from './indexExpansionLookup'
import { overlayRequestFromManifest } from './overlayClient'
import {
  getStoredIndexPack,
  listStoredIndexPacks,
  mergeStoredIndexEntries,
  queryStoredIndexEntries,
  removeStoredIndexPack,
  replaceStoredIndexEntries,
  upsertStoredIndexPack,
} from './indexExpansionStore'
import type { IndexExpansionManifest, IndexPackRecord } from './indexExpansionTypes'
import {
  indexCatalogContextLabel,
  resolveIndexCatalogContext,
} from './indexExpansionTypes'
import {
  finishWalletProgress,
  startWalletProgress,
  updateWalletProgress,
} from './walletProgress'

function newActivityId(): string {
  return globalThis.crypto.randomUUID()
}

export type InstallIndexExpansionArgs = {
  manifest?: IndexExpansionManifest
  manifestUrl?: string
}

export type SyncIndexExpansionArgs = {
  packId: string
  force?: boolean
}

export type ListIndexExpansionEntriesArgs = {
  packId: string
  tags?: string[]
  limit?: number
  offset?: number
  /** When true, query overlay live (SLAP + failover) instead of local cache. */
  live?: boolean
}

export type OverlayLookupArgs = {
  lookupService: string
  query?: Record<string, unknown>
  overlayBaseUrl?: string
  discovery?: 'auto' | 'slap' | 'url'
  slapTrackers?: string[]
  extraHosts?: string[]
  packId?: string
  maxOutputs?: number
}

const syncInFlight = new Map<string, Promise<void>>()

function packSummary(pack: IndexPackRecord) {
  const catalogContext =
    pack.catalogContext ?? resolveIndexCatalogContext(pack.manifest)
  return {
    packId: pack.packId,
    name: pack.name,
    iconUrl: pack.iconUrl,
    status: pack.status,
    entryCount: pack.entryCount,
    bytesUsed: pack.bytesUsed,
    lastSyncedAt: pack.lastSyncedAt,
    partial: pack.partial,
    installedByOrigin: pack.installedByOrigin,
    catalogContext,
    catalogContextLabel: indexCatalogContextLabel(catalogContext),
  }
}

async function resolveManifest(
  args: InstallIndexExpansionArgs,
  fetchImpl?: typeof fetch,
): Promise<IndexExpansionManifest> {
  const hasManifest = args.manifest != null
  const hasUrl = typeof args.manifestUrl === 'string' && args.manifestUrl.trim()
  if (hasManifest && hasUrl) {
    throw new IndexManifestError('Provide manifest or manifestUrl, not both')
  }
  if (!hasManifest && !hasUrl) {
    throw new IndexManifestError('manifest or manifestUrl is required')
  }
  if (hasManifest) return validateIndexExpansionManifest(args.manifest)
  return fetchIndexExpansionManifest(args.manifestUrl!, fetchImpl)
}

function previewItemFromManifest(manifest: IndexExpansionManifest) {
  const catalogContext = resolveIndexCatalogContext(manifest)
  return {
    name: manifest.name,
    origin: manifest.packId,
    imageUrl: manifest.iconUrl,
    app: indexCatalogContextLabel(catalogContext),
    indexCatalogContext: catalogContext,
  }
}

async function runPackSync(args: {
  packId: string
  origin?: string
  activityId?: string
  fetchImpl?: typeof fetch
  replace?: boolean
}): Promise<IndexPackRecord> {
  const existing = getStoredIndexPack(args.packId)
  if (!existing) throw new Error(`Pack "${args.packId}" is not installed`)

  const activityNote = (note: string, status?: 'pending' | 'complete' | 'failed') => {
    recordWalletEvent({
      origin: args.origin,
      method: 'index-sync',
      note,
      item: previewItemFromManifest(existing.manifest),
      ...(status ? { status } : {}),
    })
  }

  activityNote(`Syncing ${existing.name}…`, 'pending')

  const catalogContext =
    existing.catalogContext ?? resolveIndexCatalogContext(existing.manifest)

  startWalletProgress({
    kind: 'index-expansion',
    phase: 'fetching',
    message: `Downloading ${existing.name} (${indexCatalogContextLabel(catalogContext)})…`,
  })

  upsertStoredIndexPack({
    ...existing,
    status: 'installing',
    catalogContext,
  })

  try {
    updateWalletProgress({ phase: 'fetching', message: `Fetching overlay for ${existing.name}…` })
    const lookup = await fetchOverlayLookup({
      manifest: existing.manifest,
      fetchImpl: args.fetchImpl,
      maxEntries: existing.manifest.budget.maxEntries,
    })
    const mapped = overlayOutputsToIndexEntries({
      packId: args.packId,
      outputs: lookup.outputs,
      budget: existing.manifest.budget,
      beefBytesUsed: 0,
    })
    const rowTotal = mapped.rows.length
    updateWalletProgress({
      phase: 'caching',
      current: 0,
      total: rowTotal > 0 ? rowTotal : null,
      message:
        rowTotal > 0
          ? `Caching ${rowTotal.toLocaleString()} entries for ${existing.name}…`
          : `Caching ${existing.name}…`,
    })
    let partial = lookup.truncated || mapped.partial
    let entryCount: number
    let bytesUsed: number
    if (args.replace) {
      const replaced = replaceStoredIndexEntries(args.packId, mapped.rows)
      entryCount = replaced.entryCount
      bytesUsed = replaced.bytesUsed
    } else {
      const merged = mergeStoredIndexEntries(
        args.packId,
        mapped.rows,
        existing.manifest.budget.maxEntries,
      )
      entryCount = merged.entryCount
      bytesUsed = merged.bytesUsed
      partial = partial || merged.partial
    }
    if (bytesUsed > existing.manifest.budget.maxBytes) partial = true

    const hostNote = lookup.host ? ` via ${lookup.host}` : ''
    const updated: IndexPackRecord = {
      ...existing,
      status: partial ? 'partial' : 'ready',
      partial,
      entryCount,
      bytesUsed,
      lastSyncedAt: Math.floor(Date.now() / 1000),
      lastError: undefined,
      catalogContext,
    }
    upsertStoredIndexPack(updated)
    updateWalletProgress({
      current: entryCount,
      total: rowTotal > 0 ? rowTotal : entryCount || null,
    })
    activityNote(
      partial
        ? `${entryCount} entries cached (partial — budget reached)${hostNote}`
        : `${entryCount} entries cached${hostNote}`,
      'complete',
    )
    finishWalletProgress('done', {
      message: partial
        ? `${entryCount.toLocaleString()} entries cached (partial)`
        : `${entryCount.toLocaleString()} entries cached`,
    })
    return updated
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const failed: IndexPackRecord = {
      ...existing,
      status: 'failed',
      lastError: reason,
      catalogContext,
    }
    upsertStoredIndexPack(failed)
    finishWalletProgress('failed', { message: reason })
    recordWalletEvent({
      origin: args.origin,
      method: 'index-sync',
      note: `Sync failed: ${existing.name}`,
      item: previewItemFromManifest(existing.manifest),
      status: 'failed',
      failureReason: reason,
    })
    throw err
  }
}

export async function installIndexExpansion(args: {
  body: InstallIndexExpansionArgs
  origin?: string
  fetchImpl?: typeof fetch
}): Promise<{ packId: string; status: string; activityId: string }> {
  const manifest = await resolveManifest(args.body, args.fetchImpl)
  const activityId = newActivityId()
  const now = Math.floor(Date.now() / 1000)
  const catalogContext = resolveIndexCatalogContext(manifest)

  recordWalletEvent({
    origin: args.origin,
    method: 'index-install',
    note: `Downloading ${manifest.name}…`,
    item: previewItemFromManifest(manifest),
    status: 'pending',
  })

  const pack: IndexPackRecord = {
    packId: manifest.packId,
    name: manifest.name,
    description: manifest.description,
    iconUrl: manifest.iconUrl,
    manifest,
    status: 'installing',
    partial: false,
    entryCount: 0,
    bytesUsed: 0,
    installedAt: now,
    installedByOrigin: normalizeOrigin(args.origin) || undefined,
    catalogContext,
  }
  upsertStoredIndexPack(pack)

  void (async () => {
    const key = manifest.packId
    if (syncInFlight.has(key)) return
    const job = runPackSync({
      packId: key,
      origin: args.origin,
      activityId,
      fetchImpl: args.fetchImpl,
      replace: true,
    })
      .then(() => {
        recordWalletEvent({
          origin: args.origin,
          method: 'index-install',
          note: `Installed ${manifest.name}`,
          item: previewItemFromManifest(manifest),
          status: 'complete',
        })
      })
      .catch(() => {})
      .finally(() => {
        syncInFlight.delete(key)
      })
    syncInFlight.set(key, job)
    await job
  })()

  return { packId: manifest.packId, status: 'installing', activityId }
}

export function listIndexExpansions(): { packs: ReturnType<typeof packSummary>[] } {
  return { packs: listStoredIndexPacks().map(packSummary) }
}

/** Installed catalog packs requested by one connected app origin. */
export function listIndexPacksForOrigin(origin: string): ReturnType<typeof packSummary>[] {
  const key = normalizeOrigin(origin)
  if (!key) return []
  return listStoredIndexPacks()
    .filter((pack) => pack.installedByOrigin === key)
    .map(packSummary)
}

export function removeIndexExpansion(args: { packId: string }): { removed: boolean } {
  const pack = getStoredIndexPack(args.packId)
  if (!pack) return { removed: false }
  removeStoredIndexPack(args.packId)
  return { removed: true }
}

export async function syncIndexExpansion(args: {
  body: SyncIndexExpansionArgs
  origin?: string
  fetchImpl?: typeof fetch
}): Promise<{ packId: string; status: string }> {
  const packId = args.body.packId?.trim()
  if (!packId) throw new Error('packId is required')
  const existing = getStoredIndexPack(packId)
  if (!existing) throw new Error(`Pack "${packId}" is not installed`)

  if (!args.body.force) {
    const policy = existing.manifest.updatePolicy?.mode ?? 'manual'
    if (policy === 'manual') {
      // Caller must pass force after user approves sync prompt.
    }
  }

  if (syncInFlight.has(packId)) {
    await syncInFlight.get(packId)
  } else {
    const job = runPackSync({
      packId,
      origin: args.origin,
      fetchImpl: args.fetchImpl,
      replace: false,
    }).finally(() => syncInFlight.delete(packId))
    syncInFlight.set(packId, job.then(() => {}))
    await job
  }

  const updated = getStoredIndexPack(packId)
  return { packId, status: updated?.status ?? 'ready' }
}

export async function listIndexExpansionEntries(
  args: ListIndexExpansionEntriesArgs,
  fetchImpl?: typeof fetch,
) {
  const packId = args.packId?.trim()
  if (!packId) throw new Error('packId is required')
  const pack = getStoredIndexPack(packId)
  if (!pack) {
    return { outputs: [], totalOutputs: 0 }
  }

  if (args.live) {
    const lookup = await fetchOverlayLookup({
      manifest: pack.manifest,
      fetchImpl,
      maxEntries: args.limit ?? pack.manifest.budget.maxEntries,
    })
    const page = overlayOutputsToListOutputs(lookup.outputs, packId)
    return {
      ...page,
      live: true,
      host: lookup.host,
      hostsTried: lookup.hostsTried,
      truncated: lookup.truncated,
    }
  }

  return queryStoredIndexEntries({
    packId,
    tags: args.tags,
    limit: args.limit,
    offset: args.offset,
  })
}

/** Live BRC-24 overlay lookup — authoritative read, no local persistence. */
export async function overlayLookup(args: {
  body: OverlayLookupArgs
  fetchImpl?: typeof fetch
}) {
  const body = args.body
  const lookupService = body.lookupService?.trim()
  if (!lookupService) throw new Error('lookupService is required')

  let req = {
    lookupService,
    query: body.query ?? {},
    overlayBaseUrl: body.overlayBaseUrl,
    discovery: body.discovery ?? 'auto',
    slapTrackers: body.slapTrackers,
    extraHosts: body.extraHosts,
    maxOutputs: body.maxOutputs,
  } satisfies OverlayLookupArgs

  if (body.packId) {
    const pack = getStoredIndexPack(body.packId.trim())
    if (!pack) throw new Error(`Pack "${body.packId}" is not installed`)
    const fromManifest = overlayRequestFromManifest(pack.manifest)
    req = {
      ...req,
      lookupService: fromManifest.lookupService,
      query: body.query ?? fromManifest.query ?? {},
      overlayBaseUrl: fromManifest.overlayBaseUrl,
      discovery: fromManifest.discovery ?? 'auto',
      slapTrackers: fromManifest.slapTrackers,
      extraHosts: fromManifest.extraHosts,
    }
  }

  const result = await liveOverlayLookup(req, args.fetchImpl)
  const page = overlayOutputsToListOutputs(result.outputs, body.packId?.trim())
  return {
    type: result.type,
    ...page,
    live: true,
    host: result.host,
    hostsTried: result.hostsTried,
    truncated: result.truncated,
  }
}

/** Intercept listOutputs for basket `index`. */
export function listIndexBasketOutputs(args: unknown): Record<string, unknown> {
  const body =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {}
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string')
    : []
  const packTag = tags.find((t) => t.startsWith('pack:'))
  const packId = packTag?.slice('pack:'.length)

  if (packId) {
    return queryStoredIndexEntries({
      packId,
      tags: tags.filter((t) => !t.startsWith('pack:')),
      limit: body.limit as number | undefined,
      offset: body.offset as number | undefined,
    })
  }

  const all: ReturnType<typeof queryStoredIndexEntries> = {
    outputs: [],
    totalOutputs: 0,
  }
  for (const pack of listStoredIndexPacks()) {
    const page = queryStoredIndexEntries({
      packId: pack.packId,
      limit: body.limit as number | undefined,
      offset: body.offset as number | undefined,
    })
    all.outputs.push(...page.outputs)
    all.totalOutputs += page.totalOutputs
  }
  return all
}

export function clearIndexExpansionRuntimeForTests(): void {
  syncInFlight.clear()
}
