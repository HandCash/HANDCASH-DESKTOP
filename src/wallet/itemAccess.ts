/**
 * Item (collectable / NFT) permission helpers.
 *
 * Pay / auto-pay never cover spending or viewing basket items.
 * View can be all-inventory or limited to collections / creators.
 */

import { normalizeAppHost } from './appIdentity'

/** Baskets that hold collectables — not spendable under normal pay. */
export const ITEM_BASKETS = new Set(['1sat', 'twonk'])

export type ItemAccess = {
  /** Inventory visibility for this app. */
  view: 'none' | 'all' | 'filtered'
  /** Allowed collection ids when view === 'filtered'. */
  collections: string[]
  /** Allowed creator / app ids when view === 'filtered'. */
  creators: string[]
  /** May createAction / relinquish that spends an item. */
  canSend: boolean
  /** May internalize into an item basket. */
  canReceive: boolean
}

export const DEFAULT_ITEM_ACCESS: ItemAccess = {
  view: 'none',
  collections: [],
  creators: [],
  canSend: false,
  canReceive: false,
}

export type ItemViewRequest = {
  collections: string[]
  creators: string[]
  /** True when the app did not narrow by collection/creator. */
  wantsAll: boolean
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

export function isItemBasket(basket: unknown): boolean {
  return typeof basket === 'string' && ITEM_BASKETS.has(basket.trim().toLowerCase())
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
  return {
    collections,
    creators,
    wantsAll: collections.length === 0 && creators.length === 0,
  }
}

/** True when createAction / labels / outputs look like an ordinal or Twonk transfer. */
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
      /^(1sat|twonk)$/i.test(l) ||
      /collectable|ordinal|twonk|nft/i.test(l),
    )
  ) {
    return true
  }

  const inputs = Array.isArray(body.inputs) ? body.inputs : []
  for (const raw of inputs) {
    if (!raw || typeof raw !== 'object') continue
    const desc = (raw as { inputDescription?: unknown }).inputDescription
    if (typeof desc === 'string' && /1sat|ordinal|collectable|twonk|nft/i.test(desc)) {
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
    if (tags.some((t) => /^(ordinal|twonk)$/i.test(t) || /^(origin|protocol):/i.test(t))) {
      return true
    }
    if (
      out.satoshis === 1 &&
      typeof out.outputDescription === 'string' &&
      /collectable|ordinal|twonk|nft/i.test(out.outputDescription)
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
  if (labels.some((l) => /^(1sat|twonk)$/i.test(l) || /ordinal|collectable|twonk/i.test(l))) {
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
  return {
    ...current,
    view: 'filtered',
    collections,
    creators,
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
  return collectionsOk && creatorsOk
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
  for (const t of tagList) {
    if (t.startsWith('app:') || t.startsWith('creator:') || t.startsWith('author:')) {
      app = t.split(':').slice(1).join(':')
    }
    if (t.startsWith('collection:') || t.startsWith('collectionId:')) {
      collectionId = t.split(':').slice(1).join(':')
    }
  }
  if (customInstructions) {
    try {
      const o = JSON.parse(customInstructions) as Record<string, unknown>
      if (typeof o.app === 'string') app = app ?? o.app
      if (typeof o.collectionId === 'string') collectionId = collectionId ?? o.collectionId
      if (typeof o.creator === 'string') app = app ?? o.creator
    } catch {
      // ignore
    }
  }

  const collectionOk =
    access.collections.length === 0 ||
    (!!collectionId && access.collections.includes(collectionId))
  const creatorOk =
    access.creators.length === 0 || (!!app && access.creators.includes(app))

  // Filtered grant with only collections → match collections; only creators → match creators.
  if (access.collections.length > 0 && access.creators.length > 0) {
    return collectionOk && creatorOk
  }
  if (access.collections.length > 0) return collectionOk
  if (access.creators.length > 0) return creatorOk
  return false
}

export function itemAccessOriginKey(origin: string | undefined): string {
  return normalizeAppHost(origin)
}
