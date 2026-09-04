/**
 * Post-createAction activity / icon side-effects for BRC-100 bridge.
 * Kept out of `brc100Handler.ts` so permission gating stays readable.
 */
import { Beef, Transaction } from '@bsv/sdk'
import {
  formatActivityTokenAmt,
  hasActivityItemOutpoint,
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { normalizeTokenId } from './bsv21'
import { bsv21IdentityMintHints } from './bsv21Issuer'
import { parseOrdEnvelope } from './ordinalOwnership'
import { getTokenIconDataUrl, rememberTokenIcon } from './tokenIconCache'

/**
 * Cache image-inscription outputs we just authored (BSV-21 ticker icons).
 *
 * Prefer the **broadcast subject tx** (result.tx / AtomicBEEF): request
 * `args.outputs` indices do not match final vouts when `randomizeOutputs` is
 * on, and caching `txid_0` for a shuffled inscription points at change.
 */
export function cacheImageIconsFromCreateAction(
  txid: string,
  args: unknown,
  result?: unknown,
): void {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return

  const cacheFromScript = (vout: number, scriptHex: string) => {
    const env = parseOrdEnvelope(scriptHex)
    if (!env?.contentType) return
    const mime = env.contentType.toLowerCase().split(';')[0]!.trim()
    if (!mime.startsWith('image/')) return
    rememberTokenIcon(`${id}_${vout}`, env.body, mime)
  }

  // 1) Subject transaction from createAction result (correct vouts).
  if (result && typeof result === 'object') {
    const raw = (result as { tx?: unknown }).tx
    let binary: number[] | null = null
    if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
      binary = raw as number[]
    } else if (raw instanceof Uint8Array) {
      binary = Array.from(raw)
    } else if (typeof raw === 'string' && raw.trim()) {
      try {
        const bin = atob(raw.trim())
        binary = Array.from(bin, (c) => c.charCodeAt(0))
      } catch {
        binary = null
      }
    }
    if (binary?.length) {
      try {
        const beef = Beef.fromBinary(binary)
        const tx = beef.findTxid(id)?.tx
        if (tx?.outputs?.length) {
          tx.outputs.forEach((out, vout) => {
            const hex = out?.lockingScript?.toHex?.()
            if (typeof hex === 'string' && hex) cacheFromScript(vout, hex)
          })
          return
        }
      } catch {
        // not AtomicBEEF
      }
      try {
        const tx = Transaction.fromBinary(binary)
        tx.outputs.forEach((out, vout) => {
          const hex = out?.lockingScript?.toHex?.()
          if (typeof hex === 'string' && hex) cacheFromScript(vout, hex)
        })
        return
      } catch {
        // fall through to request outputs
      }
    }
  }

  // 2) Fallback: request outputs only when randomization was off / single out.
  if (!args || typeof args !== 'object' || Array.isArray(args)) return
  const outputs = (args as { outputs?: unknown }).outputs
  if (!Array.isArray(outputs)) return
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const script = (raw as { lockingScript?: unknown }).lockingScript
    if (typeof script !== 'string' || !script) continue
    cacheFromScript(vout, script)
  }
}

/**
 * 1Sat FT genesis mint — activity as minted token (not a plain BSV spend or
 * collectable receive). Icon sibling is decorative; face-value tip is the row.
 */
