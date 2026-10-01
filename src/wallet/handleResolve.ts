/**
 * BRC-169 handle resolve client → BRC-CLOUD.
 *
 * Input accepts HandCash `$handle`, BRC-169 `@handle` / `@handle@domain`,
 * legacy `@$handle` / `@$handle@domain`, plus bare paymail-shaped
 * `handle@domain`. Short display is `$handle`; fully-qualified display is
 * `@handle@domain` (no `$`).
 */
import { DEFAULT_METANET_HANDLES_BASE_URL } from './walletConfig'
import { formatHandCashHandle } from './handleFormat'
import { parseWalletProtocols } from './peerTokenCapability'
import {
  HandleCertificateError,
  verifyHandleCertificate,
  type HandleCertificate,
} from './handleCertificate'

export type ResolvedHandle = {
  handle: string
  domain: string
  identityKey: string
  /** Verified per BRC-169 §4.1 against the pinned certifier for `domain`. */
  certificate: HandleCertificate
  /** Master certificate encrypted to the subject; only its own wallet can acquire it. */
  walletCertificate: unknown
  display: string
  /** BRC-169 messagebox URL when the resolve host returns one. */
  messagebox: string | null
  /**
   * Optional wallet protocol tags from the resolve host (e.g. `bsv21`, `1sat`).
   * Empty when the host does not publish them yet — treat as unknown, not denial.
   */
  protocols: string[]
}

type ResolveRow = {
  handle?: string
  domain?: string
  identityKey?: string
  certificate?: unknown
  walletCertificate?: unknown
  messagebox?: string | null
  protocols?: unknown
}

