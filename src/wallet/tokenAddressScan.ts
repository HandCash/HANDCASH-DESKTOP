/**
 * Recovery: discover 1-sat tips on the wallet receive address via GorillaPool.
 *
 * Plain address providers (WOC / Bitails) treat inscription envelopes as
 * `nonstandard` and omit them from address UTXO lists — including self-sent
 * 1Sat ordinals. Refresh must ask the ordinal index for:
 * - NFT / file tips (`scanAddressOrdinalTxos`, no filter)
 * - Legacy BSV-21 tips (`scanAddressTokenTxos`, `bsv20=true`)
 *
 * 1Sat fungibles (`1sat-ft`) do **not** rely on this path — custody is
 * tip→origin remittance / peer settle.
 *
 * HARD RULE: only 1-satoshi outputs — never spend real funds from an indexer hint.
 */
import type { Chain } from './vault'
import type { LegacyUtxo } from './legacyScan'

type TokenTxoRow = {
  txid?: unknown
  vout?: unknown
  outpoint?: unknown
  satoshis?: unknown
  height?: unknown
  spend?: unknown
}

/** Rows per request — same page size the phrase-sweep item count uses. */
const PAGE_LIMIT = 100
/**
 * Ceiling on pages per pass. A wallet holding more tips than this still heals:
 * the unseen rows are picked up once the imported ones stop being returned as
 * unspent.
 */
const MAX_PAGES = 10
const REQUEST_TIMEOUT_MS = 8_000
/** Don't pay the timeout again on every poll after the indexer just failed. */
const HOST_COOLDOWN_MS = 45_000

let tokenCooldownUntil = 0
let ordinalCooldownUntil = 0

/** Test-only — clear the indexer skip windows. */
export function resetTokenAddressScanCooldownForTests(): void {
  tokenCooldownUntil = 0
  ordinalCooldownUntil = 0
}

function ordinalsBase(chain: Chain): string {
  return chain === 'main'
    ? 'https://ordinals.gorillapool.io'
    : 'https://testnet.ordinals.gorillapool.io'
}

function toLegacyUtxo(row: TokenTxoRow): LegacyUtxo | null {
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
  opts: { bsv20: boolean },
): Promise<TokenTxoRow[]> {
  const qs = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    offset: String(offset),
  })
  if (opts.bsv20) qs.set('bsv20', 'true')
  const url =
    `${ordinalsBase(chain)}/api/txos/address/${encodeURIComponent(address)}/unspent` +
    `?${qs.toString()}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`ordinals index ${res.status}`)
  const body = (await res.json()) as unknown
  return Array.isArray(body) ? (body as TokenTxoRow[]) : []
}

async function scanAddressTxos(
  address: string,
  chain: Chain,
  opts: {
    bsv20: boolean
    logTag: string
    getCooldown: () => number
    setCooldown: (until: number) => void
  },
): Promise<LegacyUtxo[]> {
  // Total by contract: the caller folds this into a scan it must not lose, so
  // a bad argument degrades like an outage rather than rejecting the Refresh.
  if (typeof address !== 'string' || !address.trim()) return []
  if (Date.now() < opts.getCooldown()) {
    console.info(`[${opts.logTag}] skipping ordinal index (recently failed)`)
    return []
  }

  const byOutpoint = new Map<string, LegacyUtxo>()
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchTxoPage(address, chain, page * PAGE_LIMIT, {
        bsv20: opts.bsv20,
      })
      for (const row of rows) {
        const utxo = toLegacyUtxo(row)
        if (utxo) byOutpoint.set(utxo.outpoint, utxo)
      }
      if (rows.length < PAGE_LIMIT) break
      if (page === MAX_PAGES - 1) {
        console.info(
          `[${opts.logTag}] stopped at ${MAX_PAGES * PAGE_LIMIT} tip(s) — remainder next pass`,
        )
      }
    }
    opts.setCooldown(0)
  } catch (err) {
    opts.setCooldown(Date.now() + HOST_COOLDOWN_MS)
    console.warn(`[${opts.logTag}] ordinal index lookup failed`, err)
    // Partial pages are still real holdings — keep whatever answered.
  }

  return [...byOutpoint.values()]
}

/**
 * BSV-21 tips held on `address` (`bsv20=true` query).
 *
 * Never rejects: the token index is an enrichment on top of the funding scan.
 */
export async function scanAddressTokenTxos(
  address: string,
  chain: Chain,
): Promise<LegacyUtxo[]> {
  return scanAddressTxos(address, chain, {
    bsv20: true,
    logTag: 'token-scan',
    getCooldown: () => tokenCooldownUntil,
    setCooldown: (until) => {
      tokenCooldownUntil = until
    },
  })
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
  return scanAddressTxos(address, chain, {
    bsv20: false,
    logTag: 'ordinal-scan',
    getCooldown: () => ordinalCooldownUntil,
    setCooldown: (until) => {
      ordinalCooldownUntil = until
    },
  })
}
