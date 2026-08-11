/**
 * Import 1Sat ordinals into BRC-100 basket `1sat` via internalizeAction.
 *
 * HARD RULE: never pass satoshis === 1 through fundWalletFromP2PKHOutpoints.
 * Unrecognized 1-sat outs stay on the address until classified (cloud items or GorillaPool).
 *
 * A BRC-156 latched transfer names itself: the settle transaction carries latch
 * state on chain, so `resolveLatchedTip` identifies the item in one fetch with no
 * indexer involved. The GorillaPool/WhatsOnChain ancestry walk below it is the
 * bootstrap path for legacy unlatched tips, where nothing on chain says what the
 * sat carries and the only recourse is replaying history.
 */
import { Transaction } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { getActiveWallet } from './session'
import type { Chain } from './vault'
import type { LegacyUtxo } from './legacyScan'
import {
  buildInternalizeCustomInstructions,
  rebuildProvenanceV2FromBeef,
} from './oneSatProvenance'
import { rememberProvenVerdict } from './provenCache'
import { announceItemVerified } from './itemArrivalToast'
import {
  beginOneSatImport,
  markOneSatImported,
  markOneSatImportFailed,
  releaseOneSatImport,
} from './oneSatImportGuard'
import { yieldToUi } from './yieldToUi'
import {
  getResolvedInscription,
  rememberResolvedInscription,
  rememberUnresolved,
  shouldResolveInscription,
  PENDING_RETRY_MS,
  RESOLVE_RETRY_MS,
} from './inscriptionCache'
import {
  ONE_SAT_LATCH_BASKET,
  findLatchStateForTip,
  isLatchDustSats,
  latchOutputTags,
} from './oneSatLatch'
import {
  isBsv21Mime,
  normalizeTokenId,
  parseBsv21Json,
  tokenIdForPayload,
  type Bsv21ImportItem,
  type Bsv21Op,
} from './bsv21'
import { parseContentReference } from './derivativeContent'

export type MigrationItem = {
  /** Transfer outpoint on the Desktop destination tx: `txid.vout` */
  outpoint: string
  /** Inscription origin, e.g. `txid_vout` (HandCash / OrdFS form) */
  origin?: string
  txid?: string
  vout?: number
  /** Display hints from indexer (optional) */
  name?: string
  app?: string
}

export type OneSatImportResult = {
  imported: number
  failed: number
  errors: string[]
  outpoints: string[]
}

export type ClassifiedLegacyUtxos = {
  /** satoshis > 1 and not latch dust — safe to fund-sweep */
  funding: LegacyUtxo[]
  /** Confirmed ordinals — internalize to basket `1sat` */
  oneSats: MigrationItem[]
  /** Confirmed BSV-21 tips — internalize to basket `bsv21` (Collect fungibles) */
  bsv21: Bsv21ImportItem[]
  /** Soft-latch dust (exactly LATCH_DUST_SATS) — internalize to `1sat-latch` */
  latches: LegacyUtxo[]
  /** satoshis === 1, not yet confirmed — leave untouched (never sweep) */
  heldOneSats: LegacyUtxo[]
  /**
   * Subset of {@link heldOneSats} a co-created latch proves is an ordinal tip.
   * Known to be an item, still waiting on an origin — worth telling the user
   * about, because to them the transfer has simply gone missing.
   */
  pendingTips: LegacyUtxo[]
}

export type CollectableTrait = {
  name: string
  value: string
}

export type ResolvedInscription = {
  origin: string
  name?: string
  app?: string
  mimeType?: string
  type?: string
  subType?: string
  collectionId?: string
  /** Shared media outpoint for derivative / reference tips. */
  content?: string
  traits: CollectableTrait[]
  /** Other string map fields worth showing in details */
  extras: CollectableTrait[]
}


function gorillaBase(chain: Chain): string {
  return chain === 'main'
    ? 'https://ordinals.gorillapool.io'
    : 'https://testnet.ordinals.gorillapool.io'
}

function wocBase(chain: Chain): string {
  return chain === 'main'
    ? 'https://api.whatsonchain.com/v1/bsv/main'
    : 'https://api.whatsonchain.com/v1/bsv/test'
}

function bitailsBase(chain: Chain): string | null {
  if (chain === 'main') return 'https://api.bitails.io'
  if (chain === 'test') return 'https://test-api.bitails.io'
  return null
}

function parseOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const normalized = outpoint.includes('_')
    ? outpoint.replace(/_(\d+)$/, '.$1')
    : outpoint
  const dot = normalized.lastIndexOf('.')
  if (dot <= 0) return null
  const txid = normalized.slice(0, dot)
  const vout = Number(normalized.slice(dot + 1))
  if (!txid || !Number.isInteger(vout) || vout < 0) return null
  return { txid, vout }
}

function txidVoutUnderscore(txid: string, vout: number): string {
  return `${txid}_${vout}`
}

function toDotOutpoint(txid: string, vout: number): string {
  return `${txid}.${vout}`
}

