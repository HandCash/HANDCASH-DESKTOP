/**
 * Quarantine for the removed pre-BSV-21 fungible experiment.
 *
 * This is deliberately detection-only. It prevents historical outputs from
 * being reclassified as collectables during chain ingest. No wallet surface
 * may list, mint, send, receive, or otherwise interpret this protocol.
 */
import { parseOrdEnvelope } from './ordinalOwnership'

const RETIRED_PROTOCOL = '1sat-ft'
const RETIRED_MIME = 'application/1sat-ft+json'
const OUTPOINT_RE = /^[0-9a-f]{64}_\d+$/i
const decoder = new TextDecoder()

function asRecord(raw: unknown): Record<string, unknown> | null {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeOutpoint(raw: string): string | null {
  const outpoint = raw.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
  return OUTPOINT_RE.test(outpoint) ? outpoint : null
}

export function isRetiredFungibleMime(
  contentType: string | undefined | null,
): boolean {
  return (
    (contentType ?? '').trim().toLowerCase().split(';')[0]?.trim() ===
    RETIRED_MIME
  )
}

export function isRetiredFungibleBasket(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().toLowerCase() === RETIRED_PROTOCOL
  )
}

export function containsRetiredFungibleRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some(containsRetiredFungibleRequest)
  }
  const record = value as Record<string, unknown>
  if (isRetiredFungibleBasket(record.basket)) return true
  if (
    looksLikeRetiredFungibleTip({
      tags: record.tags,
      customInstructions: record.customInstructions,
      lockingScriptHex:
        typeof record.lockingScript === 'string'
          ? record.lockingScript
          : undefined,
    })
  ) {
    return true
  }
  return Object.values(record).some(containsRetiredFungibleRequest)
}

export function looksLikeRetiredFungibleTip(args: {
  tags?: unknown
  customInstructions?: unknown
  lockingScriptHex?: string
}): boolean {
  const custom = asRecord(args.customInstructions)
  const nested =
    custom?.colour &&
    typeof custom.colour === 'object' &&
    !Array.isArray(custom.colour)
      ? (custom.colour as Record<string, unknown>)
      : custom
  if (String(nested?.p ?? '').trim().toLowerCase() === RETIRED_PROTOCOL) {
    return true
  }

  if (Array.isArray(args.tags)) {
    for (const tag of args.tags) {
      if (
        typeof tag === 'string' &&
        (tag.trim().toLowerCase() === RETIRED_PROTOCOL ||
          tag.trim().toLowerCase().startsWith(`${RETIRED_PROTOCOL}:`))
      ) {
        return true
      }
    }
  }

  if (!args.lockingScriptHex) return false
  const envelope = parseOrdEnvelope(args.lockingScriptHex)
  if (isRetiredFungibleMime(envelope?.contentType)) return true
  if (!envelope?.body?.length) return false
  try {
    const body = asRecord(JSON.parse(decoder.decode(envelope.body)))
    return String(body?.p ?? '').trim().toLowerCase() === RETIRED_PROTOCOL
  } catch {
    return false
  }
}

export function retiredFungibleOriginFromLock(
  lockingScriptHex: string | undefined,
): string | null {
  if (!lockingScriptHex) return null
  const envelope = parseOrdEnvelope(lockingScriptHex)
  if (
    !envelope?.body?.length ||
    (!isRetiredFungibleMime(envelope.contentType) &&
      !looksLikeRetiredFungibleTip({ lockingScriptHex }))
  ) {
    return null
  }
  try {
    const body = asRecord(JSON.parse(decoder.decode(envelope.body)))
    return typeof body?.origin === 'string'
      ? normalizeOutpoint(body.origin)
      : null
  } catch {
    return null
  }
}

export function isRetiredFungibleAmountHop(
  lockingScriptHex: string | undefined,
): boolean {
  if (!lockingScriptHex) return false
  const envelope = parseOrdEnvelope(lockingScriptHex)
  if (
    !isRetiredFungibleMime(envelope?.contentType) ||
    !envelope?.body?.length
  ) {
    return false
  }
  try {
    const body = asRecord(JSON.parse(decoder.decode(envelope.body)))
    if (!body) return false
    const keys = Object.keys(body).map((key) => key.toLowerCase())
    return (
      keys.includes('amt') &&
      keys.every((key) => key === 'amt' || key === 'sym')
    )
  } catch {
    return false
  }
}
