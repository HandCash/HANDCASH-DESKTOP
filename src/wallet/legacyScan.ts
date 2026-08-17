import { P2PKH } from '@bsv/sdk'
import type { Services } from '@bsv/wallet-toolbox-client'
import { getActiveWallet, type ActiveWallet } from './session'
import type { Chain } from './vault'
import {
  beginLegacyImport,
  markLegacyImported,
  releaseLegacyImport,
} from './legacyImportGuard'
import { buildLegacyInputBeef } from './legacyBeef'
import { sweepVisibleP2pkhOutpoints } from './importP2pkhFunding'

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
  source: 'services' | 'whatsonchain' | 'bitails'
  error?: string
}

type WocUnspent = {
  height?: number
  tx_hash: string
  tx_pos: number
  value: number
}

type BitailsUnspent = {
  txid: string
  vout: number
  satoshis: number
  blockheight?: number
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

/**
 * A throttled provider can hold a socket open far longer than anyone is willing
 * to wait, and this scan sits between a tap on Collect and the grid. Give up and
 * let the caller fall through to the next host.
 */
const SCAN_TIMEOUT_MS = 7_000
/** Don't pay another 7s abort on every poll after a host just failed. */
const HOST_COOLDOWN_MS = 45_000
/**
 * How long the preferred host gets alone before the next one is started
 * alongside it. Running every host up front would answer faster, but it also
 * doubles the request volume on hosts that throttle us — which is what the
 * cooldowns above exist to survive. A stall is the only case worth paying for.
 */
const SCAN_HEDGE_MS = 1_200
let wocCooldownUntil = 0
let bitailsCooldownUntil = 0

/** Test-only — clear provider skip windows. */
export function resetLegacyScanCooldownForTests(): void {
  wocCooldownUntil = 0
  bitailsCooldownUntil = 0
}

async function fetchWithDeadline(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * True when the network has heard of `txid` (mempool or mined), null if unknown.
 *
 * Used before retrying a sweep: if our earlier funding transaction exists, an
 * address scan that still lists the input as unspent is stale, and sweeping
 * again would double-spend it. Silence from the provider is not evidence, so an
 * error answers null and the mark stands.
 *
 * Bitails + WhatsOnChain run in parallel — any definitive hit wins; a miss
 * only sticks when no provider affirmed presence.
 */
export async function txExistsOnChain(txid: string, chain: Chain): Promise<boolean | null> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return null

  const bitails = bitailsBase(chain)
  const bitailsCheck: Promise<boolean | null> = bitails
    ? (async () => {
        try {
          const res = await fetchWithDeadline(`${bitails}/tx/${id}/status`)
          if (res.status === 404) return false
          if (res.ok) return true
          return null
        } catch (err) {
          console.warn('[legacy-scan] Bitails tx lookup failed', err)
          return null
        }
      })()
    : Promise.resolve(null)

  const wocCheck: Promise<boolean | null> = (async () => {
    try {
      const res = await fetchWithDeadline(`${wocBase(chain)}/tx/hash/${id}`)
      if (res.status === 404) return false
      if (!res.ok) return null
      return true
    } catch (err) {
      console.warn('[legacy-scan] WhatsOnChain tx lookup failed', err)
      return null
    }
  })()

  const [b, w] = await Promise.all([bitailsCheck, wocCheck])
  if (b === true || w === true) return true
  if (b === false || w === false) return false
  return null
}

export type OutpointSpentStatus = 'spent' | 'unspent' | 'unknown'

/** `txid.vout` or `txid_vout` → parts, or null when the key is not an outpoint. */
export function parseOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const m = outpoint.trim().match(/^([0-9a-f]{64})[._](\d+)$/i)
  if (!m) return null
  const txid = m[1]
  const vout = m[2]
  if (!txid || vout === undefined) return null
  return { txid: txid.toLowerCase(), vout: Number(vout) }
}

/**
 * Bitails `/tx/{txid}/output/{n}/status`. `unknown` means spent *or* never
 * seen — that is not proof the coins moved, so the caller must fail closed.
 */