/** Normalize cloud/item payload into outpoint + origin. */
export function normalizeMigrationItem(raw: unknown): MigrationItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  let txid = typeof o.txid === 'string' ? o.txid : undefined
  let vout = typeof o.vout === 'number' ? o.vout : undefined
  let outpoint = typeof o.outpoint === 'string' ? o.outpoint : undefined
  let origin = typeof o.origin === 'string' ? o.origin : undefined
  const name = typeof o.name === 'string' ? o.name : undefined
  const app = typeof o.app === 'string' ? o.app : undefined

  if (!outpoint && txid != null && vout != null) {
    outpoint = toDotOutpoint(txid, vout)
  }
  if ((!txid || vout == null) && outpoint) {
    const parsed = parseOutpoint(outpoint)
    if (parsed) {
      txid = parsed.txid
      vout = parsed.vout
      outpoint = toDotOutpoint(parsed.txid, parsed.vout)
    }
  }
  if (origin?.includes('.')) {
    origin = origin.replace(/\.(\d+)$/, '_$1')
  }
  if (!outpoint || txid == null || vout == null) return null
  return { outpoint, origin, txid, vout, name, app }
}

type GpMap = Record<string, unknown>

type GpBsv20 = {
  op?: string
  id?: string
  amt?: string | number
  sym?: string
  icon?: string
  dec?: string | number
}

type GpTxo = {
  origin?:
    | string
    | {
        outpoint?: string
        data?: {
          map?: GpMap
          insc?: { file?: { type?: string }; text?: string; json?: unknown }
          bsv20?: GpBsv20
        }
      }
  data?: {
    map?: GpMap
    insc?: { file?: { type?: string }; text?: string; json?: unknown }
    bsv20?: GpBsv20
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return undefined
}

function parseTraits(raw: unknown): CollectableTrait[] {
  const traits: CollectableTrait[] = []
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue
      const o = row as Record<string, unknown>
      const name = asString(o.name) ?? asString(o.trait_type) ?? asString(o.trait)
      const value = asString(o.value) ?? asString(o.val)
      if (name && value) traits.push({ name, value })
    }
    return traits
  }
  // Some inscriptions store traits as a flat map: { Background: "Blue", … }.
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const text = asString(value)
      if (key.trim() && text) traits.push({ name: key.trim(), value: text })
    }
  }
  return traits
}

function extractResolved(
  meta: GpTxo,
  requestedOutpoint?: string,
): ResolvedInscription | null {
  const originRaw =
    typeof meta.origin === 'string'
      ? meta.origin
      : typeof meta.origin?.outpoint === 'string'
        ? meta.origin.outpoint
        : null
  if (!originRaw) return null
  const origin = originRaw.includes('.')
    ? originRaw.replace(/\.(\d+)$/, '_$1')
    : originRaw

  const originData = typeof meta.origin === 'object' ? meta.origin?.data : undefined
  const map = (originData?.map ?? meta.data?.map ?? {}) as GpMap
  const insc = originData?.insc ?? meta.data?.insc
  const fileType = asString(insc?.file?.type)
  const inscText = asString(insc?.text)
  const inscJsonText =
    typeof insc?.json === 'string'
      ? insc.json
      : insc?.json != null
        ? JSON.stringify(insc.json)
        : undefined
  const content =
    parseContentReference(inscText ?? inscJsonText ?? '', fileType) ?? undefined

  // Unindexed 1-sats answer with themselves as origin and no inscription data.
  // Adopting that invents a lineage the item does not have (404 image forever).
  const hasIdentity = Boolean(
    originData?.map ?? originData?.insc ?? meta.data?.map ?? meta.data?.insc,
  )
  if (requestedOutpoint && !hasIdentity) {
    const key = (v: string) => v.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
    if (key(origin) === key(requestedOutpoint)) return null
  }

  const subTypeData =
    map.subTypeData && typeof map.subTypeData === 'object'
      ? (map.subTypeData as Record<string, unknown>)
      : null

  const traits = [
    ...parseTraits(subTypeData?.traits),
    ...parseTraits(map.traits),
    ...parseTraits(map.attributes),
  ]

  const collectionId =
    asString(subTypeData?.collectionId) ??
    asString(map.collectionId) ??
    asString(map.collection)

  const skipKeys = new Set([
    'name',
    'app',
    'type',
    'subType',
    'subTypeData',
    'traits',
    'attributes',
    'collectionId',
    'collection',
  ])
  const extras: CollectableTrait[] = []
  for (const [key, value] of Object.entries(map)) {
    if (skipKeys.has(key)) continue
    const text = asString(value)
    if (text) extras.push({ name: key, value: text })
  }

  return {
    origin,
    name: asString(map.name),
    app: asString(map.app),
    mimeType: fileType,
    type: asString(map.type),
    subType: asString(map.subType),
    collectionId,
    ...(content ? { content } : {}),
    traits,
    extras,
  }
}

async function fetchGpTxo(outpointUnderscore: string, chain: Chain): Promise<GpTxo | null> {
  try {
    const url = `${gorillaBase(chain)}/api/txos/${outpointUnderscore}?script=false`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      // Some indexers only expose /inscriptions for the same outpoint.
      const inscUrl = `${gorillaBase(chain)}/api/inscriptions/${outpointUnderscore}?script=false`
      const inscRes = await fetch(inscUrl, { signal: AbortSignal.timeout(5000) })
      if (!inscRes.ok) return null
      return (await inscRes.json()) as GpTxo
    }
    return (await res.json()) as GpTxo
  } catch {
    return null
  }
}

type TxVin = { txid?: string; vout?: number }
type TxGraph = { vin?: TxVin[] }

