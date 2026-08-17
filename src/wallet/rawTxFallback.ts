/**
 * Extra providers for raw transaction lookups.
 *
 * The toolbox registers WhatsOnChain as the sole `getRawTx` service by default.
 * Bringing a collectable in builds a BEEF over the tip and its unproven ancestry,
 * and each hop is a `getRawTx`. Putting Bitails / JungleBus first keeps SPV
 * imports off WhatsOnChain's shared rate budget — a throttled WoC reply carries
 * no CORS headers, so the browser reports `TypeError: Failed to fetch` and the
 * wallet surfaces the misleading "txid must be valid on chain main".
 *
 * The toolbox hashes every returned body and rejects one that isn't the
 * transaction it asked for, so a bad host can cost a round trip but cannot
 * corrupt a BEEF.
 */
import { Utils } from '@bsv/sdk'
import type { Services } from '@bsv/wallet-toolbox-client'

import { appendAppLog } from './appLog'
import { preferServiceOrder } from './serviceOrder'
import type { Chain } from './vault'

const REQUEST_TIMEOUT_MS = 8_000

/** What `Services.getRawTx` expects back from a registered provider. */
type RawTxResult = { name: string; txid: string; rawTx?: number[] }

type RawTxSource = {
  name: string
  fetch: (txid: string) => Promise<number[] | null>
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: accept } })
    return res.ok ? res : null
  } catch {
    // A blocked host and a slow one look the same from here, and both mean
    // "ask someone else" — never "this transaction does not exist".
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchHexTx(url: string): Promise<number[] | null> {
  const res = await fetchWithTimeout(url, 'text/plain')
  if (res == null) return null
  const hex = (await res.text()).trim()
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null
  return Utils.toArray(hex, 'hex')
}

async function fetchJungleBusTx(url: string): Promise<number[] | null> {
  const res = await fetchWithTimeout(url, 'application/json')
  if (res == null) return null
  const body: unknown = await res.json().catch(() => null)
  const base64 = (body as { transaction?: unknown } | null)?.transaction
  if (typeof base64 !== 'string' || base64 === '') return null
  return Utils.toArray(base64, 'base64')
}

function sourcesFor(chain: Chain): RawTxSource[] {
  if (chain === 'main') {
    return [
      {
        name: 'BitailsRawTx',
        fetch: (txid) => fetchHexTx(`https://api.bitails.io/download/tx/${txid}/hex`),
      },
      {
        name: 'JungleBusRawTx',
        fetch: (txid) =>
          fetchJungleBusTx(`https://junglebus.gorillapool.io/v1/transaction/get/${txid}`),
      },
      {
        name: 'WhatsOnChainRawTxHex',
        fetch: (txid) =>
          fetchHexTx(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`),
      },
    ]
  }
  if (chain === 'test') {
    return [
      {
        name: 'BitailsRawTx',
        fetch: (txid) => fetchHexTx(`https://test-api.bitails.io/download/tx/${txid}/hex`),
      },
    ]
  }
  return []
}

/** Minimal view of the toolbox's `ServiceCollection`. */
type Collection = {
  services?: Array<{ name: string }>
  add?: (entry: { name: string; service: (txid: string) => Promise<RawTxResult> }) => unknown
  reset?: () => void
}

let loggedFallback = false

/**
 * Give `Services.getRawTx` SPV-friendly hosts ahead of WhatsOnChain.
 *
 * Toolbox defaults to WhatsOnChain alone. We register Bitails + JungleBus and
 * then put them first so BEEF ancestry does not burn the shared WoC budget on
 * every hop. Bodies are still hashed to the requested txid by the toolbox.
 */
export function installRawTxFallback(services: Services, chain: Chain): void {
  try {
    const collection = (services as unknown as { getRawTxServices?: Collection })
      .getRawTxServices
    if (typeof collection?.add !== 'function') return

    const registered = new Set((collection.services ?? []).map((s) => s.name))
    const extras = sourcesFor(chain)
    for (const source of extras) {
      if (registered.has(source.name)) continue
      collection.add({
        name: source.name,
        service: async (txid: string): Promise<RawTxResult> => {
          const rawTx = await source.fetch(txid)
          // No bytes is reported as "this provider has nothing", which rotates
          // to the next one; only an empty collection is a hard failure.
          if (rawTx == null || rawTx.length === 0) return { name: source.name, txid }
          if (!loggedFallback) {
            loggedFallback = true
            appendAppLog(
              'info',
              `[rawtx] serving transactions from ${source.name} (SPV-forward; WhatsOnChain not required)`,
            )
          }
          return { name: source.name, txid, rawTx }
        },
      })
    }

    // Prefer our SPV hosts, then the hex WoC endpoint we registered, then the
    // toolbox's default WhatsOnChain provider (binary).
    preferServiceOrder(
      collection,
      extras.map((s) => s.name).concat(['WhatsOnChain']),
    )
  } catch (err) {
    console.warn('[rawtx] could not install raw transaction failover', err)
  }
}
