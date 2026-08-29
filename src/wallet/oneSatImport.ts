/**
 * Import 1Sat ordinals into BRC-100 basket `1sat` via internalizeAction.
 *
 * HARD RULE: never pass satoshis === 1 through fundWalletFromP2PKHOutpoints.
 * Unrecognized 1-sat outs stay on the address until classified (cloud items or GorillaPool).
 *
 * Nothing on chain says what a 1-sat carries, so *discovery* comes from the
 * transfer-shape probe (a couple of cached rawtx fetches — see
 * {@link probeOrdinalTransfer}), which paints a provisional card instantly.
 * *Identity* then settles after paint: BRC-150 remittance rebuild, or the
 * GorillaPool/WhatsOnChain ancestry walk for a legacy tip.
 */
import { Beef, Transaction } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { durableGetItem, durableSetItem } from './durableStorage'
import { getActiveWallet } from './session'
import type { Chain } from './vault'
import type { LegacyUtxo } from './legacyScan'
import { chooseLegacySweepPath } from './legacySweepPath'
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
import { mapPool } from './asyncPool'
import { stampBrc164Id } from './itemAccess'
import {
  getResolvedInscription,
  rememberResolvedInscription,
  rememberUnresolved,
  shouldResolveInscription,
  RESOLVE_RETRY_MS,
} from './inscriptionCache'
import { getAtomicBeefBinaryForTxid } from './beefCache'
import {
  isBsv21Mime,
  normalizeTokenId,
  parseBsv21Json,
  tokenIdForPayload,
  type Bsv21ImportItem,
  type Bsv21Op,
  type Bsv21Payload,
} from './bsv21'
import {
  ONESAT_FT_BASKET,
  buildColourCustomInstructions,
  colourTags,
  isOnesatFtMime,
  isOnesatFtAmtHop,
  looksLikeOnesatFtTip,
  normalizeColourOrigin,
  originFromOnesatFtLock,
  parseColourTipAmt,
} from './colourCoins'
import { parseContentReference } from './derivativeContent'
import { hasOrdEnvelope, parseOrdEnvelope } from './ordinalOwnership'
import {
  applyCollectableRemittance,
  collectableKeySet,
} from './oneSatCollectableGuard'

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
  /** Collection binding (BRC-99 `p 1sat collection:<id>` scope). */
  collectionId?: string
}

export type OneSatImportResult = {
  imported: number
  failed: number
  errors: string[]
  outpoints: string[]
}

