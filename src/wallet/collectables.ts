/**
 * Collectables = outputs in BRC-100 basket `1sat`.
 */
import { P2PKH } from '@bsv/sdk'
import { getActiveWallet, type ActiveWallet } from './session'
import {
  contentUrlForOrigin,
  resolveOneSatInscription,
  type CollectableTrait,
  type ResolvedInscription,
} from './oneSatImport'
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
  traits: CollectableTrait[]
  extras: CollectableTrait[]
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
  return {
    outpoint: normalizeOutpoint(o.outpoint),
    origin,
    name: name.trim() || shortOrigin(origin),
    app,
    imageUrl: contentUrlForOrigin(origin, chain),
    satoshis: o.satoshis,
    mimeType: resolved?.mimeType,
    type: resolved?.type,
    subType: resolved?.subType,
    collectionId: resolved?.collectionId,
    traits: resolved?.traits ?? [],
    extras: resolved?.extras ?? [],
  }
}

export async function listCollectables(
  active?: ActiveWallet | null,
): Promise<Collectable[]> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) return []

  let outputs: Array<{
    outpoint: string
    satoshis: number
    tags?: string[]
    customInstructions?: string
  }> = []

  try {
    const result = await wallet.wallet.listOutputs({
      basket: '1sat',
      limit: 1000,
      includeTags: true,
      includeCustomInstructions: true,
      seekPermission: false,
    })
    outputs = (result.outputs ?? []).map((o) => ({
      outpoint: o.outpoint,
      satoshis: o.satoshis ?? 1,
      tags: o.tags,
      customInstructions: o.customInstructions,
    }))
  } catch (err) {
    console.warn('[collectables] listOutputs failed', err)
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

/** Transfer a basket `1sat` output to a P2PKH address via BRC-100 createAction. */
export async function sendCollectable(args: {
  outpoint: string
  toAddress: string
  name?: string
}): Promise<{ txid: string }> {
  const wallet = getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  const outpoint = normalizeOutpoint(args.outpoint)
  const to = args.toAddress.trim()
  if (!to) throw new Error('Recipient required')

  const lockingScript = new P2PKH().lock(to).toHex()
  const label = (args.name ?? 'Collectable').trim().slice(0, 40) || 'Collectable'

  const result = await wallet.wallet.createAction({
    description: `Send ${label}`.slice(0, 50),
    labels: ['1sat', 'handcash-send-collectable'],
    inputs: [
      {
        outpoint,
        inputDescription: '1sat collectable',
      },
    ],
    outputs: [
      {
        lockingScript,
        satoshis: 1,
        outputDescription: 'Collectable transfer',
      },
    ],
    options: {
      trustSelf: 'known',
      randomizeOutputs: false,
      acceptDelayedBroadcast: true,
    },
  })

  const txid = (result as { txid?: string }).txid
  if (!txid) throw new Error('Send completed without txid')

  setCollectablesCache(cachedCollectables.filter((i) => i.outpoint !== outpoint))
  return { txid }
}
