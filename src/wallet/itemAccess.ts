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
import { decodeBsv21Binary } from './bsv21Binary'

/** Storage basket that holds collectables — not spendable under normal pay. */
export const ITEM_STORAGE_BASKET = '1sat'

/** Storage basket for legacy BSV-21 fungibles — Collect tokens, not Pay currency. */
export const FUNGIBLE_STORAGE_BASKET = 'bsv21'

/** Storage basket for 1Sat fungibles (BRC-175). */
export const COLOUR_STORAGE_BASKET = '1sat-ft'

/** BRC-99 permission scheme ID for 1Sat collectables. */
export const ITEM_SCHEME = '1sat'

/** Baskets that hold collectables / tokens — not spendable under normal pay.
 * Recursive inscription content (HTML/JS that references other inscriptions)
 * still lives on 1-sat tips in basket `1sat` — same remittance + BRC-39 path.
 * 1Sat fungibles live in `1sat-ft` (tip→origin, face-value `amt`). Legacy BSV-21 tips live
 * in `bsv21`. Neither is Pay / balanceView.
 */
export const ITEM_BASKETS = new Set([
  ITEM_STORAGE_BASKET,
  FUNGIBLE_STORAGE_BASKET,
  COLOUR_STORAGE_BASKET,
])

/** BRC-99 permission scheme ID for BSV-21 tokens. */
export const TOKEN_SCHEME = 'bsv21'

export type ItemAccess = {
  /** Inventory visibility for this app. */
  view: 'none' | 'all' | 'filtered'
  /** Allowed collection ids when view === 'filtered'. */
  collections: string[]
  /** Allowed application ids when view === 'filtered'. */
  apps: string[]
  /** Allowed creator ids when view === 'filtered'. */
  creators: string[]
  /** Allowed BRC-164 held-row keys when view === 'filtered'. */
  ids: string[]
  /** May internalize into an item basket. */
  canReceive: boolean
}

export const DEFAULT_ITEM_ACCESS: ItemAccess = {
  view: 'none',
  collections: [],
  apps: [],
  creators: [],
  ids: [],
  canReceive: false,
}

/** Inventory visibility for BSV-21 tokens — never implied by item view. */
export type TokenAccess = {
  view: 'none' | 'all' | 'filtered'
  /** Allowed token ids (deploy outpoints) when view === 'filtered'. */
  ids: string[]
}

export const DEFAULT_TOKEN_ACCESS: TokenAccess = {
  view: 'none',
  ids: [],
}

export type TokenViewScope = 'plain' | 'all' | 'id'

export type TokenViewRequest = {
  scope: TokenViewScope
  ids: string[]
  /** True for plain `bsv21` or `p bsv21 all`. */
  wantsAll: boolean
}

export type ItemViewScope = 'plain' | 'all' | 'collection' | 'app' | 'creator' | 'id'

export type ItemViewRequest = {
  scope: ItemViewScope
  collections: string[]
  apps: string[]
  creators: string[]
  ids: string[]
  /** True for plain `1sat` or `p 1sat all`. */
  wantsAll: boolean
}

export type PBasket = {
  scheme: string
  /** Scope token after the scheme (e.g. `all`, `collection`). */
  rest: string
}

function asRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  return {}
}

/** Stamp a BRC-164 held-row key unless the writer already supplied one. */
export function stampBrc164Id(tags: unknown): string[] {
  const current = Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  if (current.some((tag) => tag.toLowerCase().startsWith('id:') && tag.length > 3)) {
    return current
  }
  const key = globalThis.crypto.randomUUID().replaceAll('-', '').toLowerCase()
  return [...current, `id:${key}`]
}

/** BRC-165 held-row keys named by this action's spend labels. */
export function p1SatSpendIds(args: unknown): string[] {
  const labels = asRecord(args).labels
  if (!Array.isArray(labels)) return []
  const ids = labels.flatMap((label) => {
    if (typeof label !== 'string') return []
    const match = /^p 1sat input id ([^\s]+)$/.exec(label)
    return match?.[1] ? [match[1].toLowerCase()] : []
  })
  return [...new Set(ids)]
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
    if (!after || /\s/.test(after)) return null
      return { scheme: after, rest: '' }
  }
  const scheme = after.slice(0, sp)
  const rest = after.slice(sp + 1).trim()
  if (!scheme || /\s/.test(scheme)) return null
  return { scheme, rest }
}

