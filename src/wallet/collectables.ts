/**
 * Collectables = outputs in BRC-100 item baskets (`1sat`, `twonk`).
 * Twonk send/receive is supported; marketplace features are out of scope for now.
 */
import { P2PKH } from '@bsv/sdk'
import { getActiveWallet, type ActiveWallet } from './session'
import {
  contentUrlForOrigin,
  resolveOneSatInscription,
  type CollectableTrait,
  type ResolvedInscription,
} from './oneSatImport'
import type { CollectableType } from './collectableType'
import { resolvePaymentAddress } from './friends'
import type { Chain } from './vault'

export type { CollectableTrait }

export type Collectable = {
  /** Wallet outpoint `txid.vout` */
  outpoint: string
  /** Inscription origin `txid_vout` */
  origin: string
  name: string
  app?: string
  imageUrl: string
  satoshis: number
  mimeType?: string
  type?: string
  subType?: string
  collectionId?: string
  /** Protocol family for the Collectables type selector. */
  protocol: CollectableType
  traits: CollectableTrait[]
  extras: CollectableTrait[]
}

const ITEM_LIST_BASKETS = ['1sat', 'twonk'] as const

function haystack(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ').toLowerCase()
}

/** Classify a held output as Twonk vs generic 1Sat. */
export function classifyCollectableProtocol(args: {
  basket?: string
  tags?: string[]
  app?: string
  type?: string
  subType?: string
  name?: string
  customInstructions?: string
}): CollectableType {
  if (args.basket?.toLowerCase() === 'twonk') return 'twonk'
  const tags = (args.tags ?? []).map((t) => t.toLowerCase())
  if (tags.some((t) => t === 'twonk' || t === 'protocol:twonk' || t.startsWith('twonk:'))) {
    return 'twonk'
  }
  let customApp: string | undefined
  let customProtocol: string | undefined
  if (args.customInstructions) {
    try {
      const o = JSON.parse(args.customInstructions) as Record<string, unknown>
      if (typeof o.app === 'string') customApp = o.app
      if (typeof o.protocol === 'string') customProtocol = o.protocol
      if (typeof o.type === 'string' && /twonk/i.test(o.type)) return 'twonk'
    } catch {
      // ignore
    }
  }
  if (customProtocol && /twonk/i.test(customProtocol)) return 'twonk'
  const text = haystack(
    args.app,
    customApp,
    args.type,
    args.subType,
    args.name,
    ...tags,
  )
  if (/\btwonk\b|\btwetch\b|\bsigil\b/.test(text)) return 'twonk'
  return '1sat'
}

type CollectablesListener = (items: Collectable[]) => void

let cachedCollectables: Collectable[] = []
/** True after at least one successful list (even if empty). */
let collectablesHydrated = false
const collectablesListeners = new Set<CollectablesListener>()

function notifyCollectables(items: Collectable[]) {
  for (const listener of collectablesListeners) listener(items)
}

function setCollectablesCache(items: Collectable[]) {
  cachedCollectables = items
  collectablesHydrated = true
  notifyCollectables(items)
}

export function clearCollectablesCache(): void {
  cachedCollectables = []
  collectablesHydrated = false
  notifyCollectables([])
}

export function getCachedCollectables(): Collectable[] {
  return cachedCollectables.slice()
}

export function areCollectablesHydrated(): boolean {
  return collectablesHydrated
}

export function subscribeCollectables(listener: CollectablesListener): () => void {
  collectablesListeners.add(listener)
  listener(getCachedCollectables())
  return () => {
    collectablesListeners.delete(listener)
  }
}

export function normalizeOutpoint(outpoint: string): string {
  return outpoint.includes('_') ? outpoint.replace(/_(\d+)$/, '.$1') : outpoint
}

export function shortOrigin(origin: string): string {
  const underscored = origin.includes('.') ? origin.replace(/\.(\d+)$/, '_$1') : origin
  const [txid, vout] = underscored.split('_')
  if (!txid) return origin
  return `${txid.slice(0, 8)}…_${vout ?? '?'}`
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  const hit = tags.find((t) => t.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

function parseOrigin(raw: string | undefined, fallbackOutpoint: string): string {
  const source = raw?.trim() || fallbackOutpoint
  return source.includes('.') ? source.replace(/\.(\d+)$/, '_$1') : source
}

function parseCustom(raw: string | undefined): { origin?: string; name?: string; app?: string } {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      origin: typeof o.origin === 'string' ? o.origin : undefined,
      name: typeof o.name === 'string' ? o.name : undefined,
      app: typeof o.app === 'string' ? o.app : undefined,
    }
  } catch {
    return {}
  }
}

