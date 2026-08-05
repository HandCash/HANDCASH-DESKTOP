/**
 * Item (collectable / NFT) permission helpers.
 *
 * Pay / auto-pay never cover spending or viewing basket items.
 * View can be all-inventory or limited to collections / creators / origins.
 *
 * BRC-99 P-baskets: apps may request `p 1sat <scope>` instead of the coarse
 * storage basket `1sat`. Storage always remains `1sat`; the P form only
 * shapes permission prompts and list/filter scope.
 */

import { normalizeAppHost } from './appIdentity'

/** Storage basket that holds collectables — not spendable under normal pay. */
export const ITEM_STORAGE_BASKET = '1sat'

/** BRC-99 permission scheme ID for 1Sat collectables. */
export const ITEM_SCHEME = '1sat'

/** Baskets that hold collectables — not spendable under normal pay.
 * Recursive inscription content (HTML/JS that references other inscriptions)
 * still lives on 1-sat tips in basket `1sat` — same remittance + BRC-39 path.
 */
export const ITEM_BASKETS = new Set([ITEM_STORAGE_BASKET])

export type ItemAccess = {
  /** Inventory visibility for this app. */
  view: 'none' | 'all' | 'filtered'
  /** Allowed collection ids when view === 'filtered'. */
  collections: string[]
  /** Allowed creator / app ids when view === 'filtered'. */
  creators: string[]
  /** Allowed inscription origins (`txid_vout`) when view === 'filtered'. */
  origins: string[]
  /** May createAction / relinquish that spends an item. */
  canSend: boolean
  /** May internalize into an item basket. */
  canReceive: boolean
}

export const DEFAULT_ITEM_ACCESS: ItemAccess = {
  view: 'none',
  collections: [],
  creators: [],
  origins: [],
  canSend: false,
  canReceive: false,
}

export type ItemViewRequest = {
  collections: string[]
  creators: string[]
  origins: string[]
  /** True when the app did not narrow by collection/creator/origin. */
  wantsAll: boolean
}

export type PBasket = {
  scheme: string
  /** Scope token after the scheme (e.g. `*`, `collection:foo`). */
  rest: string
}

function asRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  return {}
}

function tagValues(tags: string[], prefixes: string[]): string[] {
  const out: string[] = []
  for (const tag of tags) {
    for (const prefix of prefixes) {
      if (tag.startsWith(prefix)) {
        const v = tag.slice(prefix.length).trim()
        if (v) out.push(v)
      }
    }
  }
  return out
}

/**
 * Parse a BRC-99 P-basket ID: `p <scheme> <rest>`.
 * Returns null when the ID is not a P-basket (including plain `1sat`).
 */
export function parsePBasket(basket: unknown): PBasket | null {
  if (typeof basket !== 'string') return null
  const raw = basket.trim()
  if (!raw.startsWith('p ')) return null
  const after = raw.slice(2).trim()
  if (!after) return null
  const sp = after.indexOf(' ')
  if (sp < 0) {
    // `p 1sat` with no scope — treat as all
    if (!after || /\s/.test(after)) return null
    return { scheme: after, rest: '*' }
  }
  const scheme = after.slice(0, sp)
  const rest = after.slice(sp + 1).trim()
  if (!scheme || /\s/.test(scheme)) return null
  return { scheme, rest: rest || '*' }
}

/** True when basket is `p …` but not a scheme we implement. */
export function isUnsupportedPBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const raw = basket.trim()
  if (!raw.startsWith('p ')) return false
  const parsed = parsePBasket(raw)
  if (!parsed) return true
  return parsed.scheme.toLowerCase() !== ITEM_SCHEME
}

/** True for plain `1sat` or BRC-99 `p 1sat <scope>`. */
export function isItemBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const t = basket.trim()
  if (ITEM_BASKETS.has(t.toLowerCase())) return true
  const p = parsePBasket(t)
  return !!p && p.scheme.toLowerCase() === ITEM_SCHEME
}