/** True when basket is `p …` but not a scheme we implement. */
export function isUnsupportedPBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const raw = basket.trim()
  if (!raw.startsWith('p ')) return false
  const parsed = parsePBasket(raw)
  if (!parsed) return true
  const scheme = parsed.scheme.toLowerCase()
  return scheme !== ITEM_SCHEME && scheme !== TOKEN_SCHEME
}

/**
 * Collectable view / spend basket: plain `1sat` or BRC-99 `p 1sat <scope>`.
 * `bsv21` and `1sat-ft` are not item view — they have their own gates.
 */
export function isItemBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const t = basket.trim()
  if (t.toLowerCase() === ITEM_STORAGE_BASKET) return true
  const p = parsePBasket(t)
  return !!p && p.scheme.toLowerCase() === ITEM_SCHEME
}

/** Token view basket: plain `bsv21` or BRC-99 `p bsv21 <scope>`. */
export function isTokenViewBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const t = basket.trim()
  if (t.toLowerCase() === FUNGIBLE_STORAGE_BASKET) return true
  const p = parsePBasket(t)
  return !!p && p.scheme.toLowerCase() === TOKEN_SCHEME
}

/**
 * HTTP BRC-100 callers with an originator are third-party.
 * Missing originator is the wallet's own Collect / internal path.
 */
export function isThirdPartyOriginator(origin: string | undefined): boolean {
  return typeof origin === 'string' && origin.trim().length > 0
}

export function parseItemViewRequest(args: unknown): ItemViewRequest {
  const body = asRecord(args)
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string')
    : []
  const p = parsePBasket(body.basket)
  if (p && p.scheme.toLowerCase() === ITEM_SCHEME) {
      const scope = p.rest.toLowerCase() as ItemViewScope
    return {
         scope,
         collections: scope === 'collection' ? [...new Set(tagValues(tags, ['collection:']))] : [],
         apps: scope === 'app' ? [...new Set(tagValues(tags, ['app:']))] : [],
         creators: scope === 'creator' ? [...new Set(tagValues(tags, ['creator:']))] : [],
         ids: scope === 'id' ? [...new Set(tagValues(tags, ['id:']))] : [],
         wantsAll: scope === 'all',
    }
  }

  return {
      scope: 'plain',
      collections: [],
      apps: [],
      creators: [],
      ids: [],
      wantsAll: true,
  }
}

export function parseTokenViewRequest(args: unknown): TokenViewRequest {
  const body = asRecord(args)
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string')
    : []
  const p = parsePBasket(body.basket)
  if (p && p.scheme.toLowerCase() === TOKEN_SCHEME) {
    const rest = p.rest.toLowerCase()
    const scope: TokenViewScope = rest === 'id' ? 'id' : 'all'
    return {
      scope,
      ids: scope === 'id' ? [...new Set([...tagValues(tags, ['id:']), ...tagValues(tags, ['bsv21:'])])] : [],
      wantsAll: scope !== 'id',
    }
  }
  return {
    scope: 'plain',
    ids: [],
    wantsAll: true,
  }
}

/**
 * Rewrite BRC-99 `p 1sat …` baskets to the storage basket `1sat`, merging
 * scope into listOutputs tags. Rejects unsupported `p` schemes.
 */
