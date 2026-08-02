import { P2PKH, PrivateKey } from '@bsv/sdk'
import { SetupClient, type Services } from '@bsv/wallet-toolbox-client'
import {
  hasActivityTxid,
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import {
  claimLegacyOutpoints,
  markLegacyOutpointImported,
  releaseLegacyOutpointClaim,
  wasLegacyOutpointImported,
} from './legacyImportGuard'
import { getActiveWallet, type ActiveWallet } from './session'
import type { Chain } from './vault'

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

function dedupeUtxos(utxos: LegacyUtxo[]): LegacyUtxo[] {
  const seen = new Set<string>()
  const out: LegacyUtxo[] = []
  for (const u of utxos) {
    if (seen.has(u.outpoint)) continue
    seen.add(u.outpoint)
    out.push(u)
  }
  return out
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
  const utxos = dedupeUtxos(
    (rows ?? []).map((r) => ({
      outpoint: `${r.tx_hash}.${r.tx_pos}`,
      txid: r.tx_hash,
      vout: r.tx_pos,
      satoshis: r.value,
      height: r.height,
    })),
  )
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
  const utxos = dedupeUtxos(
    (status.details ?? [])
      .filter((d) => d.txid != null && d.index != null)
      .map((d) => ({
        outpoint: `${d.txid}.${d.index}`,
        txid: d.txid!,
        vout: d.index!,
        satoshis: d.satoshis ?? 0,
        height: d.height,
      })),
  )
  const sats = utxos.reduce((s, u) => s + u.satoshis, 0)
  return { address, chain, sats, utxos, source: 'services' }
}

/** Prefer Services; always fall back to WhatsOnChain when Services is empty/fails. */
export async function scanLegacyAddress(active?: ActiveWallet | null): Promise<LegacyScanResult> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  let servicesResult: LegacyScanResult | null = null
  try {
    if (wallet.services) {
      servicesResult = await scanAddressViaServices(
        wallet.services,
        wallet.address,
        wallet.chain,
      )
      if (servicesResult.utxos.length > 0) return servicesResult
      console.info('[legacy-scan] services returned 0 UTXOs — trying WhatsOnChain')
    }
  } catch (err) {
    console.warn('[legacy-scan] services failed, trying WhatsOnChain', err)
  }

  try {
    const woc = await scanAddressViaWhatsOnChain(wallet.address, wallet.chain)
    if (woc.utxos.length > 0 || !servicesResult) return woc
  } catch (err) {
    if (!servicesResult) throw err
    console.warn('[legacy-scan] WhatsOnChain failed; using empty services result', err)
  }
  return servicesResult ?? {
    address: wallet.address,
    chain: wallet.chain,
    sats: 0,
    utxos: [],
    source: 'whatsonchain',
  }
}

export type ImportLegacyResult = {
  imported: number
  failed: number
  errors: string[]
  skippedOneSats: number
  skippedAlreadyImported: number
  importedOutpoints: string[]
}

/**
 * Import scanned legacy P2PKH UTXOs into BRC-100 managed change.
 * Uses SetupClient.fundWalletFromP2PKHOutpoints (builds BEEF + sweeps).
 *
 * HARD RULE: refuses satoshis === 1 (possible ordinals). Pass only funding UTXOs.
 * Each outpoint is claimed once so index lag cannot 2–3× a single payment.
 */
export async function importLegacyUtxos(
  utxos: LegacyUtxo[],
  active?: ActiveWallet | null,
): Promise<ImportLegacyResult> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  const skippedOneSats = utxos.filter((u) => u.satoshis === 1).length
  const safe = dedupeUtxos(utxos.filter((u) => u.satoshis > 1))
  if (skippedOneSats > 0) {
    console.warn(
      `[legacy] refused to sweep ${skippedOneSats} one-sat outpoint(s) — possible ordinals`,
    )
  }

  const skippedAlreadyImported = safe.filter((u) =>
    wasLegacyOutpointImported(u.outpoint),
  ).length
  const candidates = safe.filter((u) => !wasLegacyOutpointImported(u.outpoint))
  const claimed = claimLegacyOutpoints(candidates.map((u) => u.outpoint))
  const toImport = candidates.filter((u) => claimed.includes(u.outpoint))

  if (toImport.length === 0) {
    return {
      imported: 0,
      failed: 0,
      errors: [],
      skippedOneSats,
      skippedAlreadyImported,
      importedOutpoints: [],
    }
  }

  const outpoints = toImport.map((u) => u.outpoint)
  const p2pkhKey = SetupClient.getKeyPair(PrivateKey.fromHex(wallet.rootKeyHex))

  let results: Array<{ outpoint: string; success: boolean; error?: string }>
  try {
    results = await SetupClient.fundWalletFromP2PKHOutpoints(
      wallet.wallet,
      outpoints,
      p2pkhKey,
    )
  } catch (err) {
    for (const op of claimed) releaseLegacyOutpointClaim(op)
    throw err
  }

  const errors: string[] = []
  let imported = 0
  let failed = 0
  const importedOutpoints: string[] = []
  const resultByOp = new Map(results.map((r) => [r.outpoint, r]))

  const satByOp = new Map(toImport.map((u) => [u.outpoint, u.satoshis]))

  for (const op of claimed) {
    const r = resultByOp.get(op)
    if (r?.success) {
      imported += 1
      importedOutpoints.push(op)
      markLegacyOutpointImported(op)
      const sats = satByOp.get(op) ?? 0
      const txid = op.includes('.') ? op.slice(0, op.lastIndexOf('.')) : op
      if (sats > 0 && !hasActivityTxid(txid)) {
        recordAppActivity({
          origin: WALLET_ACTIVITY_ORIGIN,
          kind: 'earned',
          sats,
          method: 'legacy-import',
          note: 'Received (legacy address)',
          txid,
        })
      }
    } else {
      failed += 1
      releaseLegacyOutpointClaim(op)
      if (r?.error) errors.push(`${op}: ${r.error}`)
      else errors.push(`${op}: import failed`)
    }
  }

  return {
    imported,
    failed,
    errors,
    skippedOneSats,
    skippedAlreadyImported,
    importedOutpoints,
  }
}