async function fetchBitailsTxGraph(txid: string, chain: Chain): Promise<TxGraph | null> {
  const base = bitailsBase(chain)
  if (!base) return null
  try {
    const res = await fetch(`${base}/tx/${txid}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const body = (await res.json()) as {
      inputs?: Array<{ source?: { txid?: string; index?: number } }>
    }
    const vin: TxVin[] = (body.inputs ?? [])
      .map((input) => ({
        txid: input.source?.txid,
        vout: input.source?.index,
      }))
      .filter((v) => typeof v.txid === 'string' && Number.isInteger(v.vout))
    return vin.length > 0 ? { vin } : null
  } catch {
    return null
  }
}

async function fetchWocTx(txid: string, chain: Chain): Promise<TxGraph | null> {
  try {
    const url = `${wocBase(chain)}/tx/${txid}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return (await res.json()) as TxGraph
  } catch {
    return null
  }
}

/** Ancestry walk for legacy unlatched tips — Bitails first, WhatsOnChain second. */
async function fetchTxGraph(txid: string, chain: Chain): Promise<TxGraph | null> {
  return (await fetchBitailsTxGraph(txid, chain)) ?? (await fetchWocTx(txid, chain))
}

/** Inputs probed per hop before the walk commits to descending. */
const VIN_PROBE_LIMIT = 4

/** Unknown one-satoshi outputs identified per classify pass. */
export const MAX_UNKNOWN_RESOLVES_PER_PASS = 6

/**
 * A mined transaction body never changes, so fetching one twice is pure latency.
 * Soft-latch resolve and provenance walks often ask for the same tip / latch /
 * origin bodies in one sync pass. Successes are held long enough to cover a
 * whole pass; misses are held briefly so a transient outage does not pin a wrong
 * answer.
 */
const RAW_TX_CACHE_TTL_MS = 10 * 60_000
const RAW_TX_MISS_TTL_MS = 10_000
const RAW_TX_CACHE_MAX = 400
const rawTxCache = new Map<string, { at: number; hex: string | null }>()
const rawTxInflight = new Map<string, Promise<string | null>>()

const rawTxKey = (txid: string): string => txid.trim().toLowerCase()

function readRawTxCache(txid: string): { hex: string | null } | null {
  const key = rawTxKey(txid)
  const hit = rawTxCache.get(key)
  if (!hit) return null
  const ttl = hit.hex ? RAW_TX_CACHE_TTL_MS : RAW_TX_MISS_TTL_MS
  if (Date.now() - hit.at >= ttl) {
    rawTxCache.delete(key)
    return null
  }
  return { hex: hit.hex }
}

function writeRawTxCache(txid: string, hex: string | null): void {
  if (rawTxCache.size >= RAW_TX_CACHE_MAX) {
    const oldest = rawTxCache.keys().next().value
    if (oldest != null) rawTxCache.delete(oldest)
  }
  rawTxCache.set(rawTxKey(txid), { at: Date.now(), hex })
}

/**
 * Cached body only — never touches the network.
 *
 * Lets the sync path ask "is this tip already known?" without paying a fetch for
 * every stray one-satoshi output it has never seen before.
 */
export function peekRawTxHex(txid: string): string | null {
  return readRawTxCache(txid)?.hex ?? null
}

export async function fetchRawTxHex(txid: string, chain: Chain): Promise<string | null> {
  const cached = readRawTxCache(txid)
  if (cached) return cached.hex
  const key = rawTxKey(txid)
  const inflight = rawTxInflight.get(key)
  if (inflight) return inflight
  const request = fetchRawTxHexUncached(txid, chain)
    .then((hex) => {
      writeRawTxCache(txid, hex)
      return hex
    })
    .finally(() => {
      rawTxInflight.delete(key)
    })
  rawTxInflight.set(key, request)
  return request
}

/**
 * A storage host that accepts the socket and never answers must not be able to
 * wedge a whole sync pass. Every caller below has a public fallback, so bounding
 * the provider costs nothing except the wait we skip.
 */
const PROVIDER_TIMEOUT_MS = 6_000
const BEEF_TIMEOUT_MS = 10_000

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider request timed out')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchRawTxHexUncached(txid: string, chain: Chain): Promise<string | null> {
  // Prefer the toolbox provider: it has raw-transaction failover installed and
  // verifies the body hashes to the txid.
  try {
    const services = getActiveWallet()?.services
    const raw = services
      ? await withTimeout(services.getRawTx(txid), PROVIDER_TIMEOUT_MS)
      : null
    const bytes = raw?.rawTx
    if (bytes && bytes.length > 0) {
      return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    // Fall through to public endpoints.
  }
  const bitails = bitailsBase(chain)
  if (bitails) {
    try {
      const res = await fetch(`${bitails}/download/tx/${txid}/hex`, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'text/plain' },
      })
      if (res.ok) {
        const hex = (await res.text()).trim()
        if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) return hex
      }
    } catch {
      /* try WoC */
    }
  }
  try {
    const res = await fetch(`${wocBase(chain)}/tx/${txid}/hex`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const hex = (await res.text()).trim()
    return /^[0-9a-f]+$/i.test(hex) ? hex : null
  } catch {
    return null
  }
}

/**
 * Resolve a latched tip's identity from the transaction that delivered it.
 *
 * This is the BRC-156 fast path and the whole point of latching: the settle
 * transaction carries its own latch state, so identity costs one fetch of chain
 * data the receiver needs anyway — no ancestry replay, no ordinal indexer, and
 * no dependence on anyone having indexed the transfer yet.
 */