function toCollectable(
  o: {
    outpoint: string
    satoshis: number
    tags?: string[]
    customInstructions?: string
    basket?: string
  },
  chain: Chain,
  resolved?: Partial<ResolvedInscription> | null,
): Collectable {
  const custom = parseCustom(o.customInstructions)
  const origin = parseOrigin(
    custom.origin ?? tagValue(o.tags, 'origin:') ?? resolved?.origin,
    o.outpoint,
  )
  const name =
    custom.name ?? tagValue(o.tags, 'name:') ?? resolved?.name ?? shortOrigin(origin)
  const app = custom.app ?? tagValue(o.tags, 'app:') ?? resolved?.app
  const type = resolved?.type
  const subType = resolved?.subType
  const collectionId = resolved?.collectionId
  return {
    outpoint: normalizeOutpoint(o.outpoint),
    origin,
    name: name.trim() || shortOrigin(origin),
    app,
    imageUrl: contentUrlForOrigin(origin, chain),
    satoshis: o.satoshis,
    mimeType: resolved?.mimeType,
    type,
    subType,
    collectionId,
    protocol: classifyCollectableProtocol({
      basket: o.basket,
      tags: o.tags,
      app,
      type,
      subType,
      name,
      customInstructions: o.customInstructions,
    }),
    traits: resolved?.traits ?? [],
    extras: resolved?.extras ?? [],
  }
}

export async function listCollectables(
  active?: ActiveWallet | null,
): Promise<Collectable[]> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) return []

  const outputs: Array<{
    outpoint: string
    satoshis: number
    tags?: string[]
    customInstructions?: string
    basket?: string
  }> = []
  const seen = new Set<string>()
  let listedOk = false

  for (const basket of ITEM_LIST_BASKETS) {
    try {
      const result = await wallet.wallet.listOutputs({
        basket,
        limit: 1000,
        includeTags: true,
        includeCustomInstructions: true,
        seekPermission: false,
      })
      listedOk = true
      for (const o of result.outputs ?? []) {
        const outpoint = normalizeOutpoint(o.outpoint)
        if (seen.has(outpoint)) continue
        seen.add(outpoint)
        outputs.push({
          outpoint,
          satoshis: o.satoshis ?? 1,
          tags: o.tags,
          customInstructions: o.customInstructions,
          basket,
        })
      }
    } catch (err) {
      // Twonk basket may not exist yet — only fail hard if 1sat also fails.
      if (basket === '1sat') {
        console.warn('[collectables] listOutputs failed', err)
      }
    }
  }

  if (!listedOk) {
    // Keep prior cache — do not hydrate as empty on transient failures.
    return getCachedCollectables()
  }

  const chain: Chain = wallet.chain
  const items: Collectable[] = []

  for (const o of outputs) {
    let resolved: ResolvedInscription | null = null
    const custom = parseCustom(o.customInstructions)
    const hasName = !!(custom.name ?? tagValue(o.tags, 'name:'))
    try {
      const [txid, voutStr] = normalizeOutpoint(o.outpoint).split('.')
      const vout = Number(voutStr)
      // Always try resolve for traits when listing is small; skip deep walk if named.
      if (txid && Number.isInteger(vout)) {
        resolved = await resolveOneSatInscription(txid, vout, chain, hasName ? 2 : 6)
      }
    } catch {
      // keep fallbacks
    }
    items.push(toCollectable(o, chain, resolved))
  }

  setCollectablesCache(items)
  return items
}

export async function getCollectable(
  outpoint: string,
  active?: ActiveWallet | null,
): Promise<Collectable | null> {
  const target = normalizeOutpoint(outpoint)
  const wallet = active ?? getActiveWallet()
  const cached = cachedCollectables.find((i) => i.outpoint === target)
  let item = cached ?? (await listCollectables(active)).find((i) => i.outpoint === target) ?? null
  if (!item || !wallet) return item

  // Details view: refresh indexer metadata (traits, etc.) even if list cache is thin.
  try {
    const [txid, voutStr] = item.outpoint.split('.')
    const vout = Number(voutStr)
    if (txid && Number.isInteger(vout)) {
      const resolved = await resolveOneSatInscription(txid, vout, wallet.chain, 6)
      if (resolved) {
        item = {
          ...item,
          origin: resolved.origin || item.origin,
          name: resolved.name?.trim() || item.name,
          app: resolved.app ?? item.app,
          mimeType: resolved.mimeType ?? item.mimeType,
          type: resolved.type ?? item.type,
          subType: resolved.subType ?? item.subType,
          collectionId: resolved.collectionId ?? item.collectionId,
          traits: resolved.traits.length ? resolved.traits : item.traits,
          extras: resolved.extras.length ? resolved.extras : item.extras,
          imageUrl: contentUrlForOrigin(resolved.origin || item.origin, wallet.chain),
        }
        setCollectablesCache(
          cachedCollectables.map((c) => (c.outpoint === target ? item! : c)),
        )
      }
    }
  } catch (err) {
    console.warn('[collectables] detail enrich failed', err)
  }

  return item
}