export function prepareItemBasketArgs(args: unknown): {
  args: unknown
  error?: { code: string; description: string }
   itemViewRequest?: ItemViewRequest
   tokenViewRequest?: TokenViewRequest
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
   let itemViewRequest: ItemViewRequest | undefined
   let tokenViewRequest: TokenViewRequest | undefined

  if (typeof body.basket === 'string' && isItemBasket(body.basket)) {
    const p = parsePBasket(body.basket)
    if (p) {
         const scope = p.rest.toLowerCase()
         const allowedScopes = new Set(['all', 'collection', 'app', 'creator', 'id'])
         if (!allowedScopes.has(scope) || p.rest !== scope) {
            return {
               args,
               error: {
                  code: 'INVALID_P1SAT_SCOPE',
                  description: 'Use exactly "p 1sat all|collection|app|creator|id"; filter values belong in tags.',
               },
            }
         }
         itemViewRequest = parseItemViewRequest(body)
         const axisValues = {
            collection: itemViewRequest.collections,
            app: itemViewRequest.apps,
            creator: itemViewRequest.creators,
            id: itemViewRequest.ids,
         }
         if (scope !== 'all' && axisValues[scope as keyof typeof axisValues].length === 0) {
            return {
               args,
               error: {
                  code: 'MISSING_P1SAT_SCOPE_TAG',
                  description: `Basket "p 1sat ${scope}" requires at least one "${scope}:<value>" tag.`,
               },
            }
         }
      body.basket = ITEM_STORAGE_BASKET
         body.includeTags = true
      changed = true
      } else {
         itemViewRequest = parseItemViewRequest(body)
    }
  } else if (typeof body.basket === 'string' && isTokenViewBasket(body.basket)) {
    const p = parsePBasket(body.basket)
    if (p) {
      const scope = p.rest.toLowerCase()
      const allowedScopes = new Set(['all', 'id'])
      if (!allowedScopes.has(scope) || p.rest !== scope) {
        return {
          args,
          error: {
            code: 'INVALID_PBSV21_SCOPE',
            description: 'Use exactly "p bsv21 all|id"; filter values belong in tags.',
          },
        }
      }
      tokenViewRequest = parseTokenViewRequest(body)
      if (scope === 'id' && tokenViewRequest.ids.length === 0) {
        return {
          args,
          error: {
            code: 'MISSING_PBSV21_SCOPE_TAG',
            description: 'Basket "p bsv21 id" requires at least one "id:<tokenId>" or "bsv21:<tokenId>" tag.',
          },
        }
      }
      body.basket = FUNGIBLE_STORAGE_BASKET
      body.includeTags = true
      changed = true
    } else {
      tokenViewRequest = parseTokenViewRequest(body)
    }
  }

  if (Array.isArray(body.outputs)) {
    body.outputs = body.outputs.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const out = { ...(raw as Record<string, unknown>) }
      if (typeof out.basket === 'string' && isItemBasket(out.basket)) {
        if (parsePBasket(out.basket)) out.basket = ITEM_STORAGE_BASKET
        out.tags = stampBrc164Id(out.tags)
        changed = true
      }
      if (out.protocol === 'basket insertion') {
        const rem =
          out.insertionRemittance && typeof out.insertionRemittance === 'object'
            ? { ...(out.insertionRemittance as Record<string, unknown>) }
            : null
        if (rem && typeof rem.basket === 'string' && isItemBasket(rem.basket)) {
          if (parsePBasket(rem.basket)) rem.basket = ITEM_STORAGE_BASKET
          rem.tags = stampBrc164Id(rem.tags)
          out.insertionRemittance = rem
          changed = true
        }
      }
      return out
    })
  }

  return { args: changed ? body : args, itemViewRequest, tokenViewRequest }
}

function findUnsupportedPBasket(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null
  if (typeof value === 'string') {
    if (isUnsupportedPBasket(value)) {
      return `Unsupported permission basket "${value}". Only schemes "1sat" and "bsv21" are implemented.`
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
        return `Unsupported permission basket "${child}". Only schemes "1sat" and "bsv21" are implemented.`
      }
      const err = findUnsupportedPBasket(child, depth + 1)
      if (err) return err
    }
  }
  return null
}

/** True when the basket is the 1Sat fungible storage basket. */
export function isColourBasket(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value.trim().toLowerCase() === COLOUR_STORAGE_BASKET
}

/**
 * True when createAction looks like 1Sat fungible mint (outputs only, 1sat-ft
 * basket, mint label) — permission copy says "Mint token".
 */
