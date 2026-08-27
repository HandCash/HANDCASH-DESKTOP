/**
 * Recovery-only: discover legacy BSV-21 tips on the wallet receive address.
 *
 * Colour coins do **not** use this path — custody is tip→origin remittance /
 * peer settle (`colour` basket), not an indexer. Keep this scan for healing
 * older BSV-21 tips that never entered `bsv21` via remittance.
 *
 * A BSV-21 transfer re-inscribes token JSON (P2PKH + ord). Address indexers
 * often miss that shape; the ordinal index with `bsv20=true` is the recovery
 * probe. HARD RULE: only 1-satoshi outputs — never spend real funds from an
 * indexer hint.
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
 * Ceiling on pages per pass. A wallet holding more token tips than this still
 * heals: the unseen rows are picked up once the imported ones stop being
 * returned as unspent.
 */
const MAX_PAGES = 10
const REQUEST_TIMEOUT_MS = 8_000
/** Don't pay the timeout again on every poll after the indexer just failed. */
const HOST_COOLDOWN_MS = 45_000

let cooldownUntil = 0

/** Test-only — clear the indexer skip window. */
export function resetTokenAddressScanCooldownForTests(): void {
  cooldownUntil = 0
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

async function fetchTokenPage(
  address: string,
  chain: Chain,
  offset: number,
): Promise<TokenTxoRow[]> {
  const url =
    `${ordinalsBase(chain)}/api/txos/address/${encodeURIComponent(address)}/unspent` +
    `?limit=${PAGE_LIMIT}&offset=${offset}&bsv20=true`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`ordinals index ${res.status}`)
  const body = (await res.json()) as unknown
  return Array.isArray(body) ? (body as TokenTxoRow[]) : []
}

/**
 * BSV-21 tips held on `address`, as address-scan rows.
 *
 * Never rejects: the token index is an enrichment on top of the funding scan, so
 * an outage must degrade to "no tokens found this pass" rather than fail a
 * Refresh that would otherwise import funding.
 */
export async function scanAddressTokenTxos(
  address: string,
  chain: Chain,
): Promise<LegacyUtxo[]> {
  // Total by contract: the caller folds this into a scan it must not lose, so
  // a bad argument degrades like an outage rather than rejecting the Refresh.
  if (typeof address !== 'string' || !address.trim()) return []
  if (Date.now() < cooldownUntil) {
    console.info('[token-scan] skipping ordinal index (recently failed)')
    return []
  }

  const byOutpoint = new Map<string, LegacyUtxo>()
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchTokenPage(address, chain, page * PAGE_LIMIT)
      for (const row of rows) {
        const utxo = toLegacyUtxo(row)
        if (utxo) byOutpoint.set(utxo.outpoint, utxo)
      }
      if (rows.length < PAGE_LIMIT) break
      if (page === MAX_PAGES - 1) {
        console.info(
          `[token-scan] stopped at ${MAX_PAGES * PAGE_LIMIT} token tip(s) — remainder next pass`,
        )
      }
    }
    cooldownUntil = 0
  } catch (err) {
    cooldownUntil = Date.now() + HOST_COOLDOWN_MS
    console.warn('[token-scan] ordinal index lookup failed', err)
    // Partial pages are still real holdings — keep whatever answered.
  }

  return [...byOutpoint.values()]
}