export function classifyBitailsUtxoStatus(body: {
  status?: unknown
  spent?: unknown
}): OutpointSpentStatus {
  const status = String(body.status ?? '').toLowerCase()
  if (status === 'unknown' || status === 'not found') return 'unknown'
  if (body.spent === true) return 'spent'
  if (body.spent === false) return 'unspent'
  return 'unknown'
}

/**
 * Whether `outpoint` is spent on chain (mempool or mined).
 *
 * Spent is only returned from a positive indexer answer. Everything else —
 * including Bitails `unknown` and provider silence — is not proof, so it is
 * `unspent` (404 on a known host) or `unknown` (fail closed).
 */
export async function spentStatusOfOutpoint(
  outpoint: string,
  chain: Chain,
): Promise<OutpointSpentStatus> {
  const parsed = parseOutpoint(outpoint)
  if (!parsed) return 'unknown'

  let bitailsUnknown = false
  const bitails = bitailsBase(chain)
  if (bitails) {
    try {
      const res = await fetchWithDeadline(
        `${bitails}/tx/${parsed.txid}/output/${parsed.vout}/status`,
      )
      if (res.ok) {
        const body = (await res.json()) as { status?: unknown; spent?: unknown }
        const classified = classifyBitailsUtxoStatus(body)
        if (classified !== 'unknown') return classified
        bitailsUnknown = true
      }
    } catch (err) {
      console.warn('[legacy-scan] Bitails utxo status failed', err)
    }
  }

  try {
    const res = await fetchWithDeadline(
      `${wocBase(chain)}/tx/${parsed.txid}/${parsed.vout}/spent`,
    )
    if (res.status === 404) return bitailsUnknown ? 'unknown' : 'unspent'
    if (!res.ok) return 'unknown'
    const body = (await res.json()) as { txid?: unknown }
    const spendTxid = String(body.txid ?? '').toLowerCase()
    if (/^[0-9a-f]{64}$/.test(spendTxid)) return 'spent'
    return 'unknown'
  } catch (err) {
    console.warn('[legacy-scan] WhatsOnChain spent lookup failed', err)
    return 'unknown'
  }
}