export function recordColourMintActivity(
  txid: string,
  args: unknown,
  originator: string | undefined,
): boolean {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return false
  const outputs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { outputs?: unknown[] }).outputs
      : undefined
  if (!Array.isArray(outputs)) return false

  let recorded = false
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const out = raw as {
      basket?: string
      tags?: string[]
      customInstructions?: string
    }
    if ((out.basket ?? '').trim().toLowerCase() !== '1sat-ft') continue

    let sym = 'Token'
    let amt: string | null = null
    let icon: string | null = null
    let iconVout: number | null = null
    for (const tag of out.tags ?? []) {
      const t = tag.trim()
      const lower = t.toLowerCase()
      if (lower.startsWith('sym:')) sym = t.slice(4).trim() || sym
      if (lower.startsWith('icon:')) {
        icon = normalizeTokenId(t.slice(5)) || icon
      }
      if (lower.startsWith('iconvout:')) {
        const n = Number(t.slice('iconvout:'.length).trim())
        if (Number.isSafeInteger(n) && n >= 0) iconVout = n
      }
    }
    if (out.customInstructions) {
      try {
        const ci = JSON.parse(out.customInstructions) as {
          sym?: unknown
          amt?: unknown
          icon?: unknown
          iconVout?: unknown
        }
        if (typeof ci.sym === 'string' && ci.sym.trim()) sym = ci.sym.trim()
        if (typeof ci.amt === 'string' && ci.amt.trim()) amt = ci.amt.trim()
        else if (typeof ci.amt === 'number' && Number.isSafeInteger(ci.amt)) {
          amt = String(ci.amt)
        }
        if (typeof ci.icon === 'string') {
          icon = normalizeTokenId(ci.icon) || icon
        }
        if (
          typeof ci.iconVout === 'number' &&
          Number.isSafeInteger(ci.iconVout) &&
          ci.iconVout >= 0
        ) {
          iconVout = ci.iconVout
        }
      } catch {
        // ignore
      }
    }
    if (!icon && iconVout != null) icon = `${id}_${iconVout}`
    if (!amt) continue

    const tokenId = `${id}_${vout}`
    const outpoint = `${id}.${vout}`
    const imageUrl = icon ? getTokenIconDataUrl(icon) : undefined
    recorded = true
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'mint-token',
      note: `Minted ${formatActivityTokenAmt(amt, 0)} ${sym}`,
      txid: id,
      item: {
        name: sym,
        origin: tokenId,
        outpoint,
        tokenId,
        amt,
        dec: 0,
        ...(icon ? { icon } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      },
    })
  }
  return recorded
}

/**
 * Identity mint / remint: activity as minted tokens (not a plain receive or BSV spend).
 * Mint tips use tip outpoint as the activity key; genesis-only deploy+auth is an event.
 */
export function recordIdentityMintActivity(
  txid: string,
  args: unknown,
  originator: string | undefined,
): void {
  const hints = bsv21IdentityMintHints(args)
  const sym = hints.sym?.trim() || 'Token'
  const outputs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { outputs?: unknown[] }).outputs
      : undefined
  if (!Array.isArray(outputs) || outputs.length === 0) {
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'event',
      sats: 0,
      method: 'mint-token',
      note: hints.amt
        ? `Minted ${formatActivityTokenAmt(hints.amt, hints.dec ?? 0)} ${sym}`
        : `Minted ${sym}`,
      txid,
    })
    return
  }

  const id = txid.trim().toLowerCase()
  let recordedMint = false
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const out = raw as {
      basket?: string
      tags?: string[]
      customInstructions?: string
    }
    if ((out.basket ?? '').trim().toLowerCase() !== 'bsv21') continue
    let op = ''
    let tokenId: string | null = null
    let amt: string | null = hints.amt
    let tipSym = sym
    let dec: number | undefined = hints.dec ?? undefined
    let icon: string | null = hints.icon
    for (const tag of out.tags ?? []) {
      const t = tag.trim()
      const lower = t.toLowerCase()
      if (lower.startsWith('op:')) op = t.slice(3).trim().toLowerCase()
      if (lower.startsWith('bsv21:')) {
        tokenId = normalizeTokenId(t.slice('bsv21:'.length))
      }
      if (lower.startsWith('amt:')) amt = t.slice(4).trim() || amt
      if (lower.startsWith('sym:')) tipSym = t.slice(4).trim() || tipSym
      if (lower.startsWith('dec:')) {
        const n = Number(t.slice(4).trim())
        if (Number.isInteger(n) && n >= 0 && n <= 18) dec = n
      }
      if (lower.startsWith('icon:')) {
        icon = normalizeTokenId(t.slice(5)) || icon
      }
    }
    if (out.customInstructions) {
      try {
        const ci = JSON.parse(out.customInstructions) as {
          op?: unknown
          id?: unknown
          amt?: unknown
          sym?: unknown
          dec?: unknown
          icon?: unknown
        }
        if (!op && typeof ci.op === 'string') op = ci.op.trim().toLowerCase()
        if (!tokenId && typeof ci.id === 'string') {
          tokenId = normalizeTokenId(ci.id)
        }
        if (!amt && typeof ci.amt === 'string') amt = ci.amt.trim()
        if (typeof ci.sym === 'string' && ci.sym.trim()) tipSym = ci.sym.trim()
        if (
          dec == null &&
          typeof ci.dec === 'number' &&
          Number.isInteger(ci.dec) &&
          ci.dec >= 0 &&
          ci.dec <= 18
        ) {
          dec = ci.dec
        }
        if (!icon && typeof ci.icon === 'string') {
          icon = normalizeTokenId(ci.icon)
        }
      } catch {
        // ignore
      }
    }
    if (op === 'deploy+mint') {
      tokenId = tokenId ?? normalizeTokenId(`${id}_${vout}`)
    }
    if (op !== 'mint' && op !== 'deploy+mint') continue
    if (!tokenId || !amt) continue
    const outpoint = `${id}.${vout}`
    recordedMint = true
    const qty = formatActivityTokenAmt(amt, dec ?? 0)
    const imageUrl = icon ? getTokenIconDataUrl(icon) : undefined
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'mint-token',
      note: `Minted ${qty} ${tipSym}`,
      txid: id,
      item: {
        name: tipSym,
        origin: tokenId,
        outpoint,
        tokenId,
        amt,
        ...(dec != null ? { dec } : {}),
        ...(icon ? { icon } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      },
    })
  }

  if (!recordedMint) {
    // deploy+auth (or mint args without parseable tip) — still surface the action.
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'event',
      sats: 0,
      method: 'mint-token',
      note: hints.amt
        ? `Minted ${formatActivityTokenAmt(hints.amt, hints.dec ?? 0)} ${sym}`
        : `Deployed ${sym}`,
      txid: id,
    })
  }
}