export async function resolveLatchedTip(
  txid: string,
  vout: number,
  chain: Chain,
): Promise<ResolvedInscription | null> {
  const hex = await fetchRawTxHex(txid, chain)
  if (!hex) return null

  let outputs: Array<{ lockingScript?: string | null }>
  try {
    outputs = Transaction.fromHex(hex).outputs.map((o) => ({
      lockingScript: o.lockingScript?.toHex(),
    }))
  } catch {
    return null
  }

  const state = findLatchStateForTip(outputs, vout)
  if (!state) return null

  return {
    origin: state.origin,
    name: state.name,
    app: state.app,
    mimeType: state.mimeType,
    traits: [],
    extras: [],
  }
}

/**
 * Resolve metadata when the tip's origin is already known.
 *
 * Fresh tips often 404 on the indexer for hours after a transfer, while the
 * inscription origin has been indexed for months. Asking about the tip first is
 * how a verified card keeps a content image (built from the origin URL) but
 * shows a truncated outpoint and empty traits.
 */
export async function resolveInscriptionAtOrigin(
  origin: string,
  chain: Chain,
): Promise<ResolvedInscription | null> {
  const point = origin.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
  const [txid, voutStr] = point.split('_')
  const vout = Number(voutStr)
  if (!txid || !Number.isInteger(vout)) return null
  const resolved = await resolveOneSatInscription(txid, vout, chain, 0).catch(() => null)
  if (!resolved) return null
  return { ...resolved, origin: point }
}


/**
 * Pull a balance-bearing BSV-21 holding from a GorillaPool / 1sat txo payload.
 * Auth-only outputs return null (not Collect fungible balances).
 */
export function extractBsv21FromGp(
  meta: GpTxo,
  tipOutpoint: string,
): Omit<Bsv21ImportItem, 'txid' | 'vout'> | null {
  const tip = tipOutpoint.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
  const originData = typeof meta.origin === 'object' ? meta.origin?.data : undefined
  const insc = originData?.insc ?? meta.data?.insc
  const bsv20 = originData?.bsv20 ?? meta.data?.bsv20
  const mime = asString(insc?.file?.type)
  const fromJson = parseBsv21Json(insc?.json)
  const fromIndex = bsv20
    ? parseBsv21Json({
        p: 'bsv-20',
        op: bsv20.op,
        id: bsv20.id,
        amt: bsv20.amt,
        sym: bsv20.sym,
        icon: bsv20.icon,
        dec: bsv20.dec,
      })
    : null
  const payload = fromJson ?? fromIndex
  if (!payload) {
    // Indexer marked application/bsv-20 but JSON was incomplete — still divert
    // away from the NFT basket so we do not paint fungibles as collectables.
    if (isBsv21Mime(mime) && bsv20?.id && bsv20.amt != null) {
      const tokenId = normalizeTokenId(String(bsv20.id))
      const amt =
        typeof bsv20.amt === 'number' ? String(Math.trunc(bsv20.amt)) : String(bsv20.amt)
      if (tokenId && /^\d+$/.test(amt)) {
        return {
          outpoint: tipOutpoint.includes('_')
            ? tipOutpoint.replace(/_(\d+)$/, '.$1')
            : tipOutpoint,
          tokenId,
          amt,
          op: (asString(bsv20.op) as Bsv21Op) || 'transfer',
          ...(asString(bsv20.sym) ? { sym: asString(bsv20.sym) } : {}),
          ...(normalizeTokenId(String(bsv20.icon ?? ''))
            ? { icon: normalizeTokenId(String(bsv20.icon))! }
            : {}),
          dec: typeof bsv20.dec === 'number' ? bsv20.dec : Number(bsv20.dec) || 0,
        }
      }
    }
    return null
  }
  const tokenId = tokenIdForPayload(payload, tip)
  if (!tokenId || !payload.amt) return null
  return {
    outpoint: tipOutpoint.includes('_')
      ? tipOutpoint.replace(/_(\d+)$/, '.$1')
      : tipOutpoint,
    tokenId,
    amt: payload.amt,
    op: payload.op,
    ...(payload.sym ? { sym: payload.sym } : {}),
    ...(payload.icon ? { icon: payload.icon } : {}),
    dec: payload.dec ?? 0,
  }
}

/**
 * Resolve a BSV-21 fungible tip from the ordinal indexer.
 * Returns null for NFT inscriptions and auth-only outputs.
 */
export async function resolveBsv21Holding(
  txid: string,
  vout: number,
  chain: Chain,
): Promise<Bsv21ImportItem | null> {
  const tip = toDotOutpoint(txid, vout)
  const meta = await fetchGpTxo(txidVoutUnderscore(txid, vout), chain)
  if (!meta) return null
  const holding = extractBsv21FromGp(meta, tip)
  if (!holding) return null
  return { ...holding, txid, vout }
}

/**
 * Resolve inscription origin for a 1-sat outpoint.
 * Falls back to walking prior inputs when GorillaPool has not indexed the new location yet.
 * BSV-21 fungibles are intentionally excluded — use {@link resolveBsv21Holding}.
 */