export function isColourIssuanceArgs(method: string, args: unknown): boolean {
  if (method !== 'createAction') return false
  const body = asRecord(args)
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string')
    : []
  if (labels.some((l) => /handcash-mint-1sat-ft|1sat-ft/i.test(l))) return true
  const inputs = Array.isArray(body.inputs) ? body.inputs : []
  if (inputs.length > 0) return false
  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  if (outputs.length === 0) return false
  let colourOuts = 0
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const out = raw as Record<string, unknown>
    if (isColourBasket(out.basket)) colourOuts += 1
    else if (
      Array.isArray(out.tags) &&
      out.tags.some((t) => typeof t === 'string' && /^1sat-ft$/i.test(t))
    ) {
      colourOuts += 1
    }
  }
  return colourOuts > 0 && colourOuts === outputs.length
}

/** True when createAction / labels / outputs look like a 1Sat fungible transfer. */
export function isColourSpendArgs(method: string, args: unknown): boolean {
  if (method === 'relinquishOutput') {
    return isColourBasket(asRecord(args).basket)
  }
  if (method !== 'createAction' && method !== 'signAction') return false

  const body = asRecord(args)
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string')
    : []
  if (
    labels.some(
      (l) => /^1sat-ft$/i.test(l) || /handcash-send-1sat-ft|handcash-combine-1sat-ft/i.test(l),
    )
  ) {
    return true
  }

  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const out = raw as Record<string, unknown>
    if (isColourBasket(out.basket)) return true
    const tags = Array.isArray(out.tags)
      ? out.tags.filter((t): t is string => typeof t === 'string')
      : []
    if (tags.some((t) => /^1sat-ft$/i.test(t))) return true
  }

  const inputs = Array.isArray(body.inputs) ? body.inputs : []
  for (const raw of inputs) {
    if (!raw || typeof raw !== 'object') continue
    const desc = (raw as { inputDescription?: unknown }).inputDescription
    if (typeof desc === 'string' && /(1sat-ft|1sat tip)/i.test(desc)) return true
  }

  return false
}

/** True when the basket is the BSV-21 fungible storage basket. */
export function isBsv21Basket(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().toLowerCase() === FUNGIBLE_STORAGE_BASKET
  )
}

/**
 * True when createAction / labels / outputs look like a BSV-21 fungible transfer.
 * Checked before {@link isItemSpendArgs} so permission copy says "Send token".
 */
export function isBsv21SpendArgs(method: string, args: unknown): boolean {
  if (method === 'relinquishOutput') {
    return isBsv21Basket(asRecord(args).basket)
  }
  if (method !== 'createAction' && method !== 'signAction') return false

  const body = asRecord(args)
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string')
    : []
  if (
    labels.some(
      (l) =>
        /^bsv21$/i.test(l) ||
        /handcash-send-token|fungible/i.test(l),
    )
  ) {
    return true
  }

  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const out = raw as Record<string, unknown>
    if (isBsv21Basket(out.basket)) return true
    const tags = Array.isArray(out.tags)
      ? out.tags.filter((t): t is string => typeof t === 'string')
      : []
    if (tags.some((t) => /^bsv21$/i.test(t) || /^bsv21:/i.test(t))) {
      return true
    }
    if (
      out.satoshis === 1 &&
      typeof out.outputDescription === 'string' &&
      /bsv-?21|fungible|token transfer/i.test(out.outputDescription)
    ) {
      return true
    }
  }

  const inputs = Array.isArray(body.inputs) ? body.inputs : []
  for (const raw of inputs) {
    if (!raw || typeof raw !== 'object') continue
    const desc = (raw as { inputDescription?: unknown }).inputDescription
    if (typeof desc === 'string' && /bsv-?21|fungible|token tip/i.test(desc)) {
      return true
    }
  }

  return false
}

/** Basket insertion of BSV-21 fungibles (receive / import). */
export function isBsv21ReceiveArgs(method: string, args: unknown): boolean {
  if (method !== 'internalizeAction') return false
  const body = asRecord(args)
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string')
    : []
  if (labels.some((l) => /^bsv21$/i.test(l) || /fungible/i.test(l))) {
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
      if (rem && isBsv21Basket(rem.basket)) return true
    }
  }
  return false
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
  if (p1SatSpendIds(args).length > 0) {
    return true
  }
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

