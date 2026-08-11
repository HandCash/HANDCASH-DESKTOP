/**
 * Resolve BSV-21 ticker icon bytes without HTTP content indexers.
 * Prefer durable cache → local/session BEEF → (optional) wallet services BEEF.
 */
import type { ActiveWallet } from './session'
import { normalizeTokenId } from './bsv21'
import { getBeefForTxidCached, rememberBeef } from './beefCache'
import { parseOrdEnvelope } from './ordinalOwnership'
import { getTokenIconDataUrl, rememberTokenIcon } from './tokenIconCache'

function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const id = normalizeTokenId(outpoint) ?? outpoint.trim().toLowerCase().replace('.', '_')
  const m = /^([0-9a-f]{64})_(\d+)$/i.exec(id)
  if (!m) return null
  return { txid: m[1]!.toLowerCase(), vout: Number(m[2]) }
}

function isImageMime(mime: string | undefined): boolean {
  const m = (mime ?? '').toLowerCase().split(';')[0]!.trim()
  return m.startsWith('image/') || m === 'image/svg+xml'
}

/** Decode icon inscription from a BEEF that already contains the icon tx. */
export function cacheTokenIconFromBeef(
  outpoint: string,
  beef: { findTxid?: (txid: string) => { tx?: { outputs?: Array<{ lockingScript?: { toHex?: () => string } }> } } | undefined },
): string | undefined {
  const parts = splitOutpoint(outpoint)
  if (!parts) return undefined
  const tx = beef.findTxid?.(parts.txid)?.tx
  const scriptHex = tx?.outputs?.[parts.vout]?.lockingScript?.toHex?.()
  const env = parseOrdEnvelope(scriptHex)
  if (!env || !isImageMime(env.contentType)) return undefined
  rememberTokenIcon(outpoint, env.body, env.contentType || 'image/png')
  return getTokenIconDataUrl(outpoint)
}

/**
 * Data URL for UI. Never builds Gorilla/content HTTP URLs.
 * Returns undefined → caller shows hash identicon.
 */
export async function resolveTokenIconDataUrl(
  iconOutpoint: string | undefined,
  wallet?: ActiveWallet | null,
): Promise<string | undefined> {
  if (!iconOutpoint?.trim()) return undefined
  const cached = getTokenIconDataUrl(iconOutpoint)
  if (cached) return cached
  if (!wallet?.services?.getBeefForTxid) return undefined
  const parts = splitOutpoint(iconOutpoint)
  if (!parts) return undefined
  try {
    const beef = await getBeefForTxidCached(wallet, parts.txid)
    rememberBeef(parts.txid, beef)
    return cacheTokenIconFromBeef(iconOutpoint, beef)
  } catch {
    return undefined
  }
}
