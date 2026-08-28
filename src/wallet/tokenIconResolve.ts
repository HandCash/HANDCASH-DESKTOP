/**
 * Token icons from local BEEFs only — no content indexers, no identicon.
 */
import type { Beef } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { normalizeTokenId } from './bsv21'
import { rememberBeef } from './beefCache'
import { isOnesatFtMime } from './colourCoins'
import { parseOrdEnvelope } from './ordinalOwnership'
import { getTokenIconDataUrl, rememberTokenIcon } from './tokenIconCache'

function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const id = normalizeTokenId(outpoint) ?? outpoint.trim().toLowerCase().replace('.', '_')
  const m = /^([0-9a-f]{64})_(\d+)$/i.exec(id)
  if (!m) return null
  return { txid: m[1]!.toLowerCase(), vout: Number(m[2]) }
}

function sniffImageMime(body: Uint8Array): string | undefined {
  if (body.length >= 8 &&
      body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) {
    return 'image/png'
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    body.length >= 12 &&
    body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46 &&
    body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (body.length >= 6 &&
      body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x38) {
    return 'image/gif'
  }
  const head = new TextDecoder()
    .decode(body.subarray(0, Math.min(body.length, 96)))
    .trimStart()
    .toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml'
  }
  return undefined
}

function resolveIconMime(declared: string | undefined, body: Uint8Array): string | undefined {
  const m = (declared ?? '').toLowerCase().split(';')[0]!.trim()
  if (m.startsWith('image/') || m === 'image/svg+xml') return m
  if (m === 'application/octet-stream' || !m) return sniffImageMime(body)
  return undefined
}

function scriptHexOf(out: { lockingScript?: unknown } | undefined): string | undefined {
  const s = out?.lockingScript as
    | { toHex?: () => string; toBinary?: () => number[]; hex?: string }
    | string
    | number[]
    | undefined
  if (!s) return undefined
  if (typeof s === 'string') return s
  if (Array.isArray(s) && s.length) {
    return s.map((b) => Number(b).toString(16).padStart(2, '0')).join('')
  }
  if (s && typeof s === 'object') {
    if (typeof s.toHex === 'function') return s.toHex()
    if (typeof s.hex === 'string' && s.hex) return s.hex
    if (typeof s.toBinary === 'function') {
      const bin = s.toBinary()
      if (bin?.length) return bin.map((b) => Number(b).toString(16).padStart(2, '0')).join('')
    }
  }
  return undefined
}

function rememberImage(outpoint: string, scriptHex: string | undefined): string | undefined {
  const env = parseOrdEnvelope(scriptHex)
  if (!env || !env.body?.length) return undefined
  if (isOnesatFtMime(env.contentType)) return undefined
  const mime = resolveIconMime(env.contentType, env.body)
  if (!mime) return undefined
  rememberTokenIcon(outpoint, env.body, mime)
  return getTokenIconDataUrl(outpoint)
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

type BeefIconWalk = { url?: string; outs: number; mimes: string[]; skip?: 'not-ft' }

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

/** Step 2 of the FT scan: origin inscription must be 1sat-ft before any icon walk. */
function originIsOnesatFt(beef: Beef, origin: string): boolean {
  const parts = splitOutpoint(origin)
  if (!parts) return false
  const hex = scriptHexOf(txFromBeef(beef, parts.txid)?.outputs?.[parts.vout])
  const env = parseOrdEnvelope(hex)
  if (!env) return false
  if (isOnesatFtMime(env.contentType)) return true
  if (env.body?.length) {
    try {
      const json = JSON.parse(new TextDecoder().decode(env.body)) as { p?: unknown }
      if (String(json?.p ?? '').toLowerCase() === '1sat-ft') return true
    } catch {
      /* not FT json */
    }
  }
  return false
}

function describeOutMime(scriptHex: string | undefined): string {
  const env = parseOrdEnvelope(scriptHex)
  if (!env) return '-'
  const declared = (env.contentType ?? '').toLowerCase().split(';')[0]!.trim()
  if (declared) return declared
  const sniffed = env.body?.length ? sniffImageMime(env.body) : undefined
  return sniffed ? `octet/${sniffed}` : 'ord'
}

function iconFromBeefTree(beef: Beef, origin: string, namedIcon?: string): BeefIconWalk {
  if (!originIsOnesatFt(beef, origin)) return { outs: 0, mimes: [], skip: 'not-ft' }
  if (namedIcon) {
    const named = cacheTokenIconFromBeef(namedIcon, beef)
    if (named) return { url: named, outs: 0, mimes: [] }
  }
  const originParts = splitOutpoint(origin)
  if (!originParts) return { outs: 0, mimes: [] }
  const rows = txFromBeef(beef, originParts.txid)?.outputs ?? []
  const mimes: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const hex = scriptHexOf(rows[i])
    mimes.push(`${originParts.txid.slice(0, 8)}:${i}:${describeOutMime(hex)}`)
    if (i === originParts.vout) continue
    const url = rememberImage(`${originParts.txid}_${i}`, hex)
    if (url) return { url, outs: rows.length, mimes }
  }
  return { outs: rows.length, mimes }
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
  const { getLocalBeefForTxid } = await import('./beefCache')
  const beef = await getLocalBeefForTxid(wallet, parts.txid)
  if (!beef) return undefined
  rememberBeef(parts.txid, beef)
  return cacheTokenIconFromBeef(iconOutpoint, beef)
}

/** 1Sat FT face from local BEEFs (tip + origin). No Gorilla /content/. */
export async function resolveOnesatFtIconDataUrl(args: {
  origin: string
  icon?: string
  tipOutpoint?: string
  wallet?: ActiveWallet | null
}): Promise<string | undefined> {
  const originShort = (args.origin ?? '').slice(0, 8)
  const tipShort = (args.tipOutpoint ?? '').slice(0, 8) || '-'
  if (args.icon) {
    const hit = getTokenIconDataUrl(args.icon)
    if (hit) {
      console.info(`[1sat-ft-icon] origin=${originShort} tip=${tipShort} beef=cache image=hit`)
      return hit
    }
  }
  if (!args.wallet) {
    console.info(`[1sat-ft-icon] origin=${originShort} tip=${tipShort} beef=miss image=miss`)
    return undefined
  }
  const { getLocalBeefForTxid, rememberBeefTree } = await import('./beefCache')
  const originTxid = splitOutpoint(args.origin)?.txid
  if (!originTxid) return undefined
  const beef = await getLocalBeefForTxid(args.wallet, originTxid)
  if (!beef) {
    console.info(`[1sat-ft-icon] origin=${originShort} tip=${tipShort} skip=no-origin-beef`)
    return undefined
  }
  rememberBeef(originTxid, beef)
  try {
    rememberBeefTree(beef.toBinary())
  } catch {
    /* session cache is enough */
  }
  const walk = iconFromBeefTree(beef, args.origin, args.icon)
  if (walk.skip === 'not-ft') {
    console.info(`[1sat-ft-icon] origin=${originShort} tip=${tipShort} skip=not-ft`)
    return undefined
  }
  if (walk.url) {
    console.info(`[1sat-ft-icon] origin=${originShort} tip=${tipShort} beef=hit image=hit`)
    return walk.url
  }
  const mimeLog = walk.mimes.length > 0 ? ` mimes=${walk.mimes.join(',')}` : ''
  console.info(
    `[1sat-ft-icon] origin=${originShort} tip=${tipShort} beef=hit image=miss outs=${walk.outs}${mimeLog}`,
  )
  return undefined
}
