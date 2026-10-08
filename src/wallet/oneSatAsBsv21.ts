/**
 * Is a one-sat output a BSV-21 fungible? Item paint and import ask this so a
 * token never lands in Collect as an NFT. Pure — reads no basket.
 */
import {
  decodeBsv21Binary,
  iconOutpointFromPayload,
  isBsv21Mime,
  parseBsv21Json,
  tokenIdForPayload,
  tokenIdFromBsv21Tags,
  type Bsv21Op,
  type Bsv21Payload,
} from './token'
import {
  isRetiredFungibleMime,
  looksLikeRetiredFungibleTip,
} from './retiredFungible'
import { parseOrdEnvelope } from './ordinalOwnership'

/**
 * `encoding` names how the holding was proven by the locking script: `binary`
 * is a BRC-162 lock (live, sendable), `json` is a read-only legacy ord
 * inscription. `unproven` means only remittance / tags said "token" — that is
 * metadata, never proof of the wire format. The caller must not infer any of
 * this from a missing field.
 */
export type OneSatAsBsv21 =
  | {
      kind: 'bsv21'
      encoding: 'binary' | 'json' | 'unproven'
      payload: Bsv21Payload
      tokenId: string
    }
  | { kind: 'skip' }

export type ClassifyOneSatAsBsv21Args = {
  satoshis: number
  outpoint?: string
  lockingScriptHex?: string
  customInstructions?: unknown
  tags?: string[]
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const o = JSON.parse(raw) as unknown
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        return o as Record<string, unknown>
      }
    } catch {
      return null
    }
  }
  return null
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  const hit = tags.find((t) => t.toLowerCase().startsWith(prefix.toLowerCase()))
  if (!hit) return undefined
  const value = hit.slice(prefix.length).trim()
  return value || undefined
}

function payloadFromEnvelope(
  lockingScriptHex: string | undefined,
): { mime: string; payload: Bsv21Payload | null } {
  const env = parseOrdEnvelope(lockingScriptHex)
  const mime = (env?.contentType ?? '').toLowerCase().split(';')[0]!.trim()
  if (!env?.body?.length) return { mime, payload: null }
  try {
    const json = JSON.parse(new TextDecoder().decode(env.body)) as unknown
    return { mime, payload: parseBsv21Json(json) }
  } catch {
    return { mime, payload: null }
  }
}

function collectableMime(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('text/') ||
    mime.includes('html') ||
    mime.startsWith('application/json') === false &&
      mime.length > 0 &&
      !isBsv21Mime(mime) &&
      !isRetiredFungibleMime(mime)
  )
}

/**
 * A 1sat-basket tip is a BSV-21 fungible only when the inscription or
 * remittance is a valid bsv-20 holding. Image/text collectables never move.
 */
export function classifyOneSatAsBsv21(
  args: ClassifyOneSatAsBsv21Args,
): OneSatAsBsv21 {
  if (args.satoshis !== 1) return { kind: 'skip' }

  const binary = args.lockingScriptHex
    ? decodeBsv21Binary(args.lockingScriptHex)
    : null
  if (binary && binary.amount > 0n && binary.role !== 'authority') {
    const op = (args.outpoint ?? '').trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
    const tokenId = binary.tokenId ?? (binary.role === 'deploy' ? op : '')
    if (tokenId) {
      const icon = iconOutpointFromPayload(binary.payload?.icon, tokenId)
      const payload = parseBsv21Json({
        p: 'bsv-20',
        op: binary.role === 'deploy' ? 'deploy+mint' : 'transfer',
        id: tokenId,
        amt: binary.amount.toString(),
        ...(binary.payload?.sym ? { sym: binary.payload.sym } : {}),
        ...(binary.payload?.dec != null ? { dec: String(binary.payload.dec) } : {}),
        ...(icon ? { icon } : {}),
      })
      if (payload) return { kind: 'bsv21', encoding: 'binary', payload, tokenId }
    }
  }

  const { mime, payload: envPayload } = payloadFromEnvelope(args.lockingScriptHex)
  if (
    isRetiredFungibleMime(mime) ||
    looksLikeRetiredFungibleTip({
      tags: args.tags,
      customInstructions: args.customInstructions,
      lockingScriptHex: args.lockingScriptHex,
    })
  ) {
    return { kind: 'skip' }
  }

  const ci = asRecord(args.customInstructions)

  // Image / text / other collectable envelopes stay NFTs even if someone
  // stamped a token remittance on top (Pixel Foxes ≠ FOX).
  if (mime && !isBsv21Mime(mime) && collectableMime(mime)) {
    return { kind: 'skip' }
  }

  // A one-sat lock with neither a BRC-162 prefix nor an inscription cannot
  // carry a live token. Tags or remittance alone must not file it as one:
  // that metadata reads both ways, and the tip flipped between Tokens and
  // NFTs on every Refresh.
  if (args.lockingScriptHex?.trim() && !parseOrdEnvelope(args.lockingScriptHex)) {
    return { kind: 'skip' }
  }

  const ciPayload = parseBsv21Json(ci)
  const payload = envPayload ?? ciPayload
  const op = (payload?.op ?? tagValue(args.tags, 'op:') ?? 'transfer') as Bsv21Op
  const tokenId =
    (payload ? tokenIdForPayload(payload, args.outpoint ?? '') : null) ??
    tokenIdFromBsv21Tags(args.tags)
  const amt = payload?.amt ?? tagValue(args.tags, 'amt:')
  const hasBsv21Tag = (args.tags ?? []).some(
    (t) => t === 'bsv21' || t.toLowerCase().startsWith('bsv21:'),
  )

  if (payload && tokenId) {
    return {
      kind: 'bsv21',
      encoding: envPayload ? 'json' : 'unproven',
      payload,
      tokenId,
    }
  }
  if ((isBsv21Mime(mime) || hasBsv21Tag) && tokenId && amt) {
    const built = parseBsv21Json({
      p: 'bsv-20',
      op,
      id: tokenId,
      amt,
      ...(payload?.sym || tagValue(args.tags, 'sym:')
        ? { sym: payload?.sym ?? tagValue(args.tags, 'sym:') }
        : {}),
    })
    if (built) {
      return {
        kind: 'bsv21',
        // Built from a bsv21 mime / tag, not from decoded inscription JSON.
        encoding: isBsv21Mime(mime) ? 'json' : 'unproven',
        payload: built,
        tokenId: tokenIdForPayload(built, args.outpoint ?? '') ?? tokenId,
      }
    }
  }
  return { kind: 'skip' }
}

/** True when a one-sat lock is an active BSV-21 token output. */
export function isBsv21OneSatLock(lockingScriptHex?: string): boolean {
  if (!lockingScriptHex?.trim()) return false
  if (decodeBsv21Binary(lockingScriptHex)) return true
  // JSON deploy+mint / mint / transfer — same Tokens bucket as binary 162.
  return (
    classifyOneSatAsBsv21({
      satoshis: 1,
      outpoint: `${'0'.repeat(64)}_0`,
      lockingScriptHex,
    }).kind === 'bsv21'
  )
}

/** True when a one-sat output must not be painted as a collectable. */
export function isNonCollectableOneSatLock(lockingScriptHex?: string): boolean {
  return (
    isBsv21OneSatLock(lockingScriptHex) ||
    looksLikeRetiredFungibleTip({ lockingScriptHex })
  )
}
