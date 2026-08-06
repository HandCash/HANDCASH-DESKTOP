import { P2PKH, PrivateKey } from '@bsv/sdk'
import { SetupClient, type Services } from '@bsv/wallet-toolbox-client'
import { getActiveWallet, type ActiveWallet } from './session'
import type { Chain } from './vault'
import {
  beginLegacyImport,
  markLegacyImported,
  releaseLegacyImport,
} from './legacyImportGuard'
import { isLatchDustSats } from './oneSatLatch'
import { buildLegacyInputBeef } from './legacyBeef'

export type LegacyUtxo = {
  outpoint: string
  txid: string
  vout: number
  satoshis: number
  height?: number
}

export type LegacyScanResult = {
  address: string
  chain: Chain
  sats: number
  utxos: LegacyUtxo[]
  source: 'services' | 'whatsonchain'
  error?: string
}

type WocUnspent = {
  height?: number
  tx_hash: string
  tx_pos: number
  value: number
}

function wocBase(chain: Chain): string {
  return chain === 'main'
    ? 'https://api.whatsonchain.com/v1/bsv/main'
    : 'https://api.whatsonchain.com/v1/bsv/test'
}

/**
 * True when the network has heard of `txid` (mempool or mined), null if unknown.
 *
 * Used before retrying a sweep: if our earlier funding transaction exists, an
 * address scan that still lists the input as unspent is stale, and sweeping
 * again would double-spend it. Silence from the provider is not evidence, so an
 * error answers null and the mark stands.
 */
export async function txExistsOnChain(txid: string, chain: Chain): Promise<boolean | null> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return null
  try {
    const res = await fetch(`${wocBase(chain)}/tx/hash/${id}`)
    if (res.status === 404) return false
    if (!res.ok) return null
    return true
  } catch (err) {
    console.warn('[legacy-scan] tx lookup failed', err)
    return null
  }
}

/** Scan a legacy P2PKH address for UTXOs via WhatsOnChain REST. */
export async function scanAddressViaWhatsOnChain(
  address: string,
  chain: Chain,
): Promise<LegacyScanResult> {
  const url = `${wocBase(chain)}/address/${encodeURIComponent(address)}/unspent`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`WhatsOnChain ${res.status}: ${await res.text()}`)
  }
  const rows = (await res.json()) as WocUnspent[]
  const utxos: LegacyUtxo[] = (rows ?? []).map((r) => ({
    outpoint: `${r.tx_hash}.${r.tx_pos}`,
    txid: r.tx_hash,
    vout: r.tx_pos,
    satoshis: r.value,
    height: r.height,
  }))
  const sats = utxos.reduce((s, u) => s + u.satoshis, 0)
  return { address, chain, sats, utxos, source: 'whatsonchain' }
}

/** Scan via toolbox Services.getUtxoStatus on the address locking script. */
export async function scanAddressViaServices(
  services: Services,
  address: string,
  chain: Chain,
): Promise<LegacyScanResult> {
  const lockingScript = new P2PKH().lock(address).toHex()
  const status = await services.getUtxoStatus(lockingScript, 'script')
  if (status.status === 'error') {
    throw new Error(status.error?.message ?? 'getUtxoStatus failed')
  }
  const utxos: LegacyUtxo[] = (status.details ?? [])
    .filter((d) => d.txid != null && d.index != null)
    .map((d) => ({
      outpoint: `${d.txid}.${d.index}`,
      txid: d.txid!,
      vout: d.index!,
      satoshis: d.satoshis ?? 0,
      height: d.height,
    }))
  const sats = utxos.reduce((s, u) => s + u.satoshis, 0)
  return { address, chain, sats, utxos, source: 'services' }
}

/** Prefer WhatsOnChain (has sat amounts); fall back to toolbox Services. */
export async function scanLegacyAddress(active?: ActiveWallet | null): Promise<LegacyScanResult> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  let wocError: unknown
  try {
    const woc = await scanAddressViaWhatsOnChain(wallet.address, wallet.chain)
    // Enrich zero-sat rows from services if WoC omitted values (rare).
    if (woc.utxos.some((u) => !(u.satoshis > 0)) && wallet.services) {
      try {
        const viaServices = await scanAddressViaServices(
          wallet.services,
          wallet.address,
          wallet.chain,
        )
        const byOp = new Map(viaServices.utxos.map((u) => [u.outpoint.toLowerCase(), u]))
        const merged = woc.utxos.map((u) => {
          if (u.satoshis > 0) return u
          const alt = byOp.get(u.outpoint.toLowerCase())
          return alt && alt.satoshis > 0 ? { ...u, satoshis: alt.satoshis } : u
        })
        const sats = merged.reduce((s, u) => s + u.satoshis, 0)
        return { ...woc, utxos: merged, sats }
      } catch {
        /* keep WoC */
      }
    }
    return woc
  } catch (err) {
    wocError = err
    console.warn('[legacy-scan] WhatsOnChain failed, trying services', err)
  }

  try {
    if (wallet.services) {
      const viaServices = await scanAddressViaServices(
        wallet.services,
        wallet.address,
        wallet.chain,
      )
      // Services sometimes omit satoshis (0) — those cannot be classified as funding.
      if (viaServices.utxos.length > 0 && viaServices.utxos.every((u) => !(u.satoshis > 0))) {
        console.warn(
          '[legacy-scan] services returned UTXOs without sat amounts — cannot import funding',
        )
      }
      return viaServices
    }
  } catch (err) {
    console.warn('[legacy-scan] services failed', err)
    if (wocError) throw wocError
    throw err
  }

  if (wocError) throw wocError
  throw new Error('No UTXO scan provider available')
}