/**
 * True when an item createAction issues a new collectable rather than moving
 * one this wallet already holds.
 *
 * Issuance spends only funding: the item output is a fresh inscription, so
 * there is no tip to name as an input. That is the whole distinction — an
 * approval that says "Send item" when nothing is leaving the wallet teaches
 * the user to ignore the word "send".
 */
export function isItemIssuanceArgs(method: string, args: unknown): boolean {
  if (method !== 'createAction') return false
  if (!isItemSpendArgs(method, args)) return false

  const body = asRecord(args)
  const inputs = Array.isArray(body.inputs) ? body.inputs : []
  if (inputs.length > 0) return false

  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  return outputs.some((raw) => {
    if (!raw || typeof raw !== 'object') return false
    const out = raw as Record<string, unknown>
    return out.satoshis === 1 && isItemBasket(out.basket)
  })
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
    apps: Array.isArray(o.apps)
      ? o.apps.filter((c): c is string => typeof c === 'string' && !!c.trim())
      : [],
    creators: Array.isArray(o.creators)
      ? o.creators.filter((c): c is string => typeof c === 'string' && !!c.trim())
      : [],
    ids: Array.isArray(o.ids)
      ? o.ids.filter((c): c is string => typeof c === 'string' && !!c.trim())
      : [],
    canReceive: !!o.canReceive,
  }
}

export function mergeItemViewGrant(
  current: ItemAccess,
  request: ItemViewRequest,
  opts?: { allowAll?: boolean },
): ItemAccess {
  const allowAll = opts?.allowAll !== false
  if (allowAll && (request.wantsAll || current.view === 'all')) {
    return { ...current, view: 'all' }
  }
  if (current.view === 'all' && allowAll) {
    return { ...current, view: 'all' }
  }
  const collections = [...new Set([...current.collections, ...request.collections])]
  const apps = [...new Set([...current.apps, ...request.apps])]
  const creators = [...new Set([...current.creators, ...request.creators])]
  const ids = [...new Set([...current.ids, ...request.ids])]
  return {
    ...current,
    view: 'filtered',
    collections,
    apps,
    creators,
    ids,
  }
}

/** Whether an existing grant already covers this listOutputs request. */
export function itemViewGranted(access: ItemAccess, request: ItemViewRequest): boolean {
  if (access.view === 'none') return false
  if (access.view === 'all') return true
  // Filtered grant is the ceiling: a later `p 1sat all` is allowed and then
  // filtered, instead of re-prompting forever.
  if (request.wantsAll) return access.view === 'filtered'
  if (request.scope === 'collection') {
    return request.collections.every((value) => access.collections.includes(value))
  }
  if (request.scope === 'app') {
    return request.apps.every((value) => access.apps.includes(value))
  }
  if (request.scope === 'creator') {
    return request.creators.every((value) => access.creators.includes(value))
  }
  if (request.scope === 'id') {
    return request.ids.every((value) => access.ids.includes(value))
  }
  return false
}

export function outputMatchesItemAccess(
  access: ItemAccess,
  tags: string[] | undefined,
  customInstructions?: string,
  request?: ItemViewRequest,
  lockingScript?: unknown,
): boolean {
  if (access.view === 'none') return false
  if (isLeftoverThirdPartyItem({ tags, customInstructions, lockingScript })) return false

  const tagList = tags ?? []
  let app: string | undefined
  let creator: string | undefined
  let collectionId: string | undefined
  let id: string | undefined
  for (const t of tagList) {
    if (t.startsWith('app:')) app = t.slice('app:'.length)
    if (t.startsWith('creator:')) creator = t.slice('creator:'.length)
    if (t.startsWith('collection:')) collectionId = t.slice('collection:'.length)
    if (t.startsWith('id:')) id = t.slice('id:'.length)
  }
  // Remittance holds BRC-150 BEEF and can reach ~400k characters, so only pay for
  // the parse when tags left a gap in what this grant is filtered on.
  const needsCustom = !app || !creator || !collectionId
  if (customInstructions && needsCustom) {
    try {
      const o = JSON.parse(customInstructions) as Record<string, unknown>
      if (typeof o.app === 'string') app = app ?? o.app
      if (typeof o.collectionId === 'string') collectionId = collectionId ?? o.collectionId
      if (typeof o.creator === 'string') creator = creator ?? o.creator
    } catch {
      // ignore
    }
  }

  if (!request || request.wantsAll) {
    if (access.view === 'all') return true
    if (access.view !== 'filtered') return false
    return (
      (!!collectionId && access.collections.includes(collectionId)) ||
      (!!app && access.apps.includes(app)) ||
      (!!creator && access.creators.includes(creator)) ||
      (!!id && access.ids.includes(id))
    )
  }
  if (request.scope === 'collection') {
    return !!collectionId && request.collections.includes(collectionId)
  }
  if (request.scope === 'app') return !!app && request.apps.includes(app)
  if (request.scope === 'creator') {
    return !!creator && request.creators.includes(creator)
  }
  if (request.scope === 'id') return !!id && request.ids.includes(id)
  return false
}