function scopeFromPRest(rest: string): Pick<ItemViewRequest, 'collections' | 'creators' | 'origins' | 'wantsAll'> {
  const token = rest.trim()
  if (!token || token === '*') {
    return { collections: [], creators: [], origins: [], wantsAll: true }
  }
  if (token.startsWith('collection:') || token.startsWith('collectionId:')) {
    const id = token.slice(token.indexOf(':') + 1).trim()
    return {
      collections: id ? [id] : [],
      creators: [],
      origins: [],
      wantsAll: !id,
    }
  }
  if (token.startsWith('creator:') || token.startsWith('app:') || token.startsWith('author:')) {
    const id = token.slice(token.indexOf(':') + 1).trim()
    return {
      collections: [],
      creators: id ? [id] : [],
      origins: [],
      wantsAll: !id,
    }
  }
  if (token.startsWith('origin:')) {
    const id = token.slice('origin:'.length).trim()
    return {
      collections: [],
      creators: [],
      origins: id ? [id] : [],
      wantsAll: !id,
    }
  }
  // Unknown scope token — treat as all so the user still sees a clear prompt.
  return { collections: [], creators: [], origins: [], wantsAll: true }
}

function tagsForScope(request: ItemViewRequest): string[] {
  const tags: string[] = []
  for (const c of request.collections) tags.push(`collection:${c}`)
  for (const c of request.creators) tags.push(`creator:${c}`)
  for (const o of request.origins) tags.push(`origin:${o}`)
  return tags
}

export function parseItemViewRequest(args: unknown): ItemViewRequest {
  const body = asRecord(args)
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string')
    : []
  const collections = [
    ...new Set(tagValues(tags, ['collection:', 'collectionId:'])),
  ]
  const creators = [
    ...new Set(tagValues(tags, ['app:', 'creator:', 'author:'])),
  ]
  const origins = [...new Set(tagValues(tags, ['origin:']))]

  const p = parsePBasket(body.basket)
  if (p && p.scheme.toLowerCase() === ITEM_SCHEME) {
    const scoped = scopeFromPRest(p.rest)
    const mergedCollections = [...new Set([...collections, ...scoped.collections])]
    const mergedCreators = [...new Set([...creators, ...scoped.creators])]
    const mergedOrigins = [...new Set([...origins, ...scoped.origins])]
    const wantsAll =
      scoped.wantsAll &&
      mergedCollections.length === 0 &&
      mergedCreators.length === 0 &&
      mergedOrigins.length === 0
    return {
      collections: mergedCollections,
      creators: mergedCreators,
      origins: mergedOrigins,
      wantsAll,
    }
  }

  return {
    collections,
    creators,
    origins,
    wantsAll:
      collections.length === 0 && creators.length === 0 && origins.length === 0,
  }
}

/**
 * Rewrite BRC-99 `p 1sat …` baskets to the storage basket `1sat`, merging
 * scope into listOutputs tags. Rejects unsupported `p` schemes.
 */
export function prepareItemBasketArgs(args: unknown): {
  args: unknown
  error?: { code: string; description: string }
} {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { args }
  }

  const walkError = findUnsupportedPBasket(args)
  if (walkError) {
    return {
      args,
      error: {
        code: 'UNSUPPORTED_P_BASKET',
        description: walkError,
      },
    }
  }

  const body = { ...(args as Record<string, unknown>) }
  let changed = false

  if (typeof body.basket === 'string' && isItemBasket(body.basket)) {
    const p = parsePBasket(body.basket)
    if (p) {
      const request = parseItemViewRequest(body)
      const existing = Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === 'string')
        : []
      body.basket = ITEM_STORAGE_BASKET
      body.tags = [...new Set([...existing, ...tagsForScope(request)])]
      changed = true
    }
  }

  if (Array.isArray(body.outputs)) {
    body.outputs = body.outputs.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const out = { ...(raw as Record<string, unknown>) }
      if (typeof out.basket === 'string' && isItemBasket(out.basket) && parsePBasket(out.basket)) {
        out.basket = ITEM_STORAGE_BASKET
        changed = true
      }
      if (out.protocol === 'basket insertion') {
        const rem =
          out.insertionRemittance && typeof out.insertionRemittance === 'object'
            ? { ...(out.insertionRemittance as Record<string, unknown>) }
            : null
        if (rem && typeof rem.basket === 'string' && isItemBasket(rem.basket) && parsePBasket(rem.basket)) {
          rem.basket = ITEM_STORAGE_BASKET
          out.insertionRemittance = rem
          changed = true
        }
      }
      return out
    })
  }

  return { args: changed ? body : args }
}