/**
 * App createAction that transfers BSV-21 tips — record as send-token (not a 1-sat BSV spend).
 * Returns true when at least one tip was recorded.
 */
export function recordBsv21TransferSends(
  txid: string,
  args: unknown,
  originator: string | undefined,
): boolean {
  const outputs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { outputs?: unknown[] }).outputs
      : undefined
  if (!Array.isArray(outputs) || outputs.length === 0) return false

  const id = txid.trim().toLowerCase()
  let recorded = false
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const out = raw as {
      basket?: string
      tags?: string[]
      customInstructions?: string
    }
    if ((out.basket ?? '').trim().toLowerCase() !== 'bsv21') continue
    let op = ''
    let tokenId: string | null = null
    let amt: string | null = null
    let tipSym = 'Token'
    let dec: number | undefined
    let icon: string | null = null
    for (const tag of out.tags ?? []) {
      const t = tag.trim()
      const lower = t.toLowerCase()
      if (lower.startsWith('op:')) op = t.slice(3).trim().toLowerCase()
      if (lower.startsWith('bsv21:')) {
        tokenId = normalizeTokenId(t.slice('bsv21:'.length))
      }
      if (lower.startsWith('id:')) tokenId = normalizeTokenId(t.slice(3))
      if (lower.startsWith('amt:')) amt = t.slice(4).trim() || amt
      if (lower.startsWith('sym:')) tipSym = t.slice(4).trim() || tipSym
      if (lower.startsWith('dec:')) {
        const n = Number(t.slice(4).trim())
        if (Number.isInteger(n) && n >= 0 && n <= 18) dec = n
      }
      if (lower.startsWith('icon:')) {
        icon = normalizeTokenId(t.slice(5)) || icon
      }
    }
    if (out.customInstructions) {
      try {
        const ci = JSON.parse(out.customInstructions) as {
          op?: unknown
          id?: unknown
          amt?: unknown
          sym?: unknown
          dec?: unknown
          icon?: unknown
        }
        if (!op && typeof ci.op === 'string') op = ci.op.trim().toLowerCase()
        if (!tokenId && typeof ci.id === 'string') {
          tokenId = normalizeTokenId(ci.id)
        }
        if (!amt && typeof ci.amt === 'string') amt = ci.amt.trim()
        if (typeof ci.sym === 'string' && ci.sym.trim()) tipSym = ci.sym.trim()
        if (
          dec == null &&
          typeof ci.dec === 'number' &&
          Number.isInteger(ci.dec) &&
          ci.dec >= 0 &&
          ci.dec <= 18
        ) {
          dec = ci.dec
        }
        if (!icon && typeof ci.icon === 'string') {
          icon = normalizeTokenId(ci.icon)
        }
      } catch {
        // ignore
      }
    }
    if (op !== 'transfer') continue
    if (!tokenId || !amt) continue
    const outpoint = `${id}.${vout}`
    if (hasActivityItemOutpoint(outpoint)) continue
    recorded = true
    const qty = formatActivityTokenAmt(amt, dec ?? 0)
    const imageUrl = icon ? getTokenIconDataUrl(icon) : undefined
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 1,
      method: 'send-token',
      note: `Sent ${qty} ${tipSym}`,
      txid: id,
      item: {
        name: tipSym,
        origin: tokenId,
        outpoint,
        tokenId,
        amt,
        ...(dec != null ? { dec } : {}),
        ...(icon ? { icon } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      },
    })
  }
  return recorded
}