export async function resolveOneSatInscription(
  txid: string,
  vout: number,
  chain: Chain,
  maxDepth = 6,
): Promise<ResolvedInscription | null> {
  const seen = new Set<string>()
  let curTxid = txid
  let curVout = vout

  for (let depth = 0; depth <= maxDepth; depth++) {
    const key = txidVoutUnderscore(curTxid, curVout)
    if (seen.has(key)) break
    seen.add(key)

    const meta = await fetchGpTxo(key, chain)
    if (meta) {
      // Do not paint fungible tips as NFT collectables.
      if (extractBsv21FromGp(meta, toDotOutpoint(curTxid, curVout))) return null
      const resolved = extractResolved(meta, key)
      if (resolved && !isBsv21Mime(resolved.mimeType)) return resolved
    }

    if (depth === maxDepth) break

    const tx = await fetchTxGraph(curTxid, chain)
    const vins = tx?.vin ?? []
    if (vins.length === 0) break

    // Prefer any prior outpoint GorillaPool already knows as an ordinal.
    // A transfer spends the ordinal ahead of its funding inputs, so probing
    // deep into the input list mostly buys lookups on change UTXOs — at a
    // request each, per hop, against a host that will start throttling us.
    let next: { txid: string; vout: number } | null = null
    for (const vin of vins.slice(0, VIN_PROBE_LIMIT)) {
      if (typeof vin.txid !== 'string' || !Number.isInteger(vin.vout)) continue
      const prevKey = txidVoutUnderscore(vin.txid, vin.vout!)
      if (seen.has(prevKey)) continue
      const prevMeta = await fetchGpTxo(prevKey, chain)
      if (prevMeta) {
        if (extractBsv21FromGp(prevMeta, toDotOutpoint(vin.txid, vin.vout!))) {
          // Parent is a fungible transfer — not an NFT origin walk.
          continue
        }
        const resolved = extractResolved(prevMeta, prevKey)
        if (resolved && !isBsv21Mime(resolved.mimeType)) return resolved
      }
      if (!next) next = { txid: vin.txid, vout: vin.vout! }
    }

    if (!next) break
    curTxid = next.txid
    curVout = next.vout
  }

  return null
}

/**
 * Resolve a held tip, asking the indexer about a known origin first.
 *
 * Fresh tips routinely 404 on GorillaPool for hours after a transfer while the
 * inscription origin has been indexed for months. Walking the tip first is how
 * a BRC-150 card paints as a truncated outpoint with empty traits even though
 * the origin's name and traits are one request away.
 */
export async function resolveInscriptionPreferringOrigin(
  tipOutpoint: string,
  chain: Chain,
  knownOrigin?: string | null,
  maxDepth = 6,
): Promise<ResolvedInscription | null> {
  const origin = (knownOrigin ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.(\d+)$/, '_$1')
  if (/^[0-9a-f]{64}_\d+$/.test(origin)) {
    const [originTxid, originVout] = origin.split('_')
    const byOrigin = await resolveOneSatInscription(
      originTxid!,
      Number(originVout),
      chain,
      0,
    ).catch(() => null)
    if (byOrigin && (byOrigin.name || byOrigin.mimeType || byOrigin.traits.length > 0)) {
      return { ...byOrigin, origin }
    }
  }

  const [txid, voutStr] = tipOutpoint
    .trim()
    .toLowerCase()
    .replace(/_(\d+)$/, '.$1')
    .split('.')
  const vout = Number(voutStr)
  if (!txid || !Number.isInteger(vout)) return null
  return resolveOneSatInscription(txid, vout, chain, maxDepth)
}

/** Probe whether this outpoint is (or carries) a known inscription. */
export async function isOneSatInscription(
  txid: string,
  vout: number,
  chain: Chain,
): Promise<boolean> {
  return (await resolveOneSatInscription(txid, vout, chain)) != null
}

async function rebuildBrc150Identity(
  txid: string,
  vout: number,
): Promise<ResolvedInscription | null> {
  const wallet = getActiveWallet()
  const services = wallet?.services
  if (!services?.getBeefForTxid || !wallet) return null
  try {
    const beef = await withTimeout(services.getBeefForTxid(txid), BEEF_TIMEOUT_MS)
    const held = `${txid}.${vout}`
    const proof = rebuildProvenanceV2FromBeef(beef, held)
    if (!proof) return null
    rememberProvenVerdict(held, {
      tier: 'brc150',
      origin: proof.origin,
      verifiedAt: Date.now(),
    })
    try {
      announceItemVerified(held, 'BRC-150 lineage proven')
    } catch {
      // Toast / DOM may be unavailable in Node unit tests.
    }
    // A proven origin without an indexer hit is exactly the "verified but no
    // traits" card. Ask about the origin now.
    const resolved = await resolveInscriptionAtOrigin(proof.origin, wallet.chain)
    if (resolved && (resolved.name || resolved.mimeType || resolved.traits.length > 0)) {
      return resolved
    }
    return {
      origin: proof.origin,
      traits: [],
      extras: [],
    }
  } catch (err) {
    console.warn('[brc-150] receive ancestry rebuild failed', `${txid}.${vout}`, err)
    return null
  }
}

/**
 * Split scanned UTXOs.
 * - funding: satoshis > 1 and not latch dust — safe to fund-sweep
 * - oneSats: cloud-known or GorillaPool-confirmed NFT inscriptions (exactly 1 sat)
 * - bsv21: confirmed BSV-21 fungible tips — basket `bsv21` under Collect
 * - latches: soft-latch dust (exactly LATCH_DUST_SATS) — never funds, never tips
 * - heldOneSats: every other 1-sat — MUST NOT be swept
 */
