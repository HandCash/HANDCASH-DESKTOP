/**
 * Derivative / reference inscriptions — one on-chain body, many child tips.
 *
 * Kit-Kat vending pattern: children carry a tiny `text/uri-list` (or ord://)
 * pointer at a shared parent outpoint. Peer remittance MUST forward that
 * pointer as `content` in customInstructions so the receiver can paint media
 * without an indexer. BRC-150 still proves tip→child origin (token identity);
 * `content` is a display claim for the shared body.
 */

const OUTPOINT_RE = /([0-9a-f]{64})[_.](\d+)/i

/** MIME types whose body is treated as a content pointer list. */
const REFERENCE_MIMES = new Set([
  'text/uri-list',
  'text/plain',
  'application/uri-list',
])

export function normalizeContentOutpoint(raw: string): string | null {
  const m = raw.trim().match(OUTPOINT_RE)
  if (!m) return null
  return `${m[1]!.toLowerCase()}_${m[2]}`
}

/**
 * Pull the first on-chain content outpoint from a uri-list / ord:// body.
 * Ignores comments (`#`) and off-chain http(s) URLs without an outpoint.
 */
export function parseContentReference(
  body: string | Uint8Array | number[],
  contentType?: string | null,
): string | null {
  const mime = (contentType ?? '').trim().toLowerCase().split(';')[0]!.trim()
  // Unknown mime: still try — many derivatives use text/uri-list or plain paths.
  if (mime && !REFERENCE_MIMES.has(mime) && !mime.startsWith('text/')) {
    // Non-text bodies are the media itself, not a pointer.
    if (!mime.includes('uri')) return null
  }

  const text =
    typeof body === 'string'
      ? body
      : new TextDecoder().decode(body instanceof Uint8Array ? body : Uint8Array.from(body))

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    // ord://txid_vout  |  sat://txid.vout  |  /content/<outpoint>.png
    const schemes = line.match(
      /(?:ord|sat):\/\/([0-9a-f]{64}[_.]\d+)/i,
    )
    if (schemes?.[1]) {
      const id = normalizeContentOutpoint(schemes[1])
      if (id) return id
    }

    const contentPath = line.match(
      /\/content\/([0-9a-f]{64}[_.]\d+)(?:\.[A-Za-z0-9]+)?/i,
    )
    if (contentPath?.[1]) {
      const id = normalizeContentOutpoint(contentPath[1])
      if (id) return id
    }

    // Bare outpoint on its own line
    if (/^[0-9a-f]{64}[_.]\d+$/i.test(line)) {
      const id = normalizeContentOutpoint(line)
      if (id) return id
    }

    // Gateway URL that embeds the outpoint somewhere
    const embedded = normalizeContentOutpoint(line)
    if (embedded && /(?:content|ordfs|gorillapool|1sat)/i.test(line)) {
      return embedded
    }
  }
  return null
}

/** True when this MIME is typically a pointer, not the display bytes. */
export function isReferenceMime(contentType?: string | null): boolean {
  const mime = (contentType ?? '').trim().toLowerCase().split(';')[0]!.trim()
  return mime === 'text/uri-list' || mime === 'application/uri-list'
}