function findUnsupportedPBasket(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null
  if (typeof value === 'string') {
    if (isUnsupportedPBasket(value)) {
      return `Unsupported permission basket "${value}". Only scheme "1sat" is implemented (use "p 1sat <scope>" or plain "1sat").`
    }
    return null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const err = findUnsupportedPBasket(item, depth + 1)
      if (err) return err
    }
    return null
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'basket' && typeof child === 'string' && isUnsupportedPBasket(child)) {
        return `Unsupported permission basket "${child}". Only scheme "1sat" is implemented (use "p 1sat <scope>" or plain "1sat").`
      }
      const err = findUnsupportedPBasket(child, depth + 1)
      if (err) return err
    }
  }
  return null
}

/** True when createAction / labels / outputs look like an ordinal / NFT transfer. */
export function isItemSpendArgs(method: string, args: unknown): boolean {
  if (method === 'relinquishOutput') {
    const body = asRecord(args)
    return isItemBasket(body.basket)
  }
  if (method !== 'createAction' && method !== 'signAction') return false

  const body = asRecord(args)
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string')
    : []
  if (
    labels.some((l) =>
      /^1sat$/i.test(l) || /collectable|ordinal|nft/i.test(l),
    )
  ) {
    return true
  }

  const inputs = Array.isArray(body.inputs) ? body.inputs : []
  for (const raw of inputs) {
    if (!raw || typeof raw !== 'object') continue
    const desc = (raw as { inputDescription?: unknown }).inputDescription
    if (typeof desc === 'string' && /1sat|ordinal|collectable|nft/i.test(desc)) {
      return true
    }
  }

  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const out = raw as Record<string, unknown>
    if (isItemBasket(out.basket)) return true
    const tags = Array.isArray(out.tags)
      ? out.tags.filter((t): t is string => typeof t === 'string')
      : []
    if (tags.some((t) => /^ordinal$/i.test(t) || /^origin:/i.test(t))) {
      return true
    }
    if (
      out.satoshis === 1 &&
      typeof out.outputDescription === 'string' &&
      /collectable|ordinal|nft/i.test(out.outputDescription)
    ) {
      return true
    }
  }

  // Explicit inputs + 1-sat tagged transfer (common ordinal pattern).
  if (inputs.length > 0) {
    for (const raw of outputs) {
      if (!raw || typeof raw !== 'object') continue
      const out = raw as Record<string, unknown>
      const tags = Array.isArray(out.tags)
        ? out.tags.filter((t): t is string => typeof t === 'string')
        : []
      if (out.satoshis === 1 && tags.length > 0) return true
    }
  }

  return false
}

/** Basket insertion of collectables (receive / import). */
export function isItemReceiveArgs(method: string, args: unknown): boolean {
  if (method !== 'internalizeAction') return false
  const body = asRecord(args)
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string')
    : []
  if (labels.some((l) => /^1sat$/i.test(l) || /ordinal|collectable/i.test(l))) {
    return true
  }
  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const out = raw as Record<string, unknown>
    if (out.protocol === 'basket insertion') {
      const rem =
        out.insertionRemittance && typeof out.insertionRemittance === 'object'
          ? (out.insertionRemittance as Record<string, unknown>)
          : null
      if (rem && isItemBasket(rem.basket)) return true
    }
  }
  return false
}

