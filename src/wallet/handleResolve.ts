/**
 * BRC-169 handle resolve client → BRC-CLOUD.
 *
 * Input accepts HandCash `$handle` / `$handle@domain` and BRC-169 `@handle` /
 * `@handle@domain` (plus bare paymail-shaped `handle@domain`). Display for
 * HandCash prefers `$`.
 */
import { DEFAULT_METANET_HANDLES_BASE_URL } from './walletConfig'
import { formatHandCashHandle } from './handleFormat'

export type ResolvedHandle = {
  handle: string
  domain: string
  identityKey: string
  certificate: unknown
  display: string
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** Parse $handle, @handle, $handle@domain, @handle@domain, handle@domain, or bare handle. */
export function parseHandleInput(raw: string): { handle: string; domain: string | null } | null {
  const t = raw.trim()
  if (!t) return null

  // $alice@handcash.io or @alice@handcash.io
  let m =
    /^[$@]([a-z0-9][a-z0-9._-]{0,62}[a-z0-9])@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(t)
  if (m) return { handle: m[1]!.toLowerCase(), domain: m[2]!.toLowerCase() }

  // $alice or @alice
  m = /^[$@]([a-z0-9][a-z0-9._-]{0,62}[a-z0-9])$/i.exec(t)
  if (m) return { handle: m[1]!.toLowerCase(), domain: null }

  // alice@handcash.io (paymail-shaped → handle grammar)
  m = /^([a-z0-9][a-z0-9._-]{0,62}[a-z0-9])@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(t)
  if (m) return { handle: m[1]!.toLowerCase(), domain: m[2]!.toLowerCase() }

  // alice (bare local-part). Must start with a letter so P2PKH (`1…` / `3…`)
  // and identity keys (`02` / `03`) are never treated as handles.
  m = /^([a-z][a-z0-9._-]{0,62}[a-z0-9]|[a-z])$/i.exec(t)
  if (m) return { handle: m[1]!.toLowerCase(), domain: null }

  return null
}

export async function resolveHandle(
  raw: string,
  baseUrl = DEFAULT_METANET_HANDLES_BASE_URL,
): Promise<ResolvedHandle> {
  const parsed = parseHandleInput(raw)
  if (!parsed) throw new Error('Not a handle')
  const base = normalizeBase(baseUrl)
  if (!base) throw new Error('Handle resolve host not configured')

  const url = `${base}/.well-known/metanet-handles/resolve?handle=${encodeURIComponent(parsed.handle)}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (res.status === 404) {
    throw new Error(`Handle ${formatHandCashHandle(parsed.handle, parsed.domain)} not found`)
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 120)
    throw new Error(`Handle resolve failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = (await res.json()) as {
    handle?: string
    domain?: string
    identityKey?: string
    certificate?: unknown
  }
  if (!data.handle || !data.identityKey || !data.domain) {
    throw new Error('Invalid resolve response')
  }
  return {
    handle: data.handle,
    domain: data.domain,
    identityKey: data.identityKey.toLowerCase(),
    certificate: data.certificate,
    display: formatHandCashHandle(data.handle, data.domain, { fullyQualified: true }),
  }
}

export async function claimHandle(args: {
  handle: string
  identityKey: string
  /** Short-lived ticket from HandCash (items-market) — required in production. */
  claimTicket?: string
  baseUrl?: string
}): Promise<{ display: string; certificate: unknown }> {
  const base = normalizeBase(args.baseUrl || DEFAULT_METANET_HANDLES_BASE_URL)
  const res = await fetch(`${base}/v1/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      handle: args.handle,
      identityKey: args.identityKey,
      claimTicket: args.claimTicket,
    }),
  })
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    let detail = raw.slice(0, 160)
    try {
      const body = JSON.parse(raw) as {
        error?: string | { code?: string; message?: string }
        message?: string
      }
      const err = body?.error
      if (typeof err === 'string') detail = err
      else if (err && typeof err === 'object') {
        if (err.code === 'invalid-ticket') {
          detail =
            'invalid-ticket (market HANDLE_CLAIM_SECRET ≠ BRC-CLOUD — set the same value on Vercel Preview/preprod)'
        } else {
          detail = String(err.code || err.message || detail)
        }
      } else if (typeof body?.message === 'string') {
        detail = body.message
      }
    } catch {
      /* keep raw slice */
    }
    throw new Error(`Handle claim failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = (await res.json()) as { display?: string; certificate?: unknown }
  return {
    display:
      data.display ||
      formatHandCashHandle(args.handle, 'handcash.io', { fullyQualified: true }),
    certificate: data.certificate,
  }
}
