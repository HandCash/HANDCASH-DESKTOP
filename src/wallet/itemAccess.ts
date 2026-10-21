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
import {
  COMPACT_ITEM_BASKET,
  ITEM_STORAGE_BASKET,
  TOKEN_BASKET,
  isFilingTag,
  isTokenFilingBasket,
  isTokenPermissionScheme,
  tokenIdFromFilingTags,
} from './assetBaskets'
import { looksLikeRetiredFungibleTip } from './retiredFungible'
import { bntAssetId, isBntAssetId, looksLikeBnt, readBnt } from './bnt/script'

export { ITEM_STORAGE_BASKET }

/**
 * Open BRC-255 items. Filed apart from 1Sat, viewed under the same item grant
 * (`p bntnft …` takes `p 1sat` scopes), and written only by the wallet.
 */
export const BNTNFT_BASKET = COMPACT_ITEM_BASKET

/** Storage basket for compact token outputs. */
export const FUNGIBLE_STORAGE_BASKET = TOKEN_BASKET

/** BRC-99 permission scheme ID for 1Sat collectables. */
export const ITEM_SCHEME = '1sat'

/** Baskets that hold collectables / tokens — not spendable under normal pay.
 * Recursive inscription content (HTML/JS that references other inscriptions)
 * still lives on 1-sat tips in basket `1sat` — same remittance + BRC-39 path.
 * Compact token tips live in `bntft`. They are not Pay / balanceView.
 */
export const ITEM_BASKETS = new Set<string>([
  ITEM_STORAGE_BASKET,
  BNTNFT_BASKET,
  FUNGIBLE_STORAGE_BASKET,
])

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

/** Inventory visibility for tokens — never implied by item view. */
export type TokenAccess = {
  view: 'none' | 'all' | 'filtered'
  /** Allowed 40-hex asset ids when view === 'filtered'. */
  ids: string[]
  /** Allowed BRC-164 held-row keys when view === 'filtered'. */
  keys: string[]
}

export const DEFAULT_TOKEN_ACCESS: TokenAccess = {
  view: 'none',
  ids: [],
  keys: [],
}

/**
 * `token` filters by token id (`bntft:<tokenId>` tags). `id` is the BRC-165
 * held-row lookup (`id:<key>` tags), the same axis as `p 1sat id`.
 */
export type TokenViewScope = 'plain' | 'all' | 'token' | 'id'

export type TokenViewRequest = {
  scope: TokenViewScope
  /** 40-hex asset ids for scope `token`. */
  ids: string[]
  /** BRC-164 held-row keys for scope `id`. */
  keys: string[]
  /** True for plain `bntft` or `p bntft all`. */
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
  return !itemScheme(scheme) && !countersignedScheme(scheme) && !isTokenPermissionScheme(scheme)
}

/** Item permission schemes and their storage baskets: one grant covers both. */
function itemScheme(name: unknown): typeof ITEM_STORAGE_BASKET | typeof BNTNFT_BASKET | null {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : ''
  return n === ITEM_SCHEME ? ITEM_STORAGE_BASKET : n === BNTNFT_BASKET ? BNTNFT_BASKET : null
}

/** A 40-hex compact asset id (draft BRC-255), or null. */
function assetIdOf(value: string): string | null {
  const lower = value.trim().toLowerCase()
  return isBntAssetId(lower) ? lower : null
}

/** Filings only the wallet writes or forgets: a lost row takes its holder key's remittance with it. */
function namesWalletOnlyFiling(basket: unknown): boolean {
  const p = parsePBasket(basket)
  const name = (p ? p.scheme : typeof basket === 'string' ? basket : '').trim().toLowerCase()
  return name === BNTNFT_BASKET || name === TOKEN_BASKET || countersignedScheme(name) != null
}

/**
 * Apps never write BNT (BRC-255 §12): no BNT script in an output, nothing
 * filed into `bntft` or `bntnft`, no `p bntft|bntnft input id` spend, and no
 * relinquishing a wallet-only row. BNT moves through `transferBntAsset` alone.
 */
