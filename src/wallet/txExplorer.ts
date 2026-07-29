import type { Chain } from './vault'

/** True for on-chain txids we can open in an explorer (not local stubs). */
export function isExplorerTxid(txid: string | undefined | null): txid is string {
  if (!txid) return false
  if (txid.startsWith('local-')) return false
  return /^[0-9a-fA-F]{64}$/.test(txid)
}

export function txExplorerUrl(txid: string, chain: Chain = 'main'): string {
  const host = chain === 'main' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com'
  return `${host}/tx/${txid}`
}

export function extractTxid(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const body = result as { txid?: unknown; txids?: unknown }
  if (typeof body.txid === 'string' && body.txid.trim()) return body.txid.trim()
  if (Array.isArray(body.txids)) {
    const first = body.txids.find((t): t is string => typeof t === 'string' && t.trim().length > 0)
    if (first) return first.trim()
  }
  return undefined
}
