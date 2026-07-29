import { P2PKH, PrivateKey } from '@bsv/sdk'
import { SetupClient, type Services } from '@bsv/wallet-toolbox-client'
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

/** Prefer Services, fall back to WhatsOnChain REST. */
export async function scanLegacyAddress(active?: ActiveWallet | null): Promise<LegacyScanResult> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')
  try {
    if (wallet.services) {
      return await scanAddressViaServices(wallet.services, wallet.address, wallet.chain)
    }
  } catch (err) {
    console.warn('[legacy-scan] services failed, trying WhatsOnChain', err)
  }
  return scanAddressViaWhatsOnChain(wallet.address, wallet.chain)
}

/**
 * Import scanned legacy P2PKH UTXOs into BRC-100 managed change.
 * Uses SetupClient.fundWalletFromP2PKHOutpoints (builds BEEF + sweeps).
 */
export async function importLegacyUtxos(
  outpoints: string[],
  active?: ActiveWallet | null,
): Promise<{ imported: number; failed: number; errors: string[] }> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')
  if (outpoints.length === 0) return { imported: 0, failed: 0, errors: [] }

  const p2pkhKey = SetupClient.getKeyPair(PrivateKey.fromHex(wallet.rootKeyHex))
  const results = await SetupClient.fundWalletFromP2PKHOutpoints(
    wallet.wallet,
    outpoints,
    p2pkhKey,
  )

  const errors: string[] = []
  let imported = 0
  let failed = 0
  for (const r of results) {
    if (r.success) imported += 1
    else {
      failed += 1
      if (r.error) errors.push(`${r.outpoint}: ${r.error}`)
    }
  }
  return { imported, failed, errors }
}
