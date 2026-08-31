/**
 * BRC-230 `p index` permission helpers — grade-C catalog mirrors, not custody.
 */

import { parsePBasket, type PBasket } from './itemAccess'
import {
  INDEX_SCHEME,
  INDEX_STORAGE_BASKET,
} from './indexExpansionTypes'

export type IndexPermissionOp = 'install' | 'read' | 'sync'

export type IndexAccess = {
  /** Pack ids this origin may install/read/sync. */
  packs: string[]
  /** lookupService ids approved for live overlayLookup (no installed pack). */
  lookupServices?: string[]
}

export const DEFAULT_INDEX_ACCESS: IndexAccess = { packs: [], lookupServices: [] }

export type IndexReadRequest = {
  packId: string
}

export function normalizeIndexAccess(raw: unknown): IndexAccess {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_INDEX_ACCESS }
  const body = raw as { packs?: unknown; lookupServices?: unknown }
  const packs = Array.isArray(body.packs)
    ? [...new Set(body.packs.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim()))]
    : []
  const lookupServices = Array.isArray(body.lookupServices)
    ? [
        ...new Set(
          body.lookupServices
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .map((s) => s.trim()),
        ),
      ]
    : []
  return { packs, lookupServices }
}

export function isIndexScheme(scheme: string): boolean {
  return scheme.toLowerCase() === INDEX_SCHEME
}

/** Plain storage basket or `p index read <packId>`. */
export function isIndexBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const t = basket.trim()
  if (t.toLowerCase() === INDEX_STORAGE_BASKET) return true
  const p = parsePBasket(t)
  return !!p && isIndexScheme(p.scheme) && p.rest.toLowerCase().startsWith('read ')
}

export function parseIndexPermissionBasket(basket: unknown): {
  op: IndexPermissionOp
  packId: string
} | null {
  if (typeof basket !== 'string') return null
  const p = parsePBasket(basket.trim())
  if (!p || !isIndexScheme(p.scheme)) return null
  const parts = p.rest.trim().split(/\s+/)
  if (parts.length < 2) return null
  const op = parts[0]?.toLowerCase()
  const packId = parts.slice(1).join(' ').trim()
  if (op !== 'install' && op !== 'read' && op !== 'sync') return null
  if (!packId) return null
  return { op, packId }
}

export function parseIndexReadRequest(args: unknown): IndexReadRequest | null {
  const body =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : null
  if (!body) return null
  if (typeof body.basket !== 'string') return null
  const parsed = parseIndexPermissionBasket(body.basket)
  if (!parsed || parsed.op !== 'read') return null
  return { packId: parsed.packId }
}

export function indexAccessGranted(access: IndexAccess, packId: string): boolean {
  return access.packs.includes(packId)
}

export function overlayLookupAccessGranted(access: IndexAccess, lookupService: string): boolean {
  return (access.lookupServices ?? []).includes(lookupService)
}

export function mergeIndexGrant(access: IndexAccess, packId: string): IndexAccess {
  if (access.packs.includes(packId)) return access
  return { ...access, packs: [...access.packs, packId] }
}

export function mergeOverlayLookupGrant(
  access: IndexAccess,
  lookupService: string,
): IndexAccess {
  const lookupServices = access.lookupServices ?? []
  if (lookupServices.includes(lookupService)) return access
  return { ...access, lookupServices: [...lookupServices, lookupService] }
}

/**
 * Rewrite `p index read <packId>` → basket `index` with `pack:<packId>` tag.
 * Returns error for unsupported `p index` ops on listOutputs wire.
 */
export function prepareIndexBasketArgs(args: unknown): {
  args: unknown
  error?: { code: string; description: string }
  indexReadRequest?: IndexReadRequest
} {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { args }
  }
  const body = { ...(args as Record<string, unknown>) }
  if (typeof body.basket !== 'string') return { args }

  const parsed = parseIndexPermissionBasket(body.basket)
  if (!parsed) {
    if (body.basket.trim().toLowerCase() === INDEX_STORAGE_BASKET) {
      return { args, indexReadRequest: null as unknown as undefined }
    }
    return { args }
  }

  if (parsed.op === 'read') {
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === 'string')
      : []
    if (!tags.some((t) => t === `pack:${parsed.packId}`)) {
      body.tags = [...tags, `pack:${parsed.packId}`]
    }
    body.basket = INDEX_STORAGE_BASKET
    body.includeTags = true
    return {
      args: body,
      indexReadRequest: { packId: parsed.packId },
    }
  }

  return {
    args,
    error: {
      code: 'INVALID_INDEX_BASKET',
      description:
        'Use installIndexExpansion / syncIndexExpansion methods, or "p index read <packId>" for listOutputs.',
    },
  }
}

export function isIndexPermissionBasket(basket: unknown): boolean {
  return parseIndexPermissionBasket(basket) != null
}

export function indexSchemeFromPBasket(p: PBasket | null): boolean {
  return !!p && isIndexScheme(p.scheme)
}