export function bntWriteRefusal(args: unknown): string | null {
  const body = asRecord(args)
  if (typeof body.output === 'string' && namesWalletOnlyFiling(body.basket)) {
    return 'Wallet-only assets are never relinquished by an app.'
  }
  const labels = Array.isArray(body.labels) ? body.labels : []
  if (labels.some((l) => typeof l === 'string' && /^p bntn?ft input id /i.test(l))) {
    return 'BNT assets move only through transferBntAsset.'
  }
  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  for (const raw of outputs) {
    const out = asRecord(raw)
    const rem = asRecord(out.insertionRemittance)
    const filesBntnft = (basket: unknown) =>
      itemScheme(parsePBasket(basket)?.scheme ?? basket) === BNTNFT_BASKET
    if (filesBntnft(out.basket) || filesBntnft(rem.basket)) {
      return 'Only the wallet files BNT items; apps cannot write basket "bntnft".'
    }
    const filesBntft = (basket: unknown) => isTokenFilingBasket(parsePBasket(basket)?.scheme ?? basket)
    if (filesBntft(out.basket) || filesBntft(rem.basket)) {
      return 'Only the wallet files BNT tokens; apps cannot write basket "bntft".'
    }
    if (typeof out.lockingScript === 'string' && looksLikeBnt(out.lockingScript)) {
      return 'BNT outputs are written only by the wallet (issueBntAsset / mintBntAsset / transferBntAsset).'
    }
  }
  return null
}

/**
 * Countersigned (issuer-accepted) profiles: `iptft` fungible tokens, `iptnft`
 * items. Each has its own filing basket and BRC-99 permission scheme, beside
 * `bntft` and `1sat`.
 */
export const IPTFT = 'iptft'
export const IPTNFT = 'iptnft'
export type CountersignedScheme = typeof IPTFT | typeof IPTNFT
export const COUNTERSIGNED_SCHEMES: readonly CountersignedScheme[] = [IPTFT, IPTNFT]

/** The profile for a deploy's kind. */
export function countersignedSchemeFor(kind: 'token' | 'item'): CountersignedScheme {
  return kind === 'item' ? IPTNFT : IPTFT
}

function countersignedScheme(name: unknown): CountersignedScheme | null {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : ''
  return (COUNTERSIGNED_SCHEMES as readonly string[]).includes(n) ? (n as CountersignedScheme) : null
}

export type CountersignedViewScope = 'all' | 'asset' | 'collection' | 'id'

export type CountersignedViewRequest = {
  scheme: CountersignedScheme
  scope: CountersignedViewScope
  /** Asset ids, collection ids or row keys named in tags, by scope. */
  values: string[]
}

const COUNTERSIGNED_SCOPES: Record<CountersignedScheme, CountersignedViewScope[]> = {
  [IPTFT]: ['all', 'asset', 'id'],
  [IPTNFT]: ['all', 'asset', 'collection', 'id'],
}

/** `p iptft …` / `p iptnft …` view basket (never the bare filing name). */
export function countersignedViewScheme(basket: unknown): CountersignedScheme | null {
  const p = parsePBasket(basket)
  return p ? countersignedScheme(p.scheme) : null
}

function namesCountersignedFiling(basket: unknown): boolean {
  return countersignedScheme(basket) != null || countersignedViewScheme(basket) != null
}

/**
 * Apps never write into a countersigned filing or spend from it with a label:
 * only the wallet files there, after it resolves an issuer-accepted transfer.
 */
