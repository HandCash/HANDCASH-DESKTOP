/**
 * Token icons from transaction bodies — no content indexers, no identicon.
 *
 * Local bodies first. A token received from another wallet names an icon
 * outpoint on a transaction this wallet never signed or ingested — the
 * issuer's image inscription — so a local-only lookup drew every received
 * token blank. The fallback is the raw transaction by txid from the wallet's
 * own providers, hash-checked here before any byte is trusted: chain data by
 * id, never an indexer's rendered `/content/`.
 */
import { Transaction, type Beef } from '@bsv/sdk'
import type { ActiveWallet } from '../../session'
import { normalizeTokenId } from '../types'
import { parseOrdEnvelope } from '../../ordinalOwnership'
import { decodeBProtocol } from '../../bProtocol'
import { imageMimeFor } from '../../inscriptionImage'
import { getTokenIconDataUrl, rememberTokenIcon } from '../icons/cache'

function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const id = normalizeTokenId(outpoint) ?? outpoint.trim().toLowerCase().replace('.', '_')
  const m = /^([0-9a-f]{64})_(\d+)$/i.exec(id)
  if (!m) return null
  return { txid: m[1]!.toLowerCase(), vout: Number(m[2]) }
}

function scriptHexOf(out: { lockingScript?: unknown } | undefined): string | undefined {
  const s = out?.lockingScript
  if (!s) return undefined
  if (typeof s === 'string') return s
  if (Array.isArray(s)) {
    if (!s.length) return undefined
    return s.map((b) => Number(b).toString(16).padStart(2, '0')).join('')
  }
  if (typeof s === 'object') {
    const o = s as { toHex?: () => string; toBinary?: () => number[]; hex?: string }
    if (typeof o.toHex === 'function') return o.toHex()
    if (typeof o.hex === 'string' && o.hex) return o.hex
    if (typeof o.toBinary === 'function') {
      const bin = o.toBinary()
      if (bin?.length) return bin.map((b) => Number(b).toString(16).padStart(2, '0')).join('')
    }
  }
  return undefined
}

function rememberImage(outpoint: string, scriptHex: string | undefined): string | undefined {
  const env = parseOrdEnvelope(scriptHex)
  if (env?.body?.length) {
    const mime = imageMimeFor(env.contentType, env.body)
    if (mime) {
      rememberTokenIcon(outpoint, env.body, mime)
      return getTokenIconDataUrl(outpoint)
    }
  }
  const b = decodeBProtocol(scriptHex)
  if (b?.data?.length) {
    const mime = imageMimeFor(b.mediaType, b.data)
    if (mime) {
      rememberTokenIcon(outpoint, b.data, mime)
      return getTokenIconDataUrl(outpoint)
    }
  }
  return undefined
}

export function cacheTokenIconFromBeef(
  outpoint: string,
  beef: { findTxid?: (txid: string) => { tx?: { outputs?: Array<{ lockingScript?: { toHex?: () => string } | string }> } } | undefined },
): string | undefined {
  const parts = splitOutpoint(outpoint)
  if (!parts) return undefined
  const tx = beef.findTxid?.(parts.txid)?.tx
  return rememberImage(outpoint, scriptHexOf(tx?.outputs?.[parts.vout]))
}

function txFromBeef(
  beef: Beef,
  txid: string,
): { outputs?: Array<{ lockingScript?: unknown }> } | undefined {
  const want = txid.toLowerCase()
  const found = beef.findTxid?.(want)?.tx
  if (found) return found
  for (const btx of beef.txs ?? []) {
    if (String(btx.txid ?? '').toLowerCase() === want) return btx.tx
  }
  return undefined
}

/**
 * The transaction a token's icon or deploy metadata lives on: held locally,
 * or fetched by txid and verified to hash to that txid. A provider miss is
 * remembered by `fetchRawTxHex`, so a token whose transaction nobody has does
 * not re-ask on every paint.
 */
export async function tokenTxBody(wallet: ActiveWallet, txid: string): Promise<Transaction | null> {
  const { getLocalTxForTxid } = await import('../../beefCache')
  const held = await getLocalTxForTxid(wallet, txid)
  if (held) return held
  try {
    const { fetchRawTxHex } = await import('../../oneSatImport')
    const hex = await fetchRawTxHex(txid, wallet.chain)
    if (!hex) return null
    const tx = Transaction.fromHex(hex)
    if (tx.id('hex') !== txid.toLowerCase()) {
      console.warn('[token-icon] provider body does not hash to its txid', txid.slice(0, 12))
      return null
    }
    return tx
  } catch {
    return null
  }
}

export async function resolveTokenIconDataUrl(
  iconOutpoint: string | undefined,
  wallet?: ActiveWallet | null,
): Promise<string | undefined> {
  if (!iconOutpoint?.trim()) return undefined
  const cached = getTokenIconDataUrl(iconOutpoint)
  if (cached) return cached
  if (!wallet) return undefined
  const parts = splitOutpoint(iconOutpoint)
  if (!parts) return undefined
  // The icon is one output script; the raw body answers without a BEEF walk.
  const tx = await tokenTxBody(wallet, parts.txid)
  if (!tx) return undefined
  return rememberImage(iconOutpoint, scriptHexOf(tx.outputs?.[parts.vout]))
}

/**
 * BSV-21 face. Prefer the named icon outpoint (4-byte same-tx or 36-byte
 * pointer). Fall back to a B-protocol sibling on the deploy tx. Bodies come
 * from {@link tokenTxBody}; never Gorilla /content/.
 */
export async function resolveBsv21IconDataUrl(args: {
  icon?: string
  origin?: string
  wallet?: ActiveWallet | null
}): Promise<string | undefined> {
  if (args.icon) {
    const hit = getTokenIconDataUrl(args.icon)
    if (hit) return hit
    const resolved = await resolveTokenIconDataUrl(args.icon, args.wallet)
    if (resolved) return resolved
  }
  if (!args.origin || !args.wallet) return undefined
  const originParts = splitOutpoint(args.origin)
  if (!originParts) return undefined
  const originTx = await tokenTxBody(args.wallet, originParts.txid)
  if (!originTx) return undefined
  if (args.icon) {
    const iconParts = splitOutpoint(args.icon)
    if (iconParts?.txid === originParts.txid) {
      const named = rememberImage(args.icon, scriptHexOf(originTx.outputs?.[iconParts.vout]))
      if (named) return named
    }
  }
  const rows = originTx.outputs ?? []
  for (let i = 0; i < rows.length; i++) {
    if (i === originParts.vout) continue
    const url = rememberImage(`${originParts.txid}_${i}`, scriptHexOf(rows[i]))
    if (url) return url
  }
  return undefined
}

/** Merge the icon's B-protocol tx into a 176/listing BEEF when it is not already there. */
export async function mergeIconTxIntoBeef(
  wallet: ActiveWallet,
  beef: Beef,
  iconOutpoint: string | undefined,
): Promise<void> {
  const parts = splitOutpoint(iconOutpoint ?? '')
  if (!parts) return
  if (txFromBeef(beef, parts.txid)) {
    cacheTokenIconFromBeef(iconOutpoint!, beef)
    return
  }
  const { getLocalBeefForTxid, rememberBeef } = await import('../../beefCache')
  const extra = await getLocalBeefForTxid(wallet, parts.txid)
  if (!extra) return
  rememberBeef(parts.txid, extra)
  try {
    beef.mergeBeef(extra)
  } catch {
    /* already present or incompatible wrap — session cache still has the tx */
  }
  cacheTokenIconFromBeef(iconOutpoint!, beef)
}
