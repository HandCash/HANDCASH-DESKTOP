import type { IndexCatalogContext, IndexExpansionManifest } from './indexExpansionTypes'
import { isIndexCatalogContext } from './indexExpansionTypes'

const PACK_ID_RE = /^[a-z0-9][a-z0-9.-]*$/
const TOPIC_RE = /^tm_[a-z0-9_]+$/
const LOOKUP_RE = /^ls_[a-z0-9_]+$/
const PUBKEY_RE = /^(02|03)[0-9a-f]{64}$/

export class IndexManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IndexManifestError'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function readString(
  body: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; maxLen?: number } = {},
): string | undefined {
  const raw = body[key]
  if (raw == null || raw === '') {
    if (opts.required) throw new IndexManifestError(`Manifest field "${key}" is required`)
    return undefined
  }
  if (typeof raw !== 'string') {
    throw new IndexManifestError(`Manifest field "${key}" must be a string`)
  }
  const trimmed = raw.trim()
  if (!trimmed && opts.required) {
    throw new IndexManifestError(`Manifest field "${key}" is required`)
  }
  if (opts.maxLen != null && trimmed.length > opts.maxLen) {
    throw new IndexManifestError(`Manifest field "${key}" exceeds ${opts.maxLen} characters`)
  }
  return trimmed
}

function readPositiveInt(
  body: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; max?: number } = {},
): number | undefined {
  const raw = body[key]
  if (raw == null) {
    if (opts.required) throw new IndexManifestError(`Manifest field "${key}" is required`)
    return undefined
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new IndexManifestError(`Manifest field "${key}" must be a positive integer`)
  }
  if (opts.max != null && raw > opts.max) {
    throw new IndexManifestError(`Manifest field "${key}" exceeds maximum ${opts.max}`)
  }
  return raw
}

function readNonNegativeInt(body: Record<string, unknown>, key: string): number | undefined {
  const raw = body[key]
  if (raw == null) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new IndexManifestError(`Manifest field "${key}" must be a non-negative integer`)
  }
  return raw
}