export function countersignedWriteRefusal(args: unknown): string | null {
  const body = asRecord(args)
  const labels = Array.isArray(body.labels) ? body.labels : []
  if (labels.some((l) => typeof l === 'string' && /^p (iptft|iptnft) input id /i.test(l))) {
    return 'Issuer-accepted assets are moved only by the wallet.'
  }
  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  for (const raw of outputs) {
    const out = asRecord(raw)
    const rem = asRecord(out.insertionRemittance)
    if (namesCountersignedFiling(out.basket) || namesCountersignedFiling(rem.basket)) {
      return 'Only the wallet files issuer-accepted outputs; apps cannot write baskets "iptft" or "iptnft".'
    }
  }
  return null
}

/** Asset id of a countersigned row; a deploy row is the asset its own outpoint names. */
export function countersignedAssetOfRow(
  row: { outpoint?: unknown; tags?: unknown },
  scheme: CountersignedScheme,
): string | null {
  const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : []
  for (const value of tagValues(tags, [`${scheme}:`])) {
    const id = assetIdOf(value)
    if (id) return id
  }
  if (tags.includes(`${scheme}:deploy`) && typeof row.outpoint === 'string') {
    const at = normalizeOutpointId(row.outpoint)
    const vout = at ? Number(at.slice(65)) : -1
    return at && vout <= 255 ? bntAssetId(at.slice(0, 64), vout) : null
  }
  return null
}

export function outputMatchesCountersignedView(
  row: { outpoint?: unknown; tags?: unknown; customInstructions?: unknown },
  request: CountersignedViewRequest,
): boolean {
  const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : []
  switch (request.scope) {
    case 'all':
      return true
    case 'asset': {
      const id = countersignedAssetOfRow(row, request.scheme)
      return !!id && request.values.includes(id)
    }
    case 'id':
      return tagValues(tags, ['id:']).some((key) => request.values.includes(key.toLowerCase()))
    case 'collection': {
      try {
        const col = (JSON.parse(String(row.customInstructions ?? '{}')) as { col?: unknown }).col
        return typeof col === 'string' && request.values.includes(col.toLowerCase())
      } catch {
        return false
      }
    }
  }
}

/** Stamp each listed deploy row with the asset id it names by its own outpoint. */
export function withCountersignedAssetTags(result: unknown, request: CountersignedViewRequest): unknown {
  if (!result || typeof result !== 'object') return { outputs: [], totalOutputs: 0 }
  const body = result as { outputs?: unknown[] }
  const outputs = (Array.isArray(body.outputs) ? body.outputs : []).flatMap((raw) => {
    const row = asRecord(raw)
    if (!outputMatchesCountersignedView(row, request)) return []
    const id = countersignedAssetOfRow(row, request.scheme)
    const tags = Array.isArray(row.tags) ? (row.tags as string[]) : []
    const tag = `${request.scheme}:${id}`
    return [id && !tags.includes(tag) ? { ...row, tags: [...tags, tag] } : row]
  })
  return { ...body, outputs, totalOutputs: outputs.length }
}

function prepareCountersignedView(body: Record<string, unknown>, scheme: CountersignedScheme): {
  error?: { code: string; description: string }
  request?: CountersignedViewRequest
} {
  const p = parsePBasket(body.basket)
  const scope = (p?.rest ?? '').toLowerCase() as CountersignedViewScope
  const scopes = COUNTERSIGNED_SCOPES[scheme]
  if (!p || !scopes.includes(scope) || p.rest !== scope) {
    return {
      error: {
        code: 'INVALID_COUNTERSIGNED_SCOPE',
        description: `Use exactly "p ${scheme} ${scopes.join('|')}"; filter values belong in tags.`,
      },
    }
  }
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : []
  let values: string[] = []
  if (scope !== 'all') {
    const prefix = scope === 'asset' ? `${scheme}:` : scope === 'collection' ? 'collection:' : 'id:'
    const raw = tagValues(tags, [prefix])
    values =
      scope === 'asset'
        ? raw.flatMap((v) => assetIdOf(v) ?? [])
        : raw.map((v) => v.toLowerCase())
    if (values.length === 0) {
      return {
        error: {
          code: 'MISSING_COUNTERSIGNED_SCOPE_TAG',
          description: `Basket "p ${scheme} ${scope}" requires at least one "${prefix}<value>" tag.`,
        },
      }
    }
  }
  return { request: { scheme, scope, values: [...new Set(values)] } }
}