export function normalizeItemAccess(raw: unknown): ItemAccess {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ITEM_ACCESS }
  const o = raw as Partial<ItemAccess>
  const view =
    o.view === 'all' || o.view === 'filtered' || o.view === 'none' ? o.view : 'none'
  return {
    view,
    collections: Array.isArray(o.collections)
      ? o.collections.filter((c): c is string => typeof c === 'string' && !!c.trim())
      : [],
    creators: Array.isArray(o.creators)
      ? o.creators.filter((c): c is string => typeof c === 'string' && !!c.trim())
      : [],
    origins: Array.isArray(o.origins)
      ? o.origins.filter((c): c is string => typeof c === 'string' && !!c.trim())
      : [],
    canSend: !!o.canSend,
    canReceive: !!o.canReceive,
  }
}

export function mergeItemViewGrant(
  current: ItemAccess,
  request: ItemViewRequest,
): ItemAccess {
  if (request.wantsAll || current.view === 'all') {
    return { ...current, view: 'all' }
  }
  const collections = [...new Set([...current.collections, ...request.collections])]
  const creators = [...new Set([...current.creators, ...request.creators])]
  const origins = [...new Set([...current.origins, ...request.origins])]
  return {
    ...current,
    view: 'filtered',
    collections,
    creators,
    origins,
  }
}

/** Whether an existing grant already covers this listOutputs request. */
export function itemViewGranted(access: ItemAccess, request: ItemViewRequest): boolean {
  if (access.view === 'none') return false
  if (access.view === 'all') return true
  if (request.wantsAll) return false
  const collectionsOk =
    request.collections.length === 0 ||
    request.collections.every((c) => access.collections.includes(c))
  const creatorsOk =
    request.creators.length === 0 ||
    request.creators.every((c) => access.creators.includes(c))
  const originsOk =
    request.origins.length === 0 ||
    request.origins.every((o) => access.origins.includes(o))
  return collectionsOk && creatorsOk && originsOk
}

export function outputMatchesItemAccess(
  access: ItemAccess,
  tags: string[] | undefined,
  customInstructions?: string,
): boolean {
  if (access.view === 'all') return true
  if (access.view === 'none') return false

  const tagList = tags ?? []
  let app: string | undefined
  let collectionId: string | undefined
  let origin: string | undefined
  for (const t of tagList) {
    if (t.startsWith('app:') || t.startsWith('creator:') || t.startsWith('author:')) {
      app = t.split(':').slice(1).join(':')
    }
    if (t.startsWith('collection:') || t.startsWith('collectionId:')) {
      collectionId = t.split(':').slice(1).join(':')
    }
    if (t.startsWith('origin:')) {
      origin = t.slice('origin:'.length)
    }
  }
  if (customInstructions) {
    try {
      const o = JSON.parse(customInstructions) as Record<string, unknown>
      if (typeof o.app === 'string') app = app ?? o.app
      if (typeof o.collectionId === 'string') collectionId = collectionId ?? o.collectionId
      if (typeof o.creator === 'string') app = app ?? o.creator
      if (typeof o.origin === 'string') origin = origin ?? o.origin
    } catch {
      // ignore
    }
  }

  const collectionOk =
    access.collections.length === 0 ||
    (!!collectionId && access.collections.includes(collectionId))
  const creatorOk =
    access.creators.length === 0 || (!!app && access.creators.includes(app))
  const originOk =
    access.origins.length === 0 || (!!origin && access.origins.includes(origin))

  const filters: boolean[] = []
  if (access.collections.length > 0) filters.push(collectionOk)
  if (access.creators.length > 0) filters.push(creatorOk)
  if (access.origins.length > 0) filters.push(originOk)
  if (filters.length === 0) return false
  return filters.every(Boolean)
}

export function itemAccessOriginKey(origin: string | undefined): string {
  return normalizeAppHost(origin)
}