export async function classifyLegacyUtxos(
  utxos: LegacyUtxo[],
  chain: Chain,
  knownItems: MigrationItem[] = [],
  opts: {
    /**
     * Skip every indexer round trip used to name a tip. Funding and latch dust
     * are decided from the satoshi value alone, so a send can still tell what it
     * may spend without waiting on ordinal lookups it will never use.
     */
    fundingOnly?: boolean
  } = {},
): Promise<ClassifiedLegacyUtxos> {
  const outpointKey = (outpoint: string): string => outpoint.trim().toLowerCase()

  const knownByOutpoint = new Map<string, MigrationItem>()
  for (const item of knownItems) {
    const n = normalizeMigrationItem(item)
    if (n) knownByOutpoint.set(outpointKey(n.outpoint), n)
  }

  // A cloud-named item is only an ordinal if the live UTXO is worth 1 satoshi.
  // Trusting the payload alone diverts real funds into basket `1sat`, where they
  // are neither swept nor counted toward spendable balance.
  const candidates = utxos

  const scannedByOutpoint = new Map<string, LegacyUtxo>()
  for (const u of candidates) {
    scannedByOutpoint.set(outpointKey(u.outpoint), u)
  }

  const oneSats: MigrationItem[] = []
  const bsv21: Bsv21ImportItem[] = []
  const claimed = new Set<string>()

  for (const [key, item] of knownByOutpoint) {
    const scanned = scannedByOutpoint.get(key)
    if (scanned && scanned.satoshis !== 1) {
      console.warn(
        `[1sat] cloud item ${key} holds ${scanned.satoshis} sats — not treating as an ordinal`,
      )
      continue
    }
    oneSats.push(item)
    claimed.add(key)
  }

  const funding: LegacyUtxo[] = []
  const latches: LegacyUtxo[] = []
  const heldOneSats: LegacyUtxo[] = []
  const pendingTips: LegacyUtxo[] = []

  // Identifying one unknown dust output costs a backwards walk — a request per
  // input per hop — and the loop below is serial, so a wallet holding a pile of
  // stray dust could spend minutes in a single pass before the UI saw anything.
  // Unbudgeted outputs are simply held and picked up by a later pass; a tip a
  // latch already proved landed is never budgeted, because the user is watching
  // that one arrive.
  let resolveBudget = MAX_UNKNOWN_RESOLVES_PER_PASS

  // BRC-156 co-creates tip (OUTPUT:0) and latch (OUTPUT:1) in one transfer, and
  // the latch is plain P2PKH so a receiver sees it on a normal address scan. A
  // latch paying us is therefore discovery evidence for a same-transaction tip.
  const latchTxids = new Set<string>()
  for (const u of candidates) {
    if (isLatchDustSats(u.satoshis)) latchTxids.add(u.txid.trim().toLowerCase())
  }

  for (const u of candidates) {
    if (claimed.has(outpointKey(u.outpoint))) continue

    // Soft-latch dust: never a tip, never spendable funds.
    if (isLatchDustSats(u.satoshis)) {
      latches.push(u)
      claimed.add(outpointKey(u.outpoint))
      continue
    }

    // HARD RULE: never fund-sweep 1-sat outs.
    // GorillaPool only when we have no local claim (knownItems / cloud migrate).
    // A tip already internalized with remittance never reaches this path again;
    // unknown dust is walked once and then backed off via inscriptionCache.
    if (u.satoshis === 1) {
      // A send never spends a tip, so it does not need one identified. Hold it
      // and move on rather than paying for an indexer walk mid-payment.
      if (opts.fundingOnly) {
        heldOneSats.push(u)
        continue
      }
      const known = knownByOutpoint.get(outpointKey(u.outpoint))
      let resolved: { origin: string; name?: string; app?: string } | null = null
      if (known?.origin != null) {
        resolved = {
          origin: known.origin.includes('.')
            ? known.origin.replace(/\.(\d+)$/, '_$1')
            : known.origin,
          name: known.name,
          app: known.app,
        }
      } else if (known) {
        resolved = {
          origin: txidVoutUnderscore(u.txid, u.vout),
          name: known.name,
          app: known.app,
        }
      } else {
        const cacheKey = `${u.txid}.${u.vout}`
        resolved = getResolvedInscription(cacheKey)
        // The 10-minute miss backoff exists to stop us hammering the indexer
        // over stray dust. A latch-proven tip is not stray dust — it is an item
        // we know landed — so it gets the much shorter pending window instead.
        // It still needs *a* window: the poll drops to 8s while a tip is
        // pending, and one walk costs a request per input per hop, so retrying
        // every poll is how the wallet gets itself throttled by the indexer it
        // is waiting on.
        const latchProven = u.vout === 0 && latchTxids.has(u.txid.trim().toLowerCase())
        const retryMs = latchProven ? PENDING_RETRY_MS : RESOLVE_RETRY_MS
        if (
          !resolved &&
          shouldResolveInscription(cacheKey, Date.now(), retryMs) &&
          (latchProven || resolveBudget > 0)
        ) {
          if (!latchProven) resolveBudget--
          // Fungibles first — same indexer hit, divert before NFT identity.
          const ft = await resolveBsv21Holding(u.txid, u.vout, chain)
          if (ft) {
            bsv21.push(ft)
            claimed.add(outpointKey(u.outpoint))
            continue
          }

          if (latchProven) {
            // Quick ingest: one cheap indexer peek for a name/image, then import
            // with a provisional tip origin. Full BRC-150 lineage walks after the
            // card paints (proveHeldGenesis + corner spinner) — never block the
            // address poll on ancestry while the NFT is invisible.
            const fetched =
              (await resolveLatchedTip(u.txid, u.vout, chain)) ??
              (await resolveOneSatInscription(u.txid, u.vout, chain))
            if (fetched && !isBsv21Mime(fetched.mimeType)) {
              rememberResolvedInscription(cacheKey, fetched)
              resolved = fetched
            } else if (fetched && isBsv21Mime(fetched.mimeType)) {
              const again = await resolveBsv21Holding(u.txid, u.vout, chain)
              if (again) {
                bsv21.push(again)
                claimed.add(outpointKey(u.outpoint))
                continue
              }
              rememberUnresolved(cacheKey)
            } else {
              // Indexer miss — back off peeking, but still import below.
              rememberUnresolved(cacheKey)
            }
            // No name yet — still import. Tip-as-origin is enough to paint a
            // card; authenticity settles behind the loading circle.
            if (!resolved) {
              resolved = {
                origin: txidVoutUnderscore(u.txid, u.vout),
              }
            }
          } else {
            // Unverified dust: remittance rebuild + indexer. Misses back off.
            const brc150 = await rebuildBrc150Identity(u.txid, u.vout)
            const fetched =
              brc150 ?? (await resolveOneSatInscription(u.txid, u.vout, chain))
            if (fetched && !isBsv21Mime(fetched.mimeType)) {
              rememberResolvedInscription(cacheKey, fetched)
              resolved = fetched
            } else if (fetched && isBsv21Mime(fetched.mimeType)) {
              const again = await resolveBsv21Holding(u.txid, u.vout, chain)
              if (again) {
                bsv21.push(again)
                claimed.add(outpointKey(u.outpoint))
                continue
              }
              rememberUnresolved(cacheKey)
            } else {
              rememberUnresolved(cacheKey)
            }
          }
        } else if (!resolved && latchProven) {
          // Inside the pending backoff window — still import so the NFT shows.
          resolved = {
            origin: txidVoutUnderscore(u.txid, u.vout),
          }
        }
      }

      if (resolved || known) {
        oneSats.push({
          outpoint: u.outpoint,
          txid: u.txid,
          vout: u.vout,
          origin: resolved?.origin ?? known?.origin ?? txidVoutUnderscore(u.txid, u.vout),
          name: resolved?.name ?? known?.name,
          app: resolved?.app ?? known?.app,
        })
        claimed.add(outpointKey(u.outpoint))
      } else {
        heldOneSats.push(u)
      }
      continue
    }

    if (u.satoshis > 1) {
      funding.push(u)
    }
    // satoshis === 0 or weird values: ignore (do not sweep)
  }

  return { funding, oneSats, bsv21, latches, heldOneSats, pendingTips }
}