/**
 * Collectable view / spend basket: plain `1sat` or BRC-99 `p 1sat <scope>`.
 * `bntft` is not an item view; it has its own token gate.
 */
export function isItemBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const t = basket.trim()
  const lower = t.toLowerCase()
  if (lower === ITEM_STORAGE_BASKET || lower === BNTNFT_BASKET) return true
  const p = parsePBasket(t)
  return !!p && itemScheme(p.scheme) != null
}

/** Token view basket: `bntft` or `p bntft …`. */
export function isTokenViewBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const t = basket.trim()
  if (isTokenFilingBasket(t)) return true
  const p = parsePBasket(t)
  return !!p && isTokenPermissionScheme(p.scheme)
}

/** True when an app asked for bare storage inventory instead of a P-scope. */
export function isBareStorageInventoryBasket(basket: unknown): boolean {
  if (typeof basket !== 'string') return false
  const t = basket.trim().toLowerCase()
  return t === ITEM_STORAGE_BASKET || t === BNTNFT_BASKET || isTokenFilingBasket(t)
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
  if (p && itemScheme(p.scheme)) {
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
  if (p && isTokenPermissionScheme(p.scheme)) {
    const rest = p.rest.toLowerCase()
    const filed = tagValues(tags, [`${TOKEN_BASKET}:`]).flatMap((v) => assetIdOf(v) ?? [])
    const keys = tagValues(tags, ['id:']).map((v) => v.toLowerCase())
    if (rest === 'token') {
      return { scope: 'token', ids: [...new Set(filed)], keys: [], wantsAll: false }
    }
    if (rest === 'id') {
      return { scope: 'id', ids: [], keys: [...new Set(keys)], wantsAll: false }
    }
    return { scope: 'all', ids: [], keys: [], wantsAll: true }
  }
  return {
    scope: 'plain',
    ids: [],
    keys: [],
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
  countersignedViewRequest?: CountersignedViewRequest
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

  const countersignedWrite = countersignedWriteRefusal(body)
  if (countersignedWrite) {
    return { args, error: { code: 'COUNTERSIGNED_WALLET_ONLY', description: countersignedWrite } }
  }
  const bntWrite = bntWriteRefusal(body)
  if (bntWrite) {
    return { args, error: { code: 'BNT_WALLET_ONLY', description: bntWrite } }
  }
  const bareCountersigned = countersignedScheme(body.basket)
  if (bareCountersigned) {
    return {
      args,
      error: {
        code: 'USE_COUNTERSIGNED_SCOPE',
        description: `Use basket "p ${bareCountersigned} ${COUNTERSIGNED_SCOPES[bareCountersigned].join('|')}" (filter values in tags). Storage basket "${bareCountersigned}" is wallet-internal.`,
      },
    }
  }
  const viewScheme = countersignedViewScheme(body.basket)
  if (viewScheme) {
    const view = prepareCountersignedView(body, viewScheme)
    if (view.error) return { args, error: view.error }
    const { tags: _scopeTags, ...rest } = body
    return {
      args: { ...rest, basket: viewScheme, includeTags: true },
      countersignedViewRequest: view.request,
    }
  }

  if (typeof body.basket === 'string' && isItemBasket(body.basket)) {
    const p = parsePBasket(body.basket)
    if (!p || isBareStorageInventoryBasket(body.basket)) {
      return {
        args,
        error: {
          code: 'USE_P1SAT_SCOPE',
          description:
            'Use BRC-165 basket "p 1sat all|collection|app|creator|id" or "p bntnft …" with the same scopes (filter values in tags). Storage baskets "1sat" and "bntnft" are wallet-internal.',
        },
      }
    }
    const storage = itemScheme(p.scheme)!
    const scheme = storage === BNTNFT_BASKET ? BNTNFT_BASKET : ITEM_SCHEME
    const scope = p.rest.toLowerCase()
    const allowedScopes = new Set(['all', 'collection', 'app', 'creator', 'id'])
    if (!allowedScopes.has(scope) || p.rest !== scope) {
      return {
        args,
        error: {
          code: 'INVALID_P1SAT_SCOPE',
          description: `Use exactly "p ${scheme} all|collection|app|creator|id"; filter values belong in tags.`,
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
          description: `Basket "p ${scheme} ${scope}" requires at least one "${scope}:<value>" tag.`,
        },
      }
    }
    body.basket = storage
    body.includeTags = true
    changed = true
  } else if (typeof body.basket === 'string' && isTokenViewBasket(body.basket)) {
    const p = parsePBasket(body.basket)
    if (!p || isBareStorageInventoryBasket(body.basket)) {
      return {
        args,
        error: {
          code: 'USE_TOKEN_SCOPE',
          description:
            'Use BRC-99 basket "p bntft all|token|id" (filter values in tags). Storage basket "bntft" is wallet-internal.',
        },
      }
    }
    const scope = p.rest.toLowerCase()
    const allowedScopes = new Set(['all', 'token', 'id'])
    if (!allowedScopes.has(scope) || p.rest !== scope) {
      return {
        args,
        error: {
          code: 'INVALID_TOKEN_SCOPE',
          description: 'Use exactly "p bntft all|token|id"; filter values belong in tags.',
        },
      }
    }
    tokenViewRequest = parseTokenViewRequest(body)
    const named =
      tokenViewRequest.scope === 'id' ? tokenViewRequest.keys : tokenViewRequest.ids
    if (scope !== 'all' && named.length === 0) {
      return {
        args,
        error: {
          code: 'MISSING_TOKEN_SCOPE_TAG',
          description:
            scope === 'id'
              ? 'Basket "p bntft id" requires at least one "id:<key>" tag.'
              : 'Basket "p bntft token" requires at least one "bntft:<assetId>" tag.',
        },
      }
    }
    body.basket = FUNGIBLE_STORAGE_BASKET
    body.includeTags = true
    changed = true
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
      return `Unsupported permission basket "${value}". Only schemes "1sat", "bntnft", "bntft", "iptft" and "iptnft" are implemented.`
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
        return `Unsupported permission basket "${child}". Only schemes "1sat", "bntnft", "bntft", "iptft" and "iptnft" are implemented.`
      }
      const err = findUnsupportedPBasket(child, depth + 1)
      if (err) return err
    }
  }
  return null
}