export function itemAccessOriginKey(origin: string | undefined): string {
  return normalizeAppHost(origin)
}

export function normalizeTokenAccess(raw: unknown): TokenAccess {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TOKEN_ACCESS }
  const o = raw as Partial<TokenAccess>
  const view =
    o.view === 'all' || o.view === 'filtered' || o.view === 'none' ? o.view : 'none'
  return {
    view,
    ids: Array.isArray(o.ids)
      ? o.ids.filter((c): c is string => typeof c === 'string' && !!c.trim())
      : [],
  }
}

export function mergeTokenViewGrant(
  current: TokenAccess,
  request: TokenViewRequest,
  opts?: { allowAll?: boolean },
): TokenAccess {
  const allowAll = opts?.allowAll !== false
  if (allowAll && (request.wantsAll || current.view === 'all')) {
    return { ...current, view: 'all' }
  }
  const ids = [...new Set([...current.ids, ...request.ids])]
  return {
    ...current,
    view: 'filtered',
    ids,
  }
}

export function tokenViewGranted(access: TokenAccess, request: TokenViewRequest): boolean {
  if (access.view === 'none') return false
  if (access.view === 'all') return true
  if (request.wantsAll) return access.view === 'filtered'
  if (request.scope === 'id') {
    return request.ids.length > 0 && request.ids.every((value) => access.ids.includes(value))
  }
  return false
}

function normalizeOutpointId(value: string): string | undefined {
  const raw = value.trim().toLowerCase().replace('.', '_')
  return /^[0-9a-f]{64}_\d+$/.test(raw) ? raw : undefined
}

function tokenIdFromOutput(
  tags: string[] | undefined,
  customInstructions?: string,
  lockingScript?: unknown,
  outpoint?: string,
): string | undefined {
  const tagList = tags ?? []
  for (const t of tagList) {
    if (t.toLowerCase().startsWith('bsv21:') && t.length > 6) {
      const id = normalizeOutpointId(t.slice(6))
      if (id) return id
    }
    if (t.toLowerCase().startsWith('id:') && t.length > 3) {
      const id = normalizeOutpointId(t.slice(3))
      if (id) return id
    }
  }
  if (customInstructions) {
    try {
      const o = JSON.parse(customInstructions) as Record<string, unknown>
      if (typeof o.id === 'string' && o.id.trim()) {
        const id = normalizeOutpointId(o.id)
        if (id) return id
      }
    } catch {
      // ignore
    }
  }
  const decoded = decodeBsv21Binary(lockingScript)
  if (decoded?.tokenId) return decoded.tokenId
  if (decoded?.role === 'deploy' && outpoint) return normalizeOutpointId(outpoint)
  return undefined
}

export function outputMatchesTokenAccess(
  access: TokenAccess,
  tags: string[] | undefined,
  customInstructions?: string,
  request?: TokenViewRequest,
  lockingScript?: unknown,
  outpoint?: string,
): boolean {
  if (access.view === 'none') return false
  const tokenId = tokenIdFromOutput(tags, customInstructions, lockingScript, outpoint)
  if (access.view === 'all') {
    if (!request || request.wantsAll) return true
    if (request.scope === 'id') return !!tokenId && request.ids.includes(tokenId)
    return true
  }
  if (!tokenId) return false
  // Filtered third-party grant means "tokens", not a frozen id snapshot.
  // New 162 tips (KING) must show without reconnecting.
  if (!request || request.wantsAll) return true
  if (request.scope === 'id') {
    return request.ids.includes(tokenId) && access.ids.includes(tokenId)
  }
  return access.ids.includes(tokenId)
}