/** Validate and normalize a BRC-230 manifest (v1). */
export function validateIndexExpansionManifest(raw: unknown): IndexExpansionManifest {
  const body = asRecord(raw)
  if (!body) throw new IndexManifestError('Manifest must be a JSON object')

  if (body.v !== 1) throw new IndexManifestError('Manifest version must be 1')

  const packId = readString(body, 'packId', { required: true, maxLen: 128 })!
  if (!PACK_ID_RE.test(packId)) {
    throw new IndexManifestError(
      'packId must match [a-z0-9][a-z0-9.-]* (1–128 chars)',
    )
  }

  const name = readString(body, 'name', { required: true, maxLen: 80 })!
  const description = readString(body, 'description', { maxLen: 512 })
  const iconUrl = readString(body, 'iconUrl')
  const curatorIdentityKey = readString(body, 'curatorIdentityKey')
  if (curatorIdentityKey && !PUBKEY_RE.test(curatorIdentityKey)) {
    throw new IndexManifestError('curatorIdentityKey must be a compressed secp256k1 pubkey')
  }

  const discoveryBody = asRecord(body.discovery)
  let discovery: IndexExpansionManifest['discovery']
  if (discoveryBody) {
    const mode = readString(discoveryBody, 'mode')
    if (mode && mode !== 'auto' && mode !== 'slap' && mode !== 'url') {
      throw new IndexManifestError('discovery.mode must be auto, slap, or url')
    }
    const hosts = Array.isArray(discoveryBody.hosts)
      ? discoveryBody.hosts.filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
      : undefined
    const slapTrackers = Array.isArray(discoveryBody.slapTrackers)
      ? discoveryBody.slapTrackers.filter(
          (h): h is string => typeof h === 'string' && h.trim().length > 0,
        )
      : undefined
    discovery = {
      ...(mode ? { mode: mode as 'auto' | 'slap' | 'url' } : {}),
      ...(hosts?.length ? { hosts } : {}),
      ...(slapTrackers?.length ? { slapTrackers } : {}),
    }
  }
  const discoveryMode = discovery?.mode ?? 'auto'
  const overlayBaseUrlRaw = readString(body, 'overlayBaseUrl', {
    required: discoveryMode === 'url',
  })
  if (!overlayBaseUrlRaw && discoveryMode === 'url') {
    throw new IndexManifestError('overlayBaseUrl is required when discovery.mode is url')
  }
  let overlayBaseUrl: string | undefined
  if (overlayBaseUrlRaw) {
    try {
      const url = new URL(overlayBaseUrlRaw)
      if (url.protocol !== 'https:') {
        throw new IndexManifestError('overlayBaseUrl must use HTTPS')
      }
      overlayBaseUrl = overlayBaseUrlRaw.replace(/\/+$/, '')
    } catch (err) {
      if (err instanceof IndexManifestError) throw err
      throw new IndexManifestError('overlayBaseUrl must be a valid HTTPS URL')
    }
  }

  const topic = readString(body, 'topic', { required: true })!
  if (!TOPIC_RE.test(topic)) {
    throw new IndexManifestError('topic must match tm_<name>')
  }

  const lookupService = readString(body, 'lookupService', { required: true })!
  if (!LOOKUP_RE.test(lookupService)) {
    throw new IndexManifestError('lookupService must match ls_<name>')
  }

  const scopeBody = asRecord(body.scope)
  if (!scopeBody) throw new IndexManifestError('scope is required')
  const kind = readString(scopeBody, 'kind', { required: true })!
  if (kind !== 'overlay-query' && kind !== 'collection' && kind !== 'feed') {
    throw new IndexManifestError('scope.kind must be overlay-query, collection, or feed')
  }
  const query = asRecord(scopeBody.query) ?? {}
  if (kind === 'collection') {
    const collectionId = query.collectionId
    if (typeof collectionId !== 'string' || !collectionId.trim()) {
      throw new IndexManifestError('scope.collection requires query.collectionId')
    }
  }

  const budgetBody = asRecord(body.budget)
  if (!budgetBody) throw new IndexManifestError('budget is required')
  const maxEntries = readPositiveInt(budgetBody, 'maxEntries', {
    required: true,
    max: 1_000_000,
  })!
  const maxBytes = readPositiveInt(budgetBody, 'maxBytes', { required: true })!
  const maxBeefBytes = readNonNegativeInt(budgetBody, 'maxBeefBytes')
  if (maxBeefBytes == null) {
    throw new IndexManifestError('budget.maxBeefBytes is required')
  }

  const previewBody = asRecord(body.preview)
  const preview =
    previewBody && typeof previewBody.beefB64 === 'string'
      ? { beefB64: previewBody.beefB64 }
      : undefined

  const updateBody = asRecord(body.updatePolicy)
  let updatePolicy: IndexExpansionManifest['updatePolicy']
  if (updateBody) {
    const mode = readString(updateBody, 'mode')
    const intervalSeconds = readNonNegativeInt(updateBody, 'intervalSeconds')
    if (mode && mode !== 'manual' && mode !== 'onOpen' && mode !== 'interval') {
      throw new IndexManifestError('updatePolicy.mode must be manual, onOpen, or interval')
    }
    if (mode === 'interval' && (intervalSeconds == null || intervalSeconds < 300)) {
      throw new IndexManifestError('updatePolicy.intervalSeconds must be ≥ 300 when mode is interval')
    }
    updatePolicy = {
      ...(mode ? { mode: mode as 'manual' | 'onOpen' | 'interval' } : {}),
      ...(intervalSeconds != null ? { intervalSeconds } : {}),
    }
  }

  const catalogContextRaw = readString(body, 'catalogContext')
  let catalogContext: IndexCatalogContext | undefined
  if (catalogContextRaw) {
    if (!isIndexCatalogContext(catalogContextRaw)) {
      throw new IndexManifestError(
        'catalogContext must be onesat-ordinal, bsv21-token, social-feed, or generic',
      )
    }
    catalogContext = catalogContextRaw
  }

  const manifest: IndexExpansionManifest = {
    v: 1,
    packId,
    name,
    topic,
    lookupService,
    scope: { kind: kind as IndexExpansionManifest['scope']['kind'], query },
    budget: { maxEntries, maxBytes, maxBeefBytes },
    ...(overlayBaseUrl ? { overlayBaseUrl } : {}),
    ...(description ? { description } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(curatorIdentityKey ? { curatorIdentityKey } : {}),
    ...(discovery ? { discovery } : {}),
    ...(preview ? { preview } : {}),
    ...(updatePolicy ? { updatePolicy } : {}),
    ...(catalogContext ? { catalogContext } : {}),
  }

  for (const [key, value] of Object.entries(body)) {
    if (!(key in manifest)) {
      manifest[key] = value
    }
  }

  return manifest
}

export async function fetchIndexExpansionManifest(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IndexExpansionManifest> {
  const trimmed = url.trim()
  if (!trimmed) throw new IndexManifestError('manifestUrl is required')
  let res: Response
  try {
    res = await fetchImpl(trimmed, {
      headers: { Accept: 'application/json' },
    })
  } catch (err) {
    throw new IndexManifestError(
      err instanceof Error ? err.message : 'Could not fetch manifest',
    )
  }
  if (!res.ok) {
    throw new IndexManifestError(`Manifest fetch failed (${res.status})`)
  }
  const json: unknown = await res.json()
  return validateIndexExpansionManifest(json)
}