export type ClassifiedLegacyUtxos = {
  /**
   * Sweepable cash only — {@link chooseLegacySweepPath} returned `sweep`.
   * Never includes 1-sat tips, BSV-21, or sub-fee companion dust.
   */
  funding: LegacyUtxo[]
  /** Confirmed ordinals — internalize to basket `1sat` */
  oneSats: MigrationItem[]
  /** Confirmed BSV-21 tips — internalize to basket `bsv21` (Collect fungibles) */
  bsv21: Bsv21ImportItem[]
  /** Confirmed 1sat-ft genesis / tips — internalize to basket `1sat-ft` */
  onesatFt: MigrationItem[]
  /** satoshis === 1, not yet confirmed — leave untouched (never sweep) */
  heldOneSats: LegacyUtxo[]
  /**
   * satoshis > 1 but below the sweep floor — companion / latch-style dust.
   * Stays on the address; never enters `importLegacyUtxos`.
   */
  heldUneconomical: LegacyUtxo[]
  /**
   * Subset of {@link heldOneSats} known to be an ordinal tip still waiting on an
   * origin — worth telling the user about, because to them the transfer has
   * simply gone missing.
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
/** Concurrent tip internalizations — BEEF + AtomicBEEF are heavy. */
export const IMPORT_TX_CONCURRENCY = 3

/**
 * A mined transaction body never changes, so fetching one twice is pure latency.
 * Item resolve and provenance walks often ask for the same tip / origin bodies
 * in one sync pass. Successes are held for a whole session window; confirmed
 * misses (404 from every provider) are held long enough that Refresh /
 * change-script sweeps do not re-hammer Bitails / JungleBus / WhatsOnChain.
 */
const RAW_TX_CACHE_TTL_MS = 10 * 60_000
/** Ghost / never-mined txids — stop the Refresh 404 storm across passes. */
const RAW_TX_MISS_TTL_MS = 30 * 60_000
const RAW_TX_CACHE_MAX = 400
const rawTxCache = new Map<string, { at: number; hex: string | null }>()
const rawTxInflight = new Map<string, Promise<string | null>>()
const RAW_TX_MISS_KEY = 'handcash.rawTx.miss.v1'

/** Never-mined change txids that 404 every Refresh. Persist so reload is quiet. */
const SEEDED_RAW_TX_MISSES = [
  'da39ccda3dc7d222f6e98a44e82e58b123f9b28c542b318b0174f77812b04835',
  'b821e49428dbff75cf8418bce650b39341256a02bbfc7ced61867aca05f7fe75',
  '4888882a2c0bc0544f4990d63d43e989bb9297a918b6d3c032444b2dd1547b4f',
  'f84089fc662d062e22308409db26b9870631c5750c47eb0e04d654f29a58ac99',
  '41103eee8cabb3e2ac5dcc0e4be6e49b4cad1194da251f8ce31f85c0d88edfc7',
  '4b214a92f84eaf8f61d92f67adc6433ca8c72c8418de4dfe2bf4a627aa7fe662',
  'e1f5405bac2c934d59b1340d6662b433e28289bba2c93872c0d300e4849a8cf7',
  '63bfaeb4d259c068de9f26540bbb71d06a96bec004bb40f57361144f1b8a5515',
  '1d26c30c57a9880ccf5fac91dce3a5a71035600c44fb24bb726488d72928db25',
  'af3aca5d92e76863da96be75c942fb5d5c085e9345931a4388ede5967784d8c0',
  '747c5c424b6ec43db7424e84303a33e3e9c0bbafc156aeec915cb72cd38a24dc',
  '2f35748471ab9fd0981d3ee67a66cd058c88f5acdc712b41413c12f466448e94',
]

const rawTxKey = (txid: string): string => txid.trim().toLowerCase()

function loadDurableRawTxMisses(): Set<string> {
  const out = new Set(SEEDED_RAW_TX_MISSES)
  try {
    const raw = durableGetItem(RAW_TX_MISS_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as { txids?: unknown }
    if (!Array.isArray(parsed?.txids)) return out
    for (const id of parsed.txids) {
      if (typeof id === 'string' && /^[0-9a-f]{64}$/i.test(id)) {
        out.add(id.trim().toLowerCase())
      }
    }
  } catch {
    /* seed only */
  }
  return out
}

const durableRawTxMisses = loadDurableRawTxMisses()

function persistDurableRawTxMiss(txid: string): void {
  const key = rawTxKey(txid)
  if (!/^[0-9a-f]{64}$/.test(key) || durableRawTxMisses.has(key)) {
    durableRawTxMisses.add(key)
    return
  }
  durableRawTxMisses.add(key)
  try {
    durableSetItem(
      RAW_TX_MISS_KEY,
      JSON.stringify({ at: Date.now(), txids: [...durableRawTxMisses] }),
    )
  } catch {
    /* memory miss still holds this session */
  }
}

function readRawTxCache(txid: string): { hex: string | null } | null {
  const key = rawTxKey(txid)
  if (durableRawTxMisses.has(key)) return { hex: null }
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
  if (hex == null) persistDurableRawTxMiss(txid)
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

/**
 * Distinguish a remembered miss from "never asked".
 *
 * `peekRawTxHex` returns null for both; change-script sweeps need the miss so
 * already-quarantined rows skip another chain round-trip.
 */
export function peekRawTxLookup(txid: string): 'hit' | 'miss' | 'unknown' {
  const cached = readRawTxCache(txid)
  if (!cached) return 'unknown'
  return cached.hex ? 'hit' : 'miss'
}

/** Pin a confirmed empty lookup so Refresh / heal do not re-hammer Bitails. */
export function rememberRawTxMiss(txid: string): void {
  if (readRawTxCache(txid)?.hex) return
  writeRawTxCache(txid, null)
}

export async function fetchRawTxHex(txid: string, chain: Chain): Promise<string | null> {
  const cached = readRawTxCache(txid)
  if (cached) return cached.hex
  const key = rawTxKey(txid)
  try {
    const wallet = getActiveWallet()
    if (wallet) {
      const { getLocalBeefForTxid } = await import('./beefCache')
      const beef = await getLocalBeefForTxid(wallet, key)
      const held = beef?.findTxid(key)?.tx
      if (held) {
        const hex = held.toHex()
        writeRawTxCache(txid, hex)
        return hex
      }
    }
  } catch {
    /* local BEEF probe failed — fall through */
  }
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
 * Toolbox `getRawTx` already walks Bitails → JungleBus → WhatsOnChain (each up
 * to ~8s). Bound the whole walk so a hung host cannot wedge Refresh, but give
 * enough room for three fast 404s — the old 6s ceiling timed out mid-walk and
 * forced a duplicate public Bitails/WoC fan-out.
 */
const PROVIDER_TIMEOUT_MS = 20_000

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
  const services = getActiveWallet()?.services
  if (services) {
    try {
      const raw = await withTimeout(services.getRawTx(txid), PROVIDER_TIMEOUT_MS)
      const bytes = raw?.rawTx
      if (bytes && bytes.length > 0) {
        return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
      }
      // Empty result means every registered provider already said "nothing" —
      // do not fan out Bitails/WoC again (that was the console 404 storm).
      return null
    } catch {
      // Timed out / threw — try public endpoints once below.
    }
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
  const tipData = meta.data
  const insc = tipData?.insc ?? originData?.insc
  const bsv20 = tipData?.bsv20 ?? originData?.bsv20
  const mime = asString(insc?.file?.type)
  // The origin is the mint, or an earlier hop of the same token, and states the
  // balance held *there* — reading `amt` from it credits the sender's prior
  // total instead of what they transferred. Only this output can say what it
  // holds, so the tip is asked first and the origin is a last resort.
  const tipPayload = bsv21PayloadFromGpData(tipData)
  const originPayload = bsv21PayloadFromGpData(originData)
  const payload = tipPayload ?? originPayload
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
  // Ticker, icon and decimals are declared once at the deploy, so a transfer
  // body legitimately omits them — unlike the balance, these are the origin's
  // to answer. `dec` parses to 0 when absent, which reads the same as a token
  // deployed with no decimals; either way the origin's value is correct.
  const sym = payload.sym ?? originPayload?.sym
  const icon = payload.icon ?? originPayload?.icon
  const dec = payload.dec || originPayload?.dec || 0
  return {
    outpoint: tipOutpoint.includes('_')
      ? tipOutpoint.replace(/_(\d+)$/, '.$1')
      : tipOutpoint,
    tokenId,
    amt: payload.amt,
    op: payload.op,
    ...(sym ? { sym } : {}),
    ...(icon ? { icon } : {}),
    dec,
  }
}

/** Parse the BSV-21 body of one side of a txo payload (tip or origin). */
function bsv21PayloadFromGpData(
  data: GpTxo['data'] | undefined,
): Bsv21Payload | null {
  if (!data) return null
  const fromJson = parseBsv21Json(data.insc?.json)
  if (fromJson) return fromJson
  const bsv20 = data.bsv20
  if (!bsv20) return null
  return parseBsv21Json({
    p: 'bsv-20',
    op: bsv20.op,
    id: bsv20.id,
    amt: bsv20.amt,
    sym: bsv20.sym,
    icon: bsv20.icon,
    dec: bsv20.dec,
  })
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
  // Import credits a balance, so only this output's own body may set it. Until
  // the index has parsed the tip its `origin` still answers — with the mint's
  // amount — and banking that would corrupt token accounting. Hold instead;
  // the next pass re-asks and imports once the real body is there.
  if (!meta.data?.insc?.json && !meta.data?.bsv20) return null
  const holding = extractBsv21FromGp(meta, tip)
  if (!holding) return null
  return { ...holding, txid, vout }
}

/**
 * Resolve inscription *display* origin for a 1-sat outpoint (grade C CDN / indexer
 * metadata). Ownership and identity must not depend on this — the BRC-150
 * tip→origin proof + SPV BEEF remain grade A. GorillaPool `/content` is pictures
 * after origin is known.
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
  if (!wallet) return null
  try {
    const { getLocalBeefForTxid } = await import('./beefCache')
    const beef = await getLocalBeefForTxid(wallet, txid)
    if (!beef) return null
    const held = `${txid}.${vout}`
    const proof = rebuildProvenanceV2FromBeef(beef, held)
    if (!proof) return null
    rememberProvenVerdict(held, {
      tier: 'brc150',
      origin: proof.origin,
      path: proof.path,
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

/** Per-pass ceiling on transfer-shape probes (a couple of cached rawtx fetches each). */
export const MAX_TRANSFER_PROBES_PER_PASS = 12

type OrdinalTransferProbe = 'item' | 'bsv21' | 'ft' | 'unknown'

/** Inscribed parent tip shape — bare needs a further hop. */
type OnesatParentShape = 'nft' | 'ft' | 'ftHop' | 'bare' | 'other'

/** Bound the FT-vs-NFT lineage walk on bare transfer tips. */
const BARE_LINEAGE_DEPTH = 6

function shapeOfOnesatLock(
  scriptHex: string | undefined,
  satoshis: number | undefined,
): OnesatParentShape {
  if (satoshis !== 1) return 'other'
  if (isOnesatFtAmtHop(scriptHex)) return 'ftHop'
  if (looksLikeOnesatFtTip({ lockingScriptHex: scriptHex })) return 'ft'
  const envelope = parseOrdEnvelope(scriptHex)
  if (envelope) {
    if (isOnesatFtMime(envelope.contentType)) {
      return isOnesatFtAmtHop(scriptHex) ? 'ftHop' : 'ft'
    }
    if (isBsv21Mime(envelope.contentType)) return 'other'
    return 'nft'
  }
  if (hasOrdEnvelope(scriptHex)) return 'other'
  return 'bare'
}

/**
 * Bare 1-sat tips are used by both NFT transfers and 1Sat FT transfers.
 * "Parent is also 1 sat" is therefore not enough to paint a collectable —
 * walk to an inscribed ancestor: FT mime ⇒ hold (not NFT); other ord ⇒ item.
 */
async function lineageOfBareOnesatSpend(
  tx: Transaction,
  chain: Chain,
  depth: number,
  seen: Set<string>,
): Promise<{ kind: 'item' | 'ft' | 'unknown'; origin?: string }> {
  if (depth <= 0) return { kind: 'unknown' }

  let sawFt = false
  let sawNft = false
  let ftOrigin: string | undefined

  for (const input of tx.inputs.slice(0, VIN_PROBE_LIMIT)) {
    const sourceTxid = input.sourceTXID?.trim().toLowerCase()
    const sourceVout = input.sourceOutputIndex
    if (!sourceTxid || !Number.isInteger(sourceVout)) continue
    if (seen.has(`${sourceTxid}:${sourceVout}`)) continue
    seen.add(`${sourceTxid}:${sourceVout}`)

    const parentHex = await fetchRawTxHex(sourceTxid, chain)
    if (!parentHex) continue
    let parentTx: Transaction
    try {
      parentTx = Transaction.fromHex(parentHex)
    } catch {
      continue
    }
    const parentOut = parentTx.outputs[sourceVout!]
    const shape = shapeOfOnesatLock(
      parentOut?.lockingScript?.toHex(),
      parentOut?.satoshis,
    )
    if (shape === 'ft') {
      sawFt = true
      ftOrigin = `${sourceTxid}_${sourceVout}`
      continue
    }
    if (shape === 'nft') {
      sawNft = true
      continue
    }
    if (shape === 'bare' || shape === 'ftHop') {
      const nested = await lineageOfBareOnesatSpend(
        parentTx,
        chain,
        depth - 1,
        seen,
      )
      if (nested.kind === 'ft') {
        sawFt = true
        ftOrigin = nested.origin ?? ftOrigin
      }
      if (nested.kind === 'item') sawNft = true
    }
  }

  // FT lineage wins: file into `1sat-ft` (mint origin), never basket `1sat`.
  if (sawFt) return { kind: 'ft', origin: ftOrigin }
  if (sawNft) return { kind: 'item' }
  return { kind: 'unknown' }
}

/**
 * Instant-ingest evidence for an unknown 1-sat, without an indexer.
 *
 * By 1Sat rules an NFT transfer moves an existing 1-sat tip, so its settle
 * transaction spends a 1-sat input and pays bare P2PKH; a mint carries the ord
 * envelope in the output itself; a valid BSV-21 fungible always re-inscribes
 * its token JSON, so a bare 1-sat can never be a BSV-21 holding. 1Sat FT
 * transfers use the same bare tip shape — parent lineage (not "any 1-sat
 * parent") decides NFT vs hold-for-FT. Authentication stays with BRC-150.
 */
async function probeOrdinalTransfer(
  txid: string,
  vout: number,
  chain: Chain,
): Promise<{ kind: OrdinalTransferProbe; origin?: string }> {
  const hex = await fetchRawTxHex(txid, chain)
  if (!hex) return { kind: 'unknown' }
  let tx: Transaction
  try {
    tx = Transaction.fromHex(hex)
  } catch {
    return { kind: 'unknown' }
  }
  const out = tx.outputs[vout]
  if (!out || out.satoshis !== 1) return { kind: 'unknown' }

  const scriptHex = out.lockingScript?.toHex()
  const envelope = parseOrdEnvelope(scriptHex)
  if (envelope) {
    // Inscribed at this outpoint — a mint, so tip-as-origin is literally
    // correct. BSV-21 → basket `bsv21`. 1Sat FT → basket `1sat-ft` (not NFT).
    if (isBsv21Mime(envelope.contentType)) return { kind: 'bsv21' }
    if (
      isOnesatFtMime(envelope.contentType) ||
      looksLikeOnesatFtTip({ lockingScriptHex: scriptHex })
    ) {
      const named = originFromOnesatFtLock(scriptHex)
      if (named) return { kind: 'ft', origin: named }
      if (isOnesatFtAmtHop(scriptHex)) {
        const lineage = await lineageOfBareOnesatSpend(
          tx,
          chain,
          BARE_LINEAGE_DEPTH,
          new Set(),
        )
        if (lineage.kind === 'ft') return { kind: 'ft', origin: lineage.origin }
        return { kind: 'unknown' }
      }
      return { kind: 'ft', origin: txidVoutUnderscore(txid, vout) }
    }
    // Image sibling in a 1sat-ft genesis tx is a ticker icon, not a collectable.
    const mime = (envelope.contentType ?? '').toLowerCase().split(';')[0]!.trim()
    if (mime.startsWith('image/')) {
      for (let i = 0; i < tx.outputs.length; i++) {
        if (i === vout) continue
        const sibling = tx.outputs[i]
        if (!sibling || sibling.satoshis !== 1) continue
        const sibEnv = parseOrdEnvelope(sibling.lockingScript?.toHex())
        if (sibEnv && isOnesatFtMime(sibEnv.contentType)) return { kind: 'unknown' }
      }
    }
    return { kind: 'item' }
  }
  // Envelope structure we cannot parse a mime out of: let the indexer decide.
  if (hasOrdEnvelope(scriptHex)) return { kind: 'unknown' }

  // Bare P2PKH: NFT only when lineage reaches a non-FT ordinal inscription.
  const lineage = await lineageOfBareOnesatSpend(
    tx,
    chain,
    BARE_LINEAGE_DEPTH,
    new Set(),
  )
  if (lineage.kind === 'item') return { kind: 'item' }
  if (lineage.kind === 'ft') return { kind: 'ft', origin: lineage.origin }
  return { kind: 'unknown' }
}

/**
 * Split scanned UTXOs. Sweep eligibility is {@link chooseLegacySweepPath} only —
 * never a bare `satoshis > 1` test.
 * - funding: sweep path — safe to `importLegacyUtxos`
 * - oneSats: cloud-known or GorillaPool-confirmed NFT inscriptions (exactly 1 sat)
 * - bsv21: confirmed BSV-21 fungible tips — basket `bsv21` under Collect
 * - heldOneSats: every other 1-sat — MUST NOT be swept
 * - heldUneconomical: >1 sat but below the sweep floor — MUST NOT be swept
 */
export async function classifyLegacyUtxos(
  utxos: LegacyUtxo[],
  chain: Chain,
  knownItems: MigrationItem[] = [],
  opts: {
    /**
     * Skip every indexer round trip used to name a tip. Funding is decided by
     * {@link chooseLegacySweepPath} alone, so a send can still tell what it may
     * spend without waiting on ordinal lookups it will never use.
     */
    fundingOnly?: boolean
    /**
     * Outpoints already known as 1sat collectables (import mark, basket `1sat`,
     * remittance, or BRC-150). Never route these to bsv21 / NFT.
     */
    knownCollectableOutpoints?: Iterable<string>
    /** Cached remittance so heal/reimport keeps origin + name. */
    collectableRemittance?: ReadonlyMap<
      string,
      { origin?: string; name?: string; app?: string; collectionId?: string }
    >
  } = {},
): Promise<ClassifiedLegacyUtxos> {
  const outpointKey = (outpoint: string): string =>
    outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
  const latchedCollectables = collectableKeySet(opts.knownCollectableOutpoints ?? [])

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

  const onesatFt: MigrationItem[] = []
  const funding: LegacyUtxo[] = []
  const heldOneSats: LegacyUtxo[] = []
  const heldUneconomical: LegacyUtxo[] = []
  const pendingTips: LegacyUtxo[] = []

  // Identifying one unknown dust output costs a backwards walk — a request per
  // input per hop — and the loop below is serial, so a wallet holding a pile of
  // stray dust could spend minutes in a single pass before the UI saw anything.
  // Unbudgeted outputs are simply held and picked up by a later pass.
  let resolveBudget = MAX_UNKNOWN_RESOLVES_PER_PASS
  let probeBudget = MAX_TRANSFER_PROBES_PER_PASS

  for (const u of candidates) {
    if (claimed.has(outpointKey(u.outpoint))) continue

    // HARD RULE: never fund-sweep 1-sat outs.
    // GorillaPool only when we have no local claim (knownItems / cloud migrate).
    // A tip already internalized with remittance never reaches this path again;
    // unknown dust is walked once and then backed off via inscriptionCache.
    const sweepPath = chooseLegacySweepPath(u)
    if (sweepPath.path === 'hold' && sweepPath.reason === 'oneSat') {
      // A send never spends a tip, so it does not need one identified. Hold it
      // and move on rather than paying for an indexer walk mid-payment.
      if (opts.fundingOnly) {
        heldOneSats.push(u)
        continue
      }
      const liveKey = outpointKey(u.outpoint)
      if (latchedCollectables.has(liveKey)) {
        const rem = opts.collectableRemittance?.get(liveKey)
        oneSats.push(
          applyCollectableRemittance(
            {
              outpoint: u.outpoint,
              txid: u.txid,
              vout: u.vout,
              origin: rem?.origin ?? txidVoutUnderscore(u.txid, u.vout),
              name: rem?.name,
              app: rem?.app,
              collectionId: rem?.collectionId,
            },
            rem,
          ),
        )
        claimed.add(liveKey)
        continue
      }
      const known = knownByOutpoint.get(outpointKey(u.outpoint))
      let resolved:
        | { origin: string; name?: string; app?: string; collectionId?: string }
        | null = null
      if (known?.origin != null) {
        resolved = {
          origin: known.origin.includes('.')
            ? known.origin.replace(/\.(\d+)$/, '_$1')
            : known.origin,
          name: known.name,
          app: known.app,
          collectionId: known.collectionId,
        }
      } else if (known) {
        resolved = {
          origin: txidVoutUnderscore(u.txid, u.vout),
          name: known.name,
          app: known.app,
          collectionId: known.collectionId,
        }
      } else {
        const cacheKey = `${u.txid}.${u.vout}`
        resolved = getResolvedInscription(cacheKey)
        const mayResolve =
          !resolved && shouldResolveInscription(cacheKey, Date.now(), RESOLVE_RETRY_MS)

        // Instant ingest, deferred verify. The transfer-shape probe replaces
        // the removed latch fast path: tip-as-origin paints a card now, and
        // the post-paint authenticity walk (BRC-150) proves the real origin
        // and fills name/traits. No indexer, no ancestry walk here.
        if (mayResolve && probeBudget > 0) {
          probeBudget--
          const probe = await probeOrdinalTransfer(u.txid, u.vout, chain)
          if (probe.kind === 'item') {
            resolved = { origin: txidVoutUnderscore(u.txid, u.vout) }
          } else if (probe.kind === 'ft') {
            onesatFt.push({
              outpoint: u.outpoint,
              txid: u.txid,
              vout: u.vout,
              origin: probe.origin ?? txidVoutUnderscore(u.txid, u.vout),
            })
            claimed.add(liveKey)
            continue
          }
        }

        if (!resolved && mayResolve && resolveBudget > 0) {
          resolveBudget--
          // Fungibles first — same indexer hit, divert before NFT identity.
          const ft = await resolveBsv21Holding(u.txid, u.vout, chain)
          if (ft) {
            bsv21.push(ft)
            claimed.add(outpointKey(u.outpoint))
            continue
          }

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
      }

      if (resolved || known) {
        oneSats.push({
          outpoint: u.outpoint,
          txid: u.txid,
          vout: u.vout,
          origin: resolved?.origin ?? known?.origin ?? txidVoutUnderscore(u.txid, u.vout),
          name: resolved?.name ?? known?.name,
          app: resolved?.app ?? known?.app,
          collectionId: resolved?.collectionId ?? known?.collectionId,
        })
        claimed.add(outpointKey(u.outpoint))
      } else {
        heldOneSats.push(u)
        // Tips the indexer has not named yet still need faster polls — held is
        // not the same as abandoned. A 404 backs off via inscriptionCache; a
        // budget skip is the usual "still arriving" case.
        const cacheKey = `${u.txid}.${u.vout}`
        if (
          !opts.fundingOnly &&
          shouldResolveInscription(cacheKey, Date.now(), RESOLVE_RETRY_MS)
        ) {
          pendingTips.push(u)
        }
      }
      continue
    }

    if (sweepPath.path === 'sweep') {
      funding.push(u)
      continue
    }
    if (sweepPath.path === 'hold' && sweepPath.reason === 'uneconomical') {
      heldUneconomical.push(u)
    }
    // nonPositive / weird values: ignore (do not sweep)
  }

  return { funding, oneSats, bsv21, onesatFt, heldOneSats, heldUneconomical, pendingTips }
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

  const groups = [...byTxid.entries()]
  const parts = await mapPool(groups, IMPORT_TX_CONCURRENCY, async ([txid, group]) => {
    const groupOps = group.map((g) => g.outpoint)
    const part: OneSatImportResult = {
      imported: 0,
      failed: 0,
      errors: [],
      outpoints: [],
    }
    try {
      await yieldToUi()
      const atomic = await getAtomicBeefBinaryForTxid(wallet, txid)
      await yieldToUi()
      const beef = Beef.fromBinary(atomic)
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
      if (ordinals.length === 0) return part

      const remittanceOutputs = []
      for (const item of ordinals) {
        const origin =
          item.origin ?? item.outpoint.replace(/\.(\d+)$/, '_$1')
        remittanceOutputs.push({
          outputIndex: item.vout!,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: '1sat',
            tags: stampBrc164Id([
              'ordinal',
              `origin:${origin.replace(/_(\d+)$/, '.$1')}`,
              ...(item.name ? [`name:${item.name.slice(0, 80)}`] : []),
              ...(item.app ? [`app:${item.app.slice(0, 40)}`] : []),
              ...(item.collectionId
                ? [`collection:${item.collectionId.slice(0, 80)}`]
                : []),
            ]),
            customInstructions: buildInternalizeCustomInstructions({
              origin,
              name: item.name ?? 'Collectable',
              app: item.app,
              collectionId: item.collectionId,
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

      part.imported = ordinals.length
      part.outpoints = ordinals.map((i) => i.outpoint)
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
      part.failed = group.length
      const msg = err instanceof Error ? err.message : String(err)
      for (const item of group) {
        part.errors.push(`${item.outpoint}: ${msg}`)
      }
      console.warn('[1sat] internalize failed', txid, err)
    }
    return part
  })

  return {
    imported: parts.reduce((n, p) => n + p.imported, 0),
    failed: parts.reduce((n, p) => n + p.failed, 0),
    errors: parts.flatMap((p) => p.errors),
    outpoints: parts.flatMap((p) => p.outpoints),
  }
}


/** Internalize classified 1sat-ft tips into basket `1sat-ft` by mint origin. */
export async function importOnesatFtTips(
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
  const toImport = normalized.filter((i) =>
    claimedSet.has(i.outpoint.trim().toLowerCase()),
  )
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

  const groups = [...byTxid.entries()]
  const parts = await mapPool(groups, IMPORT_TX_CONCURRENCY, async ([txid, group]) => {
    const groupOps = group.map((g) => g.outpoint)
    const part: OneSatImportResult = {
      imported: 0,
      failed: 0,
      errors: [],
      outpoints: [],
    }
    try {
      await yieldToUi()
      const atomic = await getAtomicBeefBinaryForTxid(wallet, txid)
      await yieldToUi()
      const beef = Beef.fromBinary(atomic)
      const sourceTx = beef.findAtomicTransaction(txid)
      const remittanceOutputs = group.map((item) => {
        const origin = normalizeColourOrigin(item.origin ?? txidVoutUnderscore(txid, item.vout!))
        const scriptHex = sourceTx?.outputs?.[item.vout!]?.lockingScript?.toHex()
        const amt = parseColourTipAmt({ lockingScriptHex: scriptHex })
        return {
          outputIndex: item.vout!,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: ONESAT_FT_BASKET,
            tags: stampBrc164Id(colourTags(origin)),
            customInstructions: buildColourCustomInstructions({
              origin,
              ...(amt > 0 ? { amt } : {}),
            }),
          },
        }
      })
      await wallet.wallet.internalizeAction({
        tx: atomic,
        description: 'Import 1sat-ft',
        labels: [ONESAT_FT_BASKET, 'handcash-1sat-ft-scan'],
        outputs: remittanceOutputs,
        seekPermission: false,
      })
      part.imported = group.length
      part.outpoints = group.map((i) => i.outpoint)
      markOneSatImported(groupOps)
    } catch (err) {
      markOneSatImportFailed(groupOps)
      part.failed = group.length
      const msg = err instanceof Error ? err.message : String(err)
      for (const item of group) {
        part.errors.push(`${item.outpoint}: ${msg}`)
      }
      console.warn('[1sat-ft-scan] internalize failed', txid, err)
    }
    return part
  })

  const result = {
    imported: parts.reduce((n, p) => n + p.imported, 0),
    failed: parts.reduce((n, p) => n + p.failed, 0),
    errors: parts.flatMap((p) => p.errors),
    outpoints: parts.flatMap((p) => p.outpoints),
  }
  if (result.imported > 0) {
    void import('./deviceSync')
      .then(({ scheduleHistoryBackupPush }) =>
        scheduleHistoryBackupPush('importOnesatFtTips'),
      )
      .catch(() => {})
    void import('./colourListing')
      .then(({ listColourTokens }) => listColourTokens(wallet))
      .catch(() => {})
  }
  return result
}

export function contentUrlForOrigin(origin: string, chain: Chain = 'main'): string {
  const underscored = origin.includes('.')
    ? origin.replace(/\.(\d+)$/, '_$1')
    : origin
  return `${gorillaBase(chain)}/content/${underscored}`
}