const ONESAT_FT_MIME_HEX = '6170706c69636174696f6e2f317361742d66742b6a736f6e'

function lockingScriptHexOf(raw: unknown): string {
  if (typeof raw === 'string') return raw.toLowerCase()
  if (raw && typeof raw === 'object' && typeof (raw as { toHex?: () => string }).toHex === 'function') {
    return String((raw as { toHex: () => string }).toHex() || '').toLowerCase()
  }
  return ''
}

function looksLikeOnesatFtOutput(
  tags: string[],
  customInstructions?: string,
  lockingScript?: unknown,
): boolean {
  if (customInstructions) {
    try {
      const o = JSON.parse(customInstructions) as Record<string, unknown>
      const nested =
        o.colour && typeof o.colour === 'object' && !Array.isArray(o.colour)
          ? (o.colour as Record<string, unknown>)
          : o
      if (String(nested.p ?? o.p ?? '').toLowerCase() === '1sat-ft') return true
    } catch {
      // ignore
    }
  }
  const hex = lockingScriptHexOf(lockingScript)
  if (hex.includes(ONESAT_FT_MIME_HEX)) return true
  return tags.some((t) => t.toLowerCase() === '1sat-ft' || t.toLowerCase().startsWith('1sat-ft:'))
}

function itemDisplayFields(tags: string[], customInstructions?: string): {
  collection?: string
  app?: string
  name?: string
  content?: string
} {
  const collection = tagValueOf(tags, 'collection:')
  const app = tagValueOf(tags, 'app:')
  const name = tagValueOf(tags, 'name:')
  const content = tagValueOf(tags, 'content:')
  const out = { collection, app, name, content }
  if (customInstructions && (!collection || !app || !name || !content)) {
    try {
      const o = JSON.parse(customInstructions) as Record<string, unknown>
      if (!out.collection && typeof o.collectionId === 'string') out.collection = o.collectionId
      if (!out.app && typeof o.app === 'string') out.app = o.app
      if (!out.name && typeof o.name === 'string') out.name = o.name
      if (!out.content && typeof o.content === 'string') out.content = o.content
    } catch {
      // ignore
    }
  }
  return out
}

/**
 * Leftover 1sat-ft (FOX) and unnamed Collectable · hex / Uncollected dust.
 * Third-party inventory drops these even when an old grant set view=all.
 */
export function isOnesatFtLeftoverRow(raw: {
  tags?: unknown
  customInstructions?: unknown
  lockingScript?: unknown
}): boolean {
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : []
  const custom = typeof raw.customInstructions === 'string' ? raw.customInstructions : undefined
  return looksLikeOnesatFtOutput(tags, custom, raw.lockingScript)
}

export function isLeftoverThirdPartyItem(raw: {
  tags?: unknown
  customInstructions?: unknown
  lockingScript?: unknown
}): boolean {
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : []
  const custom = typeof raw.customInstructions === 'string' ? raw.customInstructions : undefined
  if (isOnesatFtLeftoverRow(raw)) return true
  const fields = itemDisplayFields(tags, custom)
  const id = tagValueOf(tags, 'id:')
  return !fields.collection && !fields.app && !fields.name && !fields.content && !id
}

function tagValueOf(tags: string[], prefix: string): string | undefined {
  const needle = prefix.toLowerCase()
  for (const tag of tags) {
    if (tag.toLowerCase().startsWith(needle)) {
      const v = tag.slice(prefix.length).trim()
      if (v) return v
    }
  }
  return undefined
}

/**
 * Named collections/apps a third-party filtered grant may include.
 * FOX leftover / 1sat-ft / unnamed ordinals never appear.
 */
