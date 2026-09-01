import type { Chain } from './vault'
import { DEFAULT_BRC_CLOUD_BASE_URL } from './walletConfig'

const PROBE_TIMEOUT_MS = 7_000

function cloudBase(): string {
  const configured = DEFAULT_BRC_CLOUD_BASE_URL.replace(/\/+$/, '')
  if (configured) return configured
  if (typeof window !== 'undefined') return window.location.origin
  return 'https://brc-cloud.bcryderman.workers.dev'
}

async function fetchCloudJson<T>(path: string, chain: Chain): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const chainParam = chain === 'main' ? 'main' : 'test'
    const res = await fetch(`${cloudBase()}${path}?chain=${chainParam}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** HandCash Chain proxy — Bitails → WhatsOnChain rotation on BRC-CLOUD. */
export async function cloudTxExists(
  txid: string,
  chain: Chain,
): Promise<boolean | null> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return null
  const body = await fetchCloudJson<{ exists?: unknown }>(
    `/v1/chain/tx/${id}/exists`,
    chain,
  )
  if (!body || body.exists == null) return null
  return body.exists === true
}

export async function cloudSpentStatus(
  txid: string,
  vout: number,
  chain: Chain,
): Promise<'spent' | 'unspent' | 'unknown' | null> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id) || !Number.isInteger(vout) || vout < 0) {
    return null
  }
  const body = await fetchCloudJson<{ status?: unknown }>(
    `/v1/chain/spent/${id}/${vout}`,
    chain,
  )
  const status = String(body?.status ?? '').toLowerCase()
  if (status === 'spent' || status === 'unspent' || status === 'unknown') {
    return status
  }
  return null
}

export type CloudUnspentUtxo = {
  outpoint: string
  txid: string
  vout: number
  satoshis: number
  height?: number
}

export async function cloudAddressUnspent(
  address: string,
  chain: Chain,
): Promise<{ utxos: CloudUnspentUtxo[]; sats: number } | null> {
  const trimmed = address.trim()
  if (!trimmed) return null
  const body = await fetchCloudJson<{
    utxos?: CloudUnspentUtxo[]
    sats?: number
  }>(`/v1/chain/address/${encodeURIComponent(trimmed)}/unspent`, chain)
  if (!body || !Array.isArray(body.utxos)) return null
  return {
    utxos: body.utxos,
    sats: typeof body.sats === 'number' ? body.sats : body.utxos.reduce((s, u) => s + u.satoshis, 0),
  }
}