/**
 * True when createAction / labels / outputs look like a token transfer.
 * Checked before {@link isItemSpendArgs} so permission copy says "Send token".
 */
export function isTokenSpendArgs(method: string, args: unknown): boolean {
  if (method === 'relinquishOutput') {
    return isTokenFilingBasket(asRecord(args).basket)
  }
  if (method !== 'createAction' && method !== 'signAction') return false

  const body = asRecord(args)
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string')
    : []
  if (
    labels.some(
      (l) =>
        isTokenFilingBasket(l) ||
        /handcash-send-token|fungible/i.test(l),
    )
  ) {
    return true
  }

  const outputs = Array.isArray(body.outputs) ? body.outputs : []
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const out = raw as Record<string, unknown>
    if (isTokenFilingBasket(out.basket)) return true
    const tags = Array.isArray(out.tags)
      ? out.tags.filter((t): t is string => typeof t === 'string')
      : []
    if (tags.some((t) => isFilingTag(t))) {
      return true
    }
    if (
      out.satoshis === 1 &&
      typeof out.outputDescription === 'string' &&
      /fungible|token transfer/i.test(out.outputDescription)
    ) {
      return true
    }
  }

  const inputs = Array.isArray(body.inputs) ? body.inputs : []
  for (const raw of inputs) {
    if (!raw || typeof raw !== 'object') continue
    const desc = (raw as { inputDescription?: unknown }).inputDescription
    if (typeof desc === 'string' && /fungible|token tip/i.test(desc)) {
      return true
    }
  }

  return false
}