function formatSendError(err: unknown): Error {
  if (err instanceof Error) {
    const name = err.name || ''
    const msg = err.message || String(err)
    if (name.includes('INSUFFICIENT_FUNDS') || /insufficient.?funds/i.test(msg)) {
      return new Error('Not enough BSV to cover the network fee for this transfer')
    }
    if (/invalid.*address|lockingScript|P2PKH/i.test(msg)) {
      return new Error('Invalid recipient address or identity key')
    }
    return err
  }
  return new Error(String(err))
}

/**
 * Transfer a basket item (1Sat or Twonk) to a P2PKH address via createAction.
 *
 * Ordinal sat stays on output 0 (`randomizeOutputs: false`). Fees are funded
 * from the default change basket. Origin/name/app/protocol tags match import
 * metadata so recipients can resolve the inscription.
 */
export async function sendCollectable(args: {
  outpoint: string
  toAddress: string
  name?: string
  origin?: string
  app?: string
}): Promise<{ txid: string }> {
  const wallet = getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  const outpoint = normalizeOutpoint(args.outpoint)
  const to = resolvePaymentAddress(args.toAddress, wallet.chain)

  let lockingScript: string
  try {
    lockingScript = new P2PKH().lock(to).toHex()
  } catch {
    throw new Error('Invalid recipient address or identity key')
  }

  let match:
    | {
        outpoint: string
        satoshis?: number
        tags?: string[]
        customInstructions?: string
        basket: string
      }
    | undefined
  for (const basket of ITEM_LIST_BASKETS) {
    try {
      const held = await wallet.wallet.listOutputs({
        basket,
        limit: 1000,
        includeTags: true,
        includeCustomInstructions: true,
        seekPermission: false,
      })
      const hit = (held.outputs ?? []).find(
        (o) => normalizeOutpoint(o.outpoint) === outpoint,
      )
      if (hit) {
        match = { ...hit, basket }
        break
      }
    } catch {
      // try next basket
    }
  }
  if (!match) throw new Error('Collectable is no longer in this wallet')
  if ((match.satoshis ?? 1) !== 1) {
    throw new Error('Collectable UTXO is not a 1-sat ordinal')
  }

  const item = (await getCollectable(outpoint, wallet)) ?? null
  const origin = parseOrigin(args.origin ?? item?.origin, outpoint)
  const name =
    (args.name ?? item?.name ?? 'Collectable').trim().slice(0, 40) || 'Collectable'
  const app = args.app ?? item?.app
  const protocol =
    item?.protocol ??
    classifyCollectableProtocol({
      basket: match.basket,
      tags: match.tags,
      app,
      name,
      customInstructions: match.customInstructions,
    })
  const originTag = origin.replace(/_(\d+)$/, '.$1')
  const tags = [
    'ordinal',
    ...(protocol === 'twonk' ? ['twonk', 'protocol:twonk'] : []),
    `origin:${originTag}`,
    `name:${name.slice(0, 80)}`,
    ...(app ? [`app:${app.slice(0, 40)}`] : []),
  ]
  const outputBasket = protocol === 'twonk' ? 'twonk' : '1sat'

  const [txidIn] = outpoint.split('.')
  let inputBEEF: number[] | undefined
  try {
    if (txidIn && wallet.services?.getBeefForTxid) {
      const beef = await wallet.services.getBeefForTxid(txidIn)
      if (beef && typeof beef.toBinary === 'function') {
        inputBEEF = beef.toBinary()
      }
    }
  } catch (err) {
    console.warn('[collectables] inputBEEF fetch skipped', err)
  }

  let result: { txid?: string; signableTransaction?: unknown }
  try {
    result = await wallet.wallet.createAction({
      description: `Send ${name}`.slice(0, 50),
      labels: [protocol, 'handcash-send-collectable'],
      ...(inputBEEF ? { inputBEEF } : {}),
      inputs: [
        {
          outpoint,
          inputDescription:
            protocol === 'twonk' ? 'Twonk collectable' : '1sat collectable',
        },
      ],
      outputs: [
        {
          lockingScript,
          satoshis: 1,
          outputDescription:
            protocol === 'twonk' ? 'Twonk transfer' : 'Collectable transfer',
          basket: outputBasket,
          tags,
          customInstructions: JSON.stringify({
            origin,
            name,
            app,
            protocol,
          }),
        },
      ],
      options: {
        trustSelf: 'known',
        ...(txidIn ? { knownTxids: [txidIn] } : {}),
        randomizeOutputs: false,
        // Surface broadcast errors immediately for ordinal transfers.
        acceptDelayedBroadcast: false,
        signAndProcess: true,
      },
    })
  } catch (err) {
    throw formatSendError(err)
  }

  const txid = result.txid
  if (!txid) {
    if (result.signableTransaction) {
      throw new Error('Collectable send needs additional signatures')
    }
    throw new Error('Send completed without txid')
  }

  setCollectablesCache(cachedCollectables.filter((i) => i.outpoint !== outpoint))
  void listCollectables(wallet).catch((err) => {
    console.warn('[collectables] post-send refresh failed', err)
  })
  return { txid }
}
