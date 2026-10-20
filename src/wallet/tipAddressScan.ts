/**
 * Recovery: discover 1-sat tips on the wallet receive address via GorillaPool.
 *
 * Plain address providers (WOC / Bitails) treat inscription envelopes as
 * `nonstandard` and omit them from address UTXO lists — including self-sent
 * 1Sat ordinals. Refresh asks the ordinal index for them
 * (`scanAddressOrdinalTxos`); scan results are evidence, never ownership.
 *
 * HARD RULE: only 1-satoshi outputs — never spend real funds from an indexer hint.
 */
import type { Chain } from './vault'
import type { ActiveWallet } from './session'
import { scanLegacyAddress, type LegacyScanResult, type LegacyUtxo } from './legacyScan'

type IndexTxoRow = {
  txid?: unknown
  vout?: unknown
  outpoint?: unknown
  satoshis?: unknown
  height?: unknown
  spend?: unknown
}

/** Rows per request — the largest page the index serves. */
const PAGE_LIMIT = 1_000
/**
 * Ceiling on pages per pass. Imported tips stay unspent at the address, so a
 * capped read never reaches the rows past it: the ceiling must sit above any
 * real inventory (hc-a580a: 2,823 tips, 1,000 read, the rest never listed).
 */
const MAX_PAGES = 50
const REQUEST_TIMEOUT_MS = 8_000
/** Don't pay the timeout again on every poll after the indexer just failed. */
const HOST_COOLDOWN_MS = 45_000

let ordinalCooldownUntil = 0

/** Test-only — clear the indexer skip window. */
export function resetTipAddressScanCooldownForTests(): void {
  ordinalCooldownUntil = 0
}

function ordinalsBase(chain: Chain): string {
  return chain === 'main'
    ? 'https://ordinals.gorillapool.io'
    : 'https://testnet.ordinals.gorillapool.io'
}

function toLegacyUtxo(row: IndexTxoRow): LegacyUtxo | null {
  const txid = typeof row.txid === 'string' ? row.txid.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(txid)) return null

  const vout = Number(row.vout)
  if (!Number.isInteger(vout) || vout < 0) return null

  // Spent rows should not appear on an `unspent` page, but the field is cheap
  // to honour and a stale row would otherwise be re-imported forever.
  if (typeof row.spend === 'string' && row.spend.trim().length > 0) return null

  const satoshis = Number(row.satoshis)
  if (satoshis !== 1) return null

  const height = Number(row.height)
  return {
    outpoint: `${txid}.${vout}`,
    txid,
    vout,
    satoshis,
    ...(Number.isInteger(height) && height > 0 ? { height } : {}),
  }
}

async function fetchTxoPage(
  address: string,
  chain: Chain,
  offset: number,
): Promise<IndexTxoRow[]> {
  const qs = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    offset: String(offset),
  })
  const url =
    `${ordinalsBase(chain)}/api/txos/address/${encodeURIComponent(address)}/unspent` +
    `?${qs.toString()}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`ordinals index ${res.status}`)
  const body = (await res.json()) as unknown
  return Array.isArray(body) ? (body as IndexTxoRow[]) : []
}

/**
 * 1Sat ordinal / file tips held on `address` (unfiltered ordinal index).
 *
 * WOC/Bitails miss these because the locking script is nonstandard. Used by
 * Refresh so self-sent ords still enter basket `1sat`.
 */
export async function scanAddressOrdinalTxos(
  address: string,
  chain: Chain,
): Promise<LegacyUtxo[]> {
  // Total by contract: the caller folds this into a scan it must not lose, so
  // a bad argument degrades like an outage rather than rejecting the Refresh.
  if (typeof address !== 'string' || !address.trim()) return []
  if (Date.now() < ordinalCooldownUntil) {
    console.info('[ordinal-scan] skipping ordinal index (recently failed)')
    return []
  }

  const byOutpoint = new Map<string, LegacyUtxo>()
  const started = Date.now()
  let pages = 0
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchTxoPage(address, chain, page * PAGE_LIMIT)
      pages += 1
      for (const row of rows) {
        const utxo = toLegacyUtxo(row)
        if (utxo) byOutpoint.set(utxo.outpoint, utxo)
      }
      if (rows.length < PAGE_LIMIT) break
      if (page === MAX_PAGES - 1) {
        console.warn(
          `[ordinal-scan] stopped at ${MAX_PAGES * PAGE_LIMIT} tip(s) — the rest stay unlisted`,
        )
      }
    }
    ordinalCooldownUntil = 0
    if (pages > 1) {
      console.info(
        `[ordinal-scan] ordinal index ${pages} pages done ${Date.now() - started}ms — ${byOutpoint.size} tip(s)`,
      )
    }
  } catch (err) {
    ordinalCooldownUntil = Date.now() + HOST_COOLDOWN_MS
    console.warn('[ordinal-scan] ordinal index lookup failed', err)
    // Partial pages are still real holdings — keep whatever answered.
  }

  return [...byOutpoint.values()]
}

/** Normalize outpoint keys the same way import guards do. */
function outpointKey(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

/**
 * Fold ordinal-index tips into the provider scan.
 *
 * The sources answer different questions, so rows only ever get added —
 * a tip the address provider already listed keeps the provider's row, and
 * an empty index result leaves the scan untouched.
 */
export function mergeIndexedTips(
  scan: LegacyScanResult,
  indexed: LegacyUtxo[],
): LegacyScanResult {
  if (indexed.length === 0) return scan
  const seen = new Set(scan.utxos.map((u) => outpointKey(u.outpoint)))
  const extra = indexed.filter((u) => !seen.has(outpointKey(u.outpoint)))
  if (extra.length === 0) return scan

  console.info(
    `[chain-ingest] ordinal index added ${extra.length} tip(s) the address scan could not see`,
  )
  const utxos = [...scan.utxos, ...extra]
  return { ...scan, utxos, sats: utxos.reduce((s, u) => s + u.satoshis, 0) }
}

/**
 * The live tip set: address provider ∪ ordinal index.
 *
 * Every ownership judgement runs against this, so it has exactly one
 * definition. `scanLegacyAddress` alone cannot see an inscription envelope —
 * providers call it `nonstandard` — so a provider-only scan is silence about
 * inscribed tips, not a statement that they are gone. Refreshing the cached
 * ownership set from the bare provider scan let the send gate call index-only
 * tips spent and hide them.
 */
export async function scanLiveTipUtxos(
  active: ActiveWallet,
): Promise<LegacyScanResult> {
  const [addressScan, ordinalTxos] = await Promise.all([
    scanLegacyAddress(active),
    scanAddressOrdinalTxos(active.address, active.chain),
  ])
  return mergeIndexedTips(addressScan, ordinalTxos)
}