/** Basket insertion of tokens (receive / import). */
export function isTokenReceiveArgs(method: string, args: unknown): boolean {
  if (method !== 'internalizeAction') return false
  const body = asRecord(args)
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string')
    : []
  if (labels.some((l) => isTokenFilingBasket(l) || /fungible/i.test(l))) {
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
      if (rem && isTokenFilingBasket(rem.basket)) return true
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
  // filtered, instead of re-prompting forever. One naming nothing came from
  // the bug that stored the unnarrowed request; ask again.
  if (request.wantsAll) {
    return (
      access.view === 'filtered' &&
      access.collections.length + access.apps.length + access.creators.length + access.ids.length > 0
    )
  }
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

/** Only hosts under handcash.io: a grant never crosses to a domain HandCash does not own. */
const HANDCASH_CATALOG_HOSTS = [
  'handcash.io',
  'www.handcash.io',
  'market.handcash.io',
  'preprod-market.handcash.io',
  'market-v2.handcash.io',
]

/** handcash.io market hosts share one view-grant row so Allow sticks across reloads. */
export function isHandCashCatalogOrigin(origin: string | undefined): boolean {
  const host = normalizeAppHost(origin)
  const bare = (host.split(':')[0] ?? host).toLowerCase().replace(/^www\./, '')
  return (HANDCASH_CATALOG_HOSTS as readonly string[]).includes(bare)
}

/** Lookup keys for a persisted item/token view grant. */
export function viewGrantOriginAliases(origin: string | undefined): string[] {
  const host = itemAccessOriginKey(origin)
  if (isHandCashCatalogOrigin(host)) return [...HANDCASH_CATALOG_HOSTS]
  return [host]
}

export function normalizeTokenAccess(raw: unknown): TokenAccess {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TOKEN_ACCESS }
  const o = raw as Partial<TokenAccess>
  const view =
    o.view === 'all' || o.view === 'filtered' || o.view === 'none' ? o.view : 'none'
  const strings = (list: unknown) =>
    Array.isArray(list)
      ? list.filter((c): c is string => typeof c === 'string' && !!c.trim())
      : []
  return {
    view,
    ids: strings(o.ids),
    keys: strings(o.keys),
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
  return {
    ...current,
    view: 'filtered',
    ids: [...new Set([...current.ids, ...request.ids])],
    keys: [...new Set([...current.keys, ...request.keys])],
  }
}

export function tokenViewGranted(access: TokenAccess, request: TokenViewRequest): boolean {
  if (access.view === 'none') return false
  if (access.view === 'all') return true
  // A filtered grant naming nothing came from a bug that stored "all" without
  // its ids; ask again rather than serve an empty view forever.
  if (request.wantsAll) return access.view === 'filtered' && (access.ids.length > 0 || access.keys.length > 0)
  if (request.scope === 'token') {
    return request.ids.length > 0 && request.ids.every((value) => access.ids.includes(value))
  }
  if (request.scope === 'id') {
    return request.keys.length > 0 && request.keys.every((value) => access.keys.includes(value))
  }
  return false
}

/** BRC-164 held-row key of a token output. */
function tokenRowKey(tags: string[] | undefined): string | undefined {
  for (const t of tags ?? []) {
    if (!t.toLowerCase().startsWith('id:') || t.length <= 3) continue
    const value = t.slice(3).trim()
    if (value) return value.toLowerCase()
  }
  return undefined
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
  const bnt = typeof lockingScript === 'string' ? readBnt(lockingScript) : null
  if (bnt?.form === 'held' || bnt?.form === 'authority') return bnt.assetId
  if (bnt?.form === 'deploy' && outpoint) {
    const at = normalizeOutpointId(outpoint)
    const vout = at ? Number(at.slice(65)) : -1
    if (at && vout <= 255) return bntAssetId(at.slice(0, 64), vout)
  }
  const filed = tokenIdFromFilingTags(tags)
  const filedId = filed ? assetIdOf(filed) : null
  if (filedId) return filedId
  if (customInstructions) {
    try {
      const o = JSON.parse(customInstructions) as Record<string, unknown>
      if (typeof o.asset === 'string') {
        const id = assetIdOf(o.asset)
        if (id) return id
      }
    } catch {
      // ignore
    }
  }
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
  const rowKey = tokenRowKey(tags)
  if (request?.scope === 'id') {
    if (!rowKey || !request.keys.includes(rowKey)) return false
    return access.view === 'all' || access.keys.includes(rowKey)
  }
  if (access.view === 'all') {
    if (!request || request.wantsAll) return true
    if (request.scope === 'token') return !!tokenId && request.ids.includes(tokenId)
    return true
  }
  // A filtered grant remains an allowlist even when the caller requests "all".
  // Widening it here silently exposed newly discovered token ids without
  // another permission decision.
  const allowed =
    (!!tokenId && access.ids.includes(tokenId)) || (!!rowKey && access.keys.includes(rowKey))
  if (!request || request.wantsAll) return allowed
  if (request.scope === 'token') {
    return !!tokenId && request.ids.includes(tokenId) && access.ids.includes(tokenId)
  }
  return allowed
}

function lockingScriptHexOf(raw: unknown): string {
  if (typeof raw === 'string') return raw.toLowerCase()
  if (raw && typeof raw === 'object' && typeof (raw as { toHex?: () => string }).toHex === 'function') {
    return String((raw as { toHex: () => string }).toHex() || '').toLowerCase()
  }
  return ''
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
 * Removed fungible outputs and unnamed dust never enter third-party inventory.
 */
export function isRetiredFungibleRow(raw: {
  tags?: unknown
  customInstructions?: unknown
  lockingScript?: unknown
}): boolean {
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : []
  const custom = typeof raw.customInstructions === 'string' ? raw.customInstructions : undefined
  return looksLikeRetiredFungibleTip({
    tags,
    customInstructions: custom,
    lockingScriptHex: lockingScriptHexOf(raw.lockingScript),
  })
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
  if (isRetiredFungibleRow(raw)) return true
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
 * Removed protocols and unnamed ordinals never appear.
 */
export function grantableCollectionsFromOutputs(outputs: unknown[]): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>()
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as { tags?: unknown; customInstructions?: unknown; lockingScript?: unknown }
    const tags = Array.isArray(o.tags)
      ? o.tags.filter((t): t is string => typeof t === 'string')
      : []
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

/** Live compact token tips only. */
export function grantableTokensFromOutputs(outputs: unknown[]): Array<{ id: string; ticker: string }> {
  const byId = new Map<string, string>()
  for (const raw of outputs) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as { tags?: unknown; customInstructions?: unknown; lockingScript?: unknown }
    const tags = Array.isArray(o.tags)
      ? o.tags.filter((t): t is string => typeof t === 'string')
      : []
    const custom = typeof o.customInstructions === 'string' ? o.customInstructions : undefined
    if (
      looksLikeRetiredFungibleTip({
        tags,
        customInstructions: custom,
        lockingScriptHex: lockingScriptHexOf(o.lockingScript),
      })
    ) {
      continue
    }
    let sym: string | undefined
    if (custom) {
      try {
        const parsed = JSON.parse(custom) as Record<string, unknown>
        if (typeof parsed.sym === 'string' && parsed.sym.trim()) sym = parsed.sym.trim()
      } catch {
        // ignore
      }
    }
    const tagged = tags.some((t) => isFilingTag(t))
    const lock = lockingScriptHexOf(o.lockingScript)
    if (!tagged && !(lock && looksLikeBnt(lock))) continue
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