/** A resolve row whose certificate passes §4.1, or the refusal. */
async function certifiedHandle(
  row: ResolveRow,
  fallbackProtocols?: unknown,
): Promise<ResolvedHandle> {
  const handle = row.handle!.toLowerCase()
  const domain = row.domain!.toLowerCase()
  const identityKey = row.identityKey!.toLowerCase()
  const display = formatHandCashHandle(handle, domain, { fullyQualified: true })
  const verdict = await verifyHandleCertificate(row.certificate, { handle, domain, identityKey })
  if (verdict.kind === 'refused') throw new HandleCertificateError(display, verdict.reason)
  const messagebox =
    typeof row.messagebox === 'string' && row.messagebox.trim()
      ? row.messagebox.trim().replace(/\/+$/, '')
      : null
  return {
    handle,
    domain,
    identityKey,
    certificate: verdict.certificate,
    walletCertificate: row.walletCertificate ?? null,
    display,
    messagebox,
    protocols: parseWalletProtocols(row.protocols ?? fallbackProtocols),
  }
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function parseHandleInput(raw: string): { handle: string; domain: string | null } | null {
  const t = raw.trim()
  if (!t) return null

  // @$alice@handcash.io, $alice@handcash.io, or @alice@handcash.io
  let m =
    /^(?:@\$|[$@])([a-z0-9][a-z0-9._-]{0,62}[a-z0-9])@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(t)
  if (m) return { handle: m[1]!.toLowerCase(), domain: m[2]!.toLowerCase() }

  // @$alice, $alice, or @alice
  m = /^(?:@\$|[$@])([a-z0-9][a-z0-9._-]{0,62}[a-z0-9])$/i.exec(t)
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

/** Do not hit resolve until the local-part is long enough to be intentional. */
export const HANDLE_RESOLVE_MIN_LEN = 3
export const HANDLE_RESOLVE_DEBOUNCE_MS = 400

export function shouldResolveHandleInput(raw: string): boolean {
  const parsed = parseHandleInput(raw)
  if (!parsed) return false
  return parsed.handle.length >= HANDLE_RESOLVE_MIN_LEN
}

export type HandleResolveDebouncer = {
  cancel: () => void
  schedule: (
    raw: string,
    handlers: {
      onResolved: (resolved: ResolvedHandle) => void
      onError: (err: Error) => void
    },
  ) => void
}

/** Debounced resolve — avoids 404 spam while the user is still typing `$al…`. */
export function createHandleResolveDebouncer(
  debounceMs = HANDLE_RESOLVE_DEBOUNCE_MS,
): HandleResolveDebouncer {
  let timer: ReturnType<typeof setTimeout> | undefined
  let gen = 0

  return {
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
      gen += 1
    },
    schedule(raw, handlers) {
      if (timer) clearTimeout(timer)
      timer = undefined
      const trimmed = raw.trim()
      if (!shouldResolveHandleInput(trimmed)) return
      const myGen = ++gen
      timer = setTimeout(() => {
        timer = undefined
        void resolveHandle(trimmed)
          .then((resolved) => {
            if (myGen !== gen) return
            handlers.onResolved(resolved)
          })
          .catch((err) => {
            if (myGen !== gen) return
            handlers.onError(err instanceof Error ? err : new Error(String(err)))
          })
      }, debounceMs)
    },
  }
}

/** The resolve host answered that no live binding exists; distinct from being unreachable. */
export class HandleNotFoundError extends Error {
  constructor(display: string) {
    super(`Handle ${display} not found`)
    this.name = 'HandleNotFoundError'
  }
}

export async function resolveHandle(
  raw: string,
  baseUrl = DEFAULT_METANET_HANDLES_BASE_URL,
): Promise<ResolvedHandle> {
  const parsed = parseHandleInput(raw)
  if (!parsed) throw new Error('Not a handle')
  const base = normalizeBase(baseUrl)

  const url = `${base}/.well-known/metanet-handles/resolve?handle=${encodeURIComponent(parsed.handle)}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (res.status === 404 || res.status === 410) {
    throw new HandleNotFoundError(formatHandCashHandle(parsed.handle, parsed.domain))
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 120)
    throw new Error(`Handle resolve failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = (await res.json()) as ResolveRow
  if (!data.handle || !data.identityKey || !data.domain) {
    throw new Error('Invalid resolve response')
  }
  // The host answers for its own namespace only: a key for another handle, or
  // for `alice` when `alice@other.domain` was asked, would pay a stranger.
  if (data.handle.toLowerCase() !== parsed.handle) {
    throw new Error('Resolve answered for a different handle')
  }
  if (parsed.domain && data.domain.toLowerCase() !== parsed.domain) {
    throw new Error(
      `Handles on ${parsed.domain} are not served by this resolver (it serves ${data.domain.toLowerCase()})`,
    )
  }
  return certifiedHandle(data)
}

/**
 * Reverse lookup — identity key → claimed handle(s).
 *
 * Not in BRC-169 proper (spec is handle→key only). HandCash hosts it on
 * resolve `?identityKey=` and search `?q=<identityKey>` so apps that already
 * hold a proven key (Free Radio) can learn the bound handle silently.
 */
export async function resolveHandleByIdentityKey(
  identityKey: string,
  baseUrl = DEFAULT_METANET_HANDLES_BASE_URL,
): Promise<ResolvedHandle[]> {
  const key = identityKey.trim().toLowerCase()
  if (!/^(02|03)[0-9a-f]{64}$/.test(key)) {
    throw new Error('Not an identity key')
  }
  const base = normalizeBase(baseUrl)

  const url = `${base}/.well-known/metanet-handles/resolve?identityKey=${encodeURIComponent(key)}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (res.status === 404) return []
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 120)
    throw new Error(`Handle reverse resolve failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = (await res.json()) as ResolveRow & { handles?: ResolveRow[] }

  const rows = Array.isArray(data.handles)
    ? data.handles
    : data.handle
      ? [data]
      : []

  // A handle bound to some other key, or without a valid certificate, is not this key's handle.
  const settled = await Promise.allSettled(
    rows
      .filter((r) => r.handle && r.identityKey && r.domain && r.identityKey.toLowerCase() === key)
      .map((r) => certifiedHandle(r, data.protocols)),
  )
  return settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
}

export async function claimHandle(args: {
  handle: string
  identityKey: string
  /** Short-lived ticket from HandCash (items-market) — required in production. */
  claimTicket?: string
  baseUrl?: string
}): Promise<{ display: string; certificate: HandleCertificate; walletCertificate: unknown }> {
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
  const data = (await res.json()) as ResolveRow & { display?: string }
  const certified = await certifiedHandle({
    ...data,
    handle: data.handle ?? args.handle,
    identityKey: data.identityKey ?? args.identityKey,
    domain: data.domain ?? 'handcash.io',
  })
  if (certified.identityKey !== args.identityKey.toLowerCase()) {
    throw new Error('Handle claim answered for a different identity key')
  }
  return {
    display: data.display || certified.display,
    certificate: certified.certificate,
    walletCertificate: certified.walletCertificate,
  }
}