/** Scan a legacy P2PKH address for UTXOs via Bitails (SPV-forward primary). */
export async function scanAddressViaBitails(
  address: string,
  chain: Chain,
): Promise<LegacyScanResult> {
  const base = bitailsBase(chain)
  if (!base) throw new Error(`Bitails has no endpoint for chain ${chain}`)
  const url = `${base}/address/${encodeURIComponent(address)}/unspent`
  const res = await fetchWithDeadline(url)
  if (!res.ok) {
    throw new Error(`Bitails ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { unspent?: BitailsUnspent[] }
  const rows = body.unspent ?? []
  const utxos: LegacyUtxo[] = rows.map((r) => ({
    outpoint: `${r.txid}.${r.vout}`,
    txid: r.txid,
    vout: r.vout,
    satoshis: r.satoshis,
    height: r.blockheight,
  }))
  const sats = utxos.reduce((s, u) => s + u.satoshis, 0)
  return { address, chain, sats, utxos, source: 'bitails' }
}

/** Scan a legacy P2PKH address for UTXOs via WhatsOnChain REST. */
export async function scanAddressViaWhatsOnChain(
  address: string,
  chain: Chain,
): Promise<LegacyScanResult> {
  const url = `${wocBase(chain)}/address/${encodeURIComponent(address)}/unspent`
  const res = await fetchWithDeadline(url)
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

/**
 * First success wins, with hosts started `staggerMs` apart.
 *
 * The old shape was strictly serial, so a host that accepted the socket and went
 * quiet cost its full deadline before the next one was even asked. A host that
 * fails outright promotes its successor immediately; a host that is merely slow
 * keeps running while the next one starts beside it.
 */
async function firstSuccessStaggered<T>(
  starters: ReadonlyArray<() => Promise<T>>,
  staggerMs: number,
): Promise<T> {
  if (starters.length === 0) throw new Error('No UTXO scan provider available')
  if (starters.length === 1) return starters[0]!()

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let launched = 0
    let failures = 0
    let lastError: unknown
    const timers: Array<ReturnType<typeof setTimeout>> = []

    const settle = (apply: () => void): void => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      apply()
    }

    const launchNext = (): void => {
      if (settled || launched >= starters.length) return
      const starter = starters[launched++]!
      const isLast = launched >= starters.length
      if (!isLast) timers.push(setTimeout(launchNext, staggerMs))

      starter().then(
        (value) => settle(() => resolve(value)),
        (err) => {
          lastError = err
          failures += 1
          if (failures >= starters.length) {
            settle(() => reject(lastError))
            return
          }
          // Don't wait out the stagger behind a host that already gave up.
          launchNext()
        },
      )
    }

    launchNext()
  })
}

/** WhatsOnChain occasionally omits sat amounts; borrow them from services. */
async function enrichZeroSatRows(
  woc: LegacyScanResult,
  wallet: ActiveWallet,
): Promise<LegacyScanResult> {
  if (!woc.utxos.some((u) => !(u.satoshis > 0)) || !wallet.services) return woc
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
    return woc
  }
}

/**
 * Prefer Bitails (independent budget); WhatsOnChain then toolbox Services.
 *
 * Hosts are staggered rather than raced outright: the common case stays a single
 * request, and only a stalled host costs a second one.
 */
export async function scanLegacyAddress(active?: ActiveWallet | null): Promise<LegacyScanResult> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  const now = Date.now()
  const starters: Array<() => Promise<LegacyScanResult>> = []

  if (bitailsBase(wallet.chain)) {
    if (now >= bitailsCooldownUntil) {
      starters.push(async () => {
        try {
          const result = await scanAddressViaBitails(wallet.address, wallet.chain)
          bitailsCooldownUntil = 0
          return result
        } catch (err) {
          bitailsCooldownUntil = Date.now() + HOST_COOLDOWN_MS
          console.warn('[legacy-scan] Bitails failed', err)
          throw err
        }
      })
    } else {
      console.info('[legacy-scan] skipping Bitails (recently failed)')
    }
  }

  if (now >= wocCooldownUntil) {
    starters.push(async () => {
      try {
        const woc = await scanAddressViaWhatsOnChain(wallet.address, wallet.chain)
        wocCooldownUntil = 0
        return await enrichZeroSatRows(woc, wallet)
      } catch (err) {
        wocCooldownUntil = Date.now() + HOST_COOLDOWN_MS
        console.warn('[legacy-scan] WhatsOnChain failed', err)
        throw err
      }
    })
  } else {
    console.info('[legacy-scan] skipping WhatsOnChain (recently failed)')
  }

  const services = wallet.services
  if (services) {
    starters.push(async () => {
      const viaServices = await scanAddressViaServices(
        services,
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
    })
  }

  return firstSuccessStaggered(starters, SCAN_HEDGE_MS)
}

/**
 * Import scanned legacy P2PKH UTXOs into BRC-100 managed change.
 * Sweep scanned legacy P2PKH UTXOs into BRC-100 managed change.
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
  const safe = utxos.filter((u) => u.satoshis > 1)
  const byOutpoint = new Map(safe.map((u) => [u.outpoint.trim().toLowerCase(), u]))
  if (skippedOneSats > 0) {
    console.warn(
      `[legacy] refused to sweep ${skippedOneSats} one-sat outpoint(s) — possible ordinals`,
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
    // Supply the deposit bodies rather than letting the toolbox walk merkle
    // ancestry. Visible-on-chain (unconfirmed included) is enough for cash.
    // The sweep is not a receive until ARC accepts it.
    const built = await buildLegacyInputBeef(wallet.services, outpoints)
    const results =
      built.ready.length > 0
        ? await sweepVisibleP2pkhOutpoints(wallet, built.ready, built.beef)
        : []
    // Unreadable outpoints are reported as ordinary failures so they fall
    // through to `releaseLegacyImport` below and are retried on the next scan.
    results.push(
      ...built.failures.map((f) => ({
        outpoint: f.outpoint,
        success: false,
        error: `could not load outpoint: ${f.reason}`,
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
