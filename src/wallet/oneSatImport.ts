/**
 * Import 1Sat ordinals into BRC-100 basket `1sat` via internalizeAction.
 *
 * HARD RULE: never pass satoshis === 1 through fundWalletFromP2PKHOutpoints.
 * Unrecognized 1-sat outs stay on the address until classified (cloud items or GorillaPool).
 *
 * GorillaPool often lags on the *current* transfer outpoint. When the new location
 * is not indexed yet, walk prior inputs (WhatsOnChain) and resolve origin from there.
 */
import type { ActiveWallet } from './session'
import { getActiveWallet } from './session'
import type { Chain } from './vault'
import type { LegacyUtxo } from './legacyScan'
import {
  buildInternalizeCustomInstructions,
} from './oneSatProvenance'
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
} from './inscriptionCache'
import {
  ONE_SAT_LATCH_BASKET,
  isLatchDustSats,
  latchOutputTags,
} from './oneSatLatch'

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

function toUnderscoreOutpoint(txid: string, vout: number): string {
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

type GpTxo = {
  origin?:
    | string
    | {
        outpoint?: string
        data?: {
          map?: GpMap
          insc?: { file?: { type?: string }; text?: string; json?: unknown }
        }
      }
  data?: {
    map?: GpMap
    insc?: { file?: { type?: string }; text?: string; json?: unknown }
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return undefined
}

function parseTraits(raw: unknown): CollectableTrait[] {
  if (!Array.isArray(raw)) return []
  const traits: CollectableTrait[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    const name = asString(o.name) ?? asString(o.trait_type) ?? asString(o.trait)
    const value = asString(o.value) ?? asString(o.val)
    if (name && value) traits.push({ name, value })
  }
  return traits
}

function extractResolved(meta: GpTxo): ResolvedInscription | null {
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

type WocVin = { txid?: string; vout?: number }
type WocTx = { vin?: WocVin[] }

async function fetchWocTx(txid: string, chain: Chain): Promise<WocTx | null> {
  try {
    const url = `${wocBase(chain)}/tx/${txid}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return (await res.json()) as WocTx
  } catch {
    return null
  }
}

/**
 * Resolve inscription origin for a 1-sat outpoint.
 * Falls back to walking prior inputs when GorillaPool has not indexed the new location yet.
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
    const key = toUnderscoreOutpoint(curTxid, curVout)
    if (seen.has(key)) break
    seen.add(key)

    const meta = await fetchGpTxo(key, chain)
    if (meta) {
      const resolved = extractResolved(meta)
      if (resolved) return resolved
    }

    if (depth === maxDepth) break

    const tx = await fetchWocTx(curTxid, chain)
    const vins = tx?.vin ?? []
    if (vins.length === 0) break

    // Prefer any prior outpoint GorillaPool already knows as an ordinal.
    let next: { txid: string; vout: number } | null = null
    for (const vin of vins.slice(0, 12)) {
      if (typeof vin.txid !== 'string' || !Number.isInteger(vin.vout)) continue
      const prevKey = toUnderscoreOutpoint(vin.txid, vin.vout!)
      if (seen.has(prevKey)) continue
      const prevMeta = await fetchGpTxo(prevKey, chain)
      if (prevMeta) {
        const resolved = extractResolved(prevMeta)
        if (resolved) return resolved
      }
      if (!next) next = { txid: vin.txid, vout: vin.vout! }
    }

    if (!next) break
    curTxid = next.txid
    curVout = next.vout
  }

  return null
}

/** Probe whether this outpoint is (or carries) a known inscription. */
export async function isOneSatInscription(
  txid: string,
  vout: number,
  chain: Chain,
): Promise<boolean> {
  return (await resolveOneSatInscription(txid, vout, chain)) != null
}

/**
 * Split scanned UTXOs.
 * - funding: satoshis > 1 and not latch dust — safe to fund-sweep
 * - oneSats: cloud-known or GorillaPool-confirmed inscriptions (exactly 1 sat)
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
  const scannedByOutpoint = new Map<string, LegacyUtxo>()
  for (const u of utxos) {
    scannedByOutpoint.set(outpointKey(u.outpoint), u)
  }

  const oneSats: MigrationItem[] = []
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

  // BRC-153 co-creates tip (OUTPUT:0) and latch (OUTPUT:1) in one transfer, and
  // the latch is plain P2PKH so a receiver sees it on a normal address scan. A
  // latch paying us is therefore local proof that output 0 of the same
  // transaction is an ordinal tip. It cannot tell us *which* origin the tip
  // carries — that lives in sender-side remittance, not in the script — so the
  // indexer is still needed for identity, just not to know an item arrived.
  const latchTxids = new Set<string>()
  for (const u of utxos) {
    if (isLatchDustSats(u.satoshis)) latchTxids.add(u.txid.trim().toLowerCase())
  }

  for (const u of utxos) {
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
          origin: toUnderscoreOutpoint(u.txid, u.vout),
          name: known.name,
          app: known.app,
        }
      } else {
        const cacheKey = `${u.txid}.${u.vout}`
        resolved = getResolvedInscription(cacheKey)
        // The 10-minute miss backoff exists to stop us hammering the indexer
        // over stray dust. A latch-proven tip is not stray dust — it is an
        // item we know landed, so backing off just leaves a real transfer
        // invisible for ten minutes at a time.
        const latchProven = u.vout === 0 && latchTxids.has(u.txid.trim().toLowerCase())
        if (!resolved && (latchProven || shouldResolveInscription(cacheKey))) {
          const fetched = await resolveOneSatInscription(u.txid, u.vout, chain)
          if (fetched) {
            rememberResolvedInscription(cacheKey, fetched)
            resolved = fetched
          } else {
            rememberUnresolved(cacheKey)
          }
        }
        if (!resolved && latchProven) {
          console.info(
            `[1sat] latch-proven tip ${cacheKey} has no origin yet — holding, will retry next sync`,
          )
          pendingTips.push(u)
        }
      }

      if (resolved || known) {
        oneSats.push({
          outpoint: u.outpoint,
          txid: u.txid,
          vout: u.vout,
          origin: resolved?.origin ?? known?.origin ?? toUnderscoreOutpoint(u.txid, u.vout),
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

  return { funding, oneSats, latches, heldOneSats, pendingTips }
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