/** Internalize ordinal outs into basket `1sat`. */
export async function importOneSatOrdinals(
  items: MigrationItem[],
  active?: ActiveWallet | null,
): Promise<OneSatImportResult> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  const normalized = items
    .map(normalizeMigrationItem)
    .filter((x): x is MigrationItem => x != null)

  if (normalized.length === 0) {
    return { imported: 0, failed: 0, errors: [], outpoints: [] }
  }

  const claimed = beginOneSatImport(normalized.map((i) => i.outpoint))
  const claimedSet = new Set(claimed)
  const toImport = normalized.filter((i) => claimedSet.has(i.outpoint.trim().toLowerCase()))
  if (toImport.length === 0) {
    return { imported: 0, failed: 0, errors: [], outpoints: [] }
  }

  const byTxid = new Map<string, MigrationItem[]>()
  for (const item of toImport) {
    const txid = item.txid!
    const list = byTxid.get(txid) ?? []
    list.push(item)
    byTxid.set(txid, list)
  }

  let imported = 0
  let failed = 0
  const errors: string[] = []
  const outpoints: string[] = []

  for (const [txid, group] of byTxid) {
    const groupOps = group.map((g) => g.outpoint)
    try {
      if (!wallet.services?.getBeefForTxid) {
        throw new Error('Wallet services unavailable for BEEF fetch')
      }
      await yieldToUi()
      const beef = await wallet.services.getBeefForTxid(txid)
      await yieldToUi()
      const atomic = beef.toBinaryAtomic(txid)

      // Last line of defence: basket `1sat` is not counted as spendable balance,
      // so anything worth more than a satoshi must never be filed there.
      const sourceTx = beef.findAtomicTransaction(txid)
      const notOrdinal = group.filter((item) => {
        const sats = sourceTx?.outputs?.[item.vout!]?.satoshis
        return typeof sats === 'number' && sats !== 1
      })
      if (notOrdinal.length > 0) {
        for (const item of notOrdinal) {
          console.warn(
            `[1sat] refusing to internalize ${item.outpoint} — output is not 1 satoshi`,
          )
        }
        releaseOneSatImport(notOrdinal.map((i) => i.outpoint))
      }
      const ordinals = group.filter((item) => !notOrdinal.includes(item))
      if (ordinals.length === 0) continue

      const remittanceOutputs = []
      for (const item of ordinals) {
        const origin =
          item.origin ?? item.outpoint.replace(/\.(\d+)$/, '_$1')
        remittanceOutputs.push({
          outputIndex: item.vout!,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: '1sat',
            tags: [
              'ordinal',
              `origin:${origin.replace(/_(\d+)$/, '.$1')}`,
              ...(item.name ? [`name:${item.name.slice(0, 80)}`] : []),
              ...(item.app ? [`app:${item.app.slice(0, 40)}`] : []),
            ],
            customInstructions: buildInternalizeCustomInstructions({
              origin,
              name: item.name ?? 'Collectable',
              app: item.app,
            }),
          },
        })
      }

      await yieldToUi()
      await wallet.wallet.internalizeAction({
        tx: atomic,
        description: 'Import 1Sat ordinal',
        labels: ['1sat', 'migration'],
        outputs: remittanceOutputs,
        seekPermission: false,
      })
      await yieldToUi()

      imported += ordinals.length
      outpoints.push(...ordinals.map((i) => i.outpoint))
      markOneSatImported(ordinals.map((i) => i.outpoint))
      // Tags lose casing under the SDK validator; keep the display name where
      // the inventory list already reads it from.
      for (const item of ordinals) {
        if (!item.name) continue
        const op = item.outpoint.trim().toLowerCase()
        if (getResolvedInscription(op)) continue
        rememberResolvedInscription(op, {
          origin: item.origin ?? op.replace(/\.(\d+)$/, '_$1'),
          name: item.name,
          ...(item.app ? { app: item.app } : {}),
          traits: [],
          extras: [],
        })
      }
    } catch (err) {
      markOneSatImportFailed(groupOps)
      failed += group.length
      const msg = err instanceof Error ? err.message : String(err)
      for (const item of group) {
        errors.push(`${item.outpoint}: ${msg}`)
      }
      console.warn('[1sat] internalize failed', txid, err)
    }
  }

  return { imported, failed, errors, outpoints }
}