/**
 * Import scanned legacy P2PKH UTXOs into BRC-100 managed change.
 * Uses SetupClient.fundWalletFromP2PKHOutpoints (builds BEEF + sweeps).
 *
 * HARD RULES:
 * - refuses satoshis === 1 (possible ordinals)
 * - same outpoint is never swept twice (durable + in-flight guards)
 */
/** A legacy UTXO successfully swept into managed change — drives receive activity. */
export type LegacyFundingReceipt = {
  outpoint: string
  satoshis: number
  /** Incoming payment txid (source of the UTXO). */
  receiveTxid: string
  /** Sweep that internalized the funds, when the toolbox reported one. */
  sweepTxid?: string
}

export async function importLegacyUtxos(
  utxos: LegacyUtxo[],
  active?: ActiveWallet | null,
): Promise<{
  imported: number
  failed: number
  errors: string[]
  skippedOneSats: number
  skippedKnown: number
  importedOutpoints: string[]
  importedReceipts: LegacyFundingReceipt[]
}> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  const skippedOneSats = utxos.filter((u) => u.satoshis === 1).length
  const skippedLatchDust = utxos.filter((u) => isLatchDustSats(u.satoshis)).length
  const safe = utxos.filter((u) => u.satoshis > 1 && !isLatchDustSats(u.satoshis))
  const byOutpoint = new Map(safe.map((u) => [u.outpoint.trim().toLowerCase(), u]))
  if (skippedOneSats > 0) {
    console.warn(
      `[legacy] refused to sweep ${skippedOneSats} one-sat outpoint(s) — possible ordinals`,
    )
  }
  if (skippedLatchDust > 0) {
    console.warn(
      `[legacy] refused to sweep ${skippedLatchDust} soft-latch dust outpoint(s)`,
    )
  }
  if (safe.length === 0) {
    return {
      imported: 0,
      failed: 0,
      errors: [],
      skippedOneSats,
      skippedKnown: 0,
      importedOutpoints: [],
      importedReceipts: [],
    }
  }

  const candidates = safe.map((u) => u.outpoint)
  const outpoints = beginLegacyImport(candidates)
  const skippedKnown = candidates.length - outpoints.length
  if (skippedKnown > 0) {
    console.info(`[legacy] skipped ${skippedKnown} already-imported or in-flight outpoint(s)`)
  }
  if (outpoints.length === 0) {
    return {
      imported: 0,
      failed: 0,
      errors: [],
      skippedOneSats,
      skippedKnown,
      importedOutpoints: [],
      importedReceipts: [],
    }
  }

  try {
    const p2pkhKey = SetupClient.getKeyPair(PrivateKey.fromHex(wallet.rootKeyHex))
    // Supply the BEEF rather than letting the toolbox build it. Its builder
    // throws the first time any ancestor lookup fails and the throw is outside
    // the per-outpoint try, so one unlucky deposit discards the whole scan.
    // See `legacyBeef.ts`.
    const built = await buildLegacyInputBeef(wallet.services, outpoints)
    const results =
      built.ready.length > 0
        ? await SetupClient.fundWalletFromP2PKHOutpoints(
            wallet.wallet,
            built.ready,
            p2pkhKey,
            built.beef,
          )
        : []
    // Unprovable outpoints are reported as ordinary failures so they fall
    // through to `releaseLegacyImport` below and are retried on the next scan.
    results.push(
      ...built.failures.map((f) => ({
        outpoint: f.outpoint,
        success: false,
        error: `could not prove outpoint: ${f.reason}`,
      })),
    )

    const errors: string[] = []
    const succeeded: Array<{ outpoint: string; txid?: string }> = []
    const importedReceipts: LegacyFundingReceipt[] = []
    let imported = 0
    let failed = 0
    for (const r of results) {
      const op = String(r.outpoint || '').trim().toLowerCase()
      if (r.success) {
        imported += 1
        // Keep the sweep txid: a retry has to prove this transaction never landed.
        if (op) {
          succeeded.push({ outpoint: op, txid: r.txid })
          const source = byOutpoint.get(op)
          if (source && source.satoshis > 0) {
            importedReceipts.push({
              outpoint: op,
              satoshis: source.satoshis,
              receiveTxid: source.txid.trim().toLowerCase(),
              ...(r.txid?.trim() ? { sweepTxid: r.txid.trim().toLowerCase() } : {}),
            })
          }
        }
      } else {
        failed += 1
        if (r.error) errors.push(`${r.outpoint}: ${r.error}`)
        // Only permanently skip on clear “already ours / already spent” — never on
        // transient “not found” / indexer lag (that blacklisted live deposits).
        const err = (r.error || '').toLowerCase()
        if (
          op &&
          (/already (?:spent|imported|internalized|in (?:the )?wallet|ours)/i.test(err) ||
            /double.?spend/i.test(err) ||
            /output (?:is )?not spendable/i.test(err))
        ) {
          // Mark known — not a fresh receive, so leave importedReceipts alone.
          succeeded.push({ outpoint: op, txid: r.txid })
        }
      }
    }
    markLegacyImported(succeeded)
    const importedOutpoints = importedReceipts.map((r) => r.outpoint)
    const succeededSet = new Set(succeeded.map((s) => s.outpoint))
    releaseLegacyImport(outpoints.filter((op) => !succeededSet.has(op)))
    return {
      imported,
      failed,
      errors,
      skippedOneSats,
      skippedKnown,
      importedOutpoints,
      importedReceipts,
    }
  } catch (err) {
    releaseLegacyImport(outpoints)
    throw err
  }
}