export function grantableCollectionsFromOutputs(outputs: unknown[]): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>()
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as { tags?: unknown; customInstructions?: unknown; lockingScript?: unknown }
    const tags = Array.isArray(o.tags)
      ? o.tags.filter((t): t is string => typeof t === 'string')
      : []
    const custom = typeof o.customInstructions === 'string' ? o.customInstructions : undefined
    if (isLeftoverThirdPartyItem(o)) continue
    const collection = tagValueOf(tags, 'collection:')
    const app = tagValueOf(tags, 'app:')
    const name = tagValueOf(tags, 'name:')
    const content = tagValueOf(tags, 'content:')
    if (!collection && !app && !name && !content) continue
    if (collection) {
      if (!byId.has(collection)) byId.set(collection, name || collection)
      continue
    }
    if (app) {
      const key = `app:${app}`
      if (!byId.has(key)) byId.set(key, app)
    }
  }
  return [...byId.entries()].map(([id, name]) => ({
    id: id.startsWith('app:') ? id.slice(4) : id,
    name,
  })).filter((row) => row.id)
}

export function grantableCollectionIdsFromOutputs(outputs: unknown[]): {
  collections: string[]
  apps: string[]
} {
  const collections: string[] = []
  const apps: string[] = []
  const seenC = new Set<string>()
  const seenA = new Set<string>()
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as { tags?: unknown; customInstructions?: unknown; lockingScript?: unknown }
    const tags = Array.isArray(o.tags)
      ? o.tags.filter((t): t is string => typeof t === 'string')
      : []
    const custom = typeof o.customInstructions === 'string' ? o.customInstructions : undefined
    if (isLeftoverThirdPartyItem(o)) continue
    const collection = tagValueOf(tags, 'collection:')
    const app = tagValueOf(tags, 'app:')
    const name = tagValueOf(tags, 'name:')
    const content = tagValueOf(tags, 'content:')
    if (!collection && !app && !name && !content) continue
    if (collection) {
      if (!seenC.has(collection)) {
        seenC.add(collection)
        collections.push(collection)
      }
      continue
    }
    if (app && !seenA.has(app)) {
      seenA.add(app)
      apps.push(app)
    }
  }
  return { collections, apps }
}

/** Live 162 tips only. Leftover 1sat-ft FOX is not a token. */
export function grantableTokensFromOutputs(outputs: unknown[]): Array<{ id: string; ticker: string }> {
  const byId = new Map<string, string>()
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as { tags?: unknown; customInstructions?: unknown; lockingScript?: unknown }
    const tags = Array.isArray(o.tags)
      ? o.tags.filter((t): t is string => typeof t === 'string')
      : []
    const custom = typeof o.customInstructions === 'string' ? o.customInstructions : undefined
    if (looksLikeOnesatFtOutput(tags, custom, o.lockingScript)) continue
    let proto = ''
    let sym: string | undefined
    if (custom) {
      try {
        const parsed = JSON.parse(custom) as Record<string, unknown>
        proto = String(parsed.p ?? '').toLowerCase()
        if (typeof parsed.sym === 'string' && parsed.sym.trim()) sym = parsed.sym.trim()
      } catch {
        // ignore
      }
    }
    if (proto === '1sat-ft') continue
    const tagged = tags.includes('bsv21') || tags.some((t) => t.toLowerCase().startsWith('bsv21:'))
    const lockLooks = lockingScriptHexOf(o.lockingScript).includes('4253563231')
    if (proto !== 'bsv-20' && proto !== 'bsv21' && !tagged && !lockLooks) continue
    const outpoint = typeof (o as { outpoint?: unknown }).outpoint === 'string'
      ? (o as { outpoint: string }).outpoint
      : undefined
    const id = tokenIdFromOutput(tags, custom, o.lockingScript, outpoint)
    if (!id) continue
    const ticker = sym || tagValueOf(tags, 'sym:') || id.slice(0, 8)
    if (!byId.has(id)) byId.set(id, ticker)
  }
  return [...byId.entries()].map(([id, ticker]) => ({ id, ticker }))
}

export function emptyListOutputsResult(): { outputs: unknown[]; totalOutputs: number } {
  return { outputs: [], totalOutputs: 0 }
}

export function shouldRefuseColourList(
  origin: string | undefined,
  basket: unknown,
): boolean {
  return isThirdPartyOriginator(origin) && isColourBasket(basket)
}