/**
 * Internalize soft-latch dust into basket `1sat-latch`.
 * Pairs each latch with a tip from the same tx when one is known.
 */
export async function importOneSatLatches(
  latches: LegacyUtxo[],
  tipOriginsByTxid: Map<string, string>,
  active?: ActiveWallet | null,
): Promise<OneSatImportResult> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')
  if (latches.length === 0) {
    return { imported: 0, failed: 0, errors: [], outpoints: [] }
  }

  const claimed = beginOneSatImport(latches.map((l) => l.outpoint))
  const claimedSet = new Set(claimed)
  const toImport = latches.filter((l) => claimedSet.has(l.outpoint.trim().toLowerCase()))
  if (toImport.length === 0) {
    return { imported: 0, failed: 0, errors: [], outpoints: [] }
  }

  const byTxid = new Map<string, LegacyUtxo[]>()
  for (const latch of toImport) {
    const list = byTxid.get(latch.txid) ?? []
    list.push(latch)
    byTxid.set(latch.txid, list)
  }

  let imported = 0
  let failed = 0
  const errors: string[] = []
  const outpoints: string[] = []

  for (const [txid, group] of byTxid) {
    const groupOps = group.map((g) => g.outpoint)
    try {
      if (!wallet.services?.getBeefForTxid) {
        throw new Error('Wallet services unavailable for BEEF fetch')
      }
      // BEEF serialize + AtomicBEEF validate inside internalizeAction are sync
      // CPU on the WebView thread — yield around them so nav taps stay live.
      await yieldToUi()
      const beef = await wallet.services.getBeefForTxid(txid)
      await yieldToUi()
      const atomic = beef.toBinaryAtomic(txid)
      const sourceTx = beef.findAtomicTransaction(txid)
      const tipOrigin =
        tipOriginsByTxid.get(txid.toLowerCase()) ??
        tipOriginsByTxid.get(txid) ??
        `${txid}_0`

      const remittanceOutputs = []
      for (const latch of group) {
        const sats = sourceTx?.outputs?.[latch.vout]?.satoshis
        // Soft-latch dust is exactly 2 sats.
        if (typeof sats === 'number' && !isLatchDustSats(sats)) {
          console.warn(
            `[1sat-latch] refusing to internalize ${latch.outpoint} — not latch dust (${sats})`,
          )
          releaseOneSatImport([latch.outpoint])
          continue
        }
        const tipRef = `OUTPUT:0`
        const originU = tipOrigin.includes('.')
          ? tipOrigin.replace(/\.(\d+)$/, '_$1')
          : tipOrigin.includes('_')
            ? tipOrigin
            : `${txid}_0`
        remittanceOutputs.push({
          outputIndex: latch.vout,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: ONE_SAT_LATCH_BASKET,
            tags: latchOutputTags({ origin: originU, tip: tipRef }),
            customInstructions: JSON.stringify({
              schema: 1,
              origin: originU.toLowerCase(),
              tip: tipRef,
            }),
          },
        })
      }
      if (remittanceOutputs.length === 0) continue

      await yieldToUi()
      await wallet.wallet.internalizeAction({
        tx: atomic,
        description: 'Import 1Sat latch',
        labels: ['1sat-latch', 'migration'],
        outputs: remittanceOutputs,
        seekPermission: false,
      })
      await yieldToUi()

      const importedOps = remittanceOutputs.map(
        (o) => `${txid}.${o.outputIndex}`,
      )
      imported += remittanceOutputs.length
      outpoints.push(...importedOps)
      markOneSatImported(importedOps)
    } catch (err) {
      markOneSatImportFailed(groupOps)
      failed += group.length
      const msg = err instanceof Error ? err.message : String(err)
      for (const latch of group) {
        errors.push(`${latch.outpoint}: ${msg}`)
      }
      console.warn('[1sat-latch] internalize failed', txid, err)
    }
  }

  return { imported, failed, errors, outpoints }
}

export function contentUrlForOrigin(origin: string, chain: Chain = 'main'): string {
  const underscored = origin.includes('.')
    ? origin.replace(/\.(\d+)$/, '_$1')
    : origin
  return `${gorillaBase(chain)}/content/${underscored}`
}
