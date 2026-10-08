import { appendAppLog } from './appLog'
import { ifMatchEtag } from './httpEtag'
import { signedIdentityFetch } from './identityRequestAuth'

/**
 * The single `HEAD` on the remote BRC-39 object. Concurrent callers share one
 * request, and a host refusal (5xx, 429, unreachable) holds every caller off
 * until the host's `Retry-After` or an exponential backoff, so no number of
 * pollers can hammer a struggling history host.
 */
export type RemoteBrc39Head =
  | { kind: 'absent' }
  | {
      kind: 'present'
      etag: string | null
      exportedAt: number | null
      bytes: number | null
      spendableSats: number | null
      actionCount: number | null
    }
  /** The host answered and rejected this request (auth, identity, shape). */
  | { kind: 'refused'; status: number; reason: string }
  /** The host could not serve anyone right now; no request leaves before `retryAt`. */
  | { kind: 'unavailable'; status: number | null; retryAt: number; reason: string }

const BACKOFF_FIRST_MS = 30_000
const BACKOFF_MAX_MS = 15 * 60_000
/** A server quota can name tomorrow; re-check sooner in case it was lifted. */
const RETRY_AFTER_MAX_MS = 60 * 60_000

type Hold = { url: string; retryAt: number; status: number | null; reason: string; streak: number }

let hold: Hold | null = null
let inFlight: { url: string; promise: Promise<RemoteBrc39Head> } | null = null

export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

function hostUnavailable(status: number): boolean {
  return status === 429 || status >= 500
}

function optionalInt(res: Response, name: string): number | null {
  const raw = res.headers.get(name)
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

async function reasonOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: string | { code?: string } }
    const code = typeof body.error === 'string' ? body.error : body.error?.code
    if (code) return code
  } catch {
    /* not JSON */
  }
  return text.slice(0, 120) || `HTTP ${res.status}`
}

function heldResult(h: Hold): RemoteBrc39Head {
  return { kind: 'unavailable', status: h.status, retryAt: h.retryAt, reason: h.reason }
}

/**
 * Record a refusal from any request to the history object (the `PUT` included)
 * so the next probe waits instead of re-asking a host that just said no.
 */
export function holdHistoryHost(
  url: string,
  status: number | null,
  retryAfter: string | null,
  reason: string,
  now = Date.now(),
): RemoteBrc39Head {
  const streak = hold?.url === url ? hold.streak + 1 : 1
  const backoff = Math.min(BACKOFF_FIRST_MS * 2 ** (streak - 1), BACKOFF_MAX_MS)
  const asked = retryAfterMs(retryAfter, now)
  const wait = asked == null ? backoff : Math.min(Math.max(asked, BACKOFF_FIRST_MS), RETRY_AFTER_MAX_MS)
  hold = { url, retryAt: now + wait, status, reason, streak }
  appendAppLog(
    'warn',
    `[cloud-backup] history host unavailable (${status ?? 'network'}: ${reason}) — holding ${Math.round(wait / 1000)}s ×${streak}`,
  )
  return heldResult(hold)
}

/** The host just served a request to this object; stop holding probes. */
export function releaseHistoryHost(url: string): void {
  if (hold?.url === url) hold = null
}

async function headOnce(rootKeyHex: string, url: string, accept: string, now: number): Promise<RemoteBrc39Head> {
  let res: Response
  try {
    res = await signedIdentityFetch(rootKeyHex, 'history', url, {
      method: 'HEAD',
      headers: { Accept: accept },
    })
  } catch (err) {
    return holdHistoryHost(url, null, null, err instanceof Error ? err.message : String(err), now)
  }
  if (hostUnavailable(res.status)) {
    return holdHistoryHost(url, res.status, res.headers.get('Retry-After'), await reasonOf(res), now)
  }
  releaseHistoryHost(url)
  if (res.status === 404) return { kind: 'absent' }
  if (!res.ok) return { kind: 'refused', status: res.status, reason: await reasonOf(res) }
  const exported = Number(res.headers.get('X-HandCash-Exported-At') || '')
  const length = res.headers.get('Content-Length')
  return {
    kind: 'present',
    etag: ifMatchEtag(res.headers.get('ETag')),
    exportedAt: Number.isFinite(exported) && exported > 0 ? exported : null,
    bytes: length ? Number(length) : null,
    spendableSats: optionalInt(res, 'X-HandCash-Spendable-Sats'),
    actionCount: optionalInt(res, 'X-HandCash-Action-Count'),
  }
}

export function probeRemoteBrc39(
  rootKeyHex: string,
  url: string,
  accept = 'application/vnd.brc39.wallet, application/octet-stream, */*',
  now = Date.now(),
): Promise<RemoteBrc39Head> {
  if (hold?.url === url && now < hold.retryAt) return Promise.resolve(heldResult(hold))
  if (inFlight?.url === url) return inFlight.promise
  const promise = headOnce(rootKeyHex, url, accept, now).finally(() => {
    if (inFlight?.promise === promise) inFlight = null
  })
  inFlight = { url, promise }
  return promise
}

export function resetHistoryRemoteProbeForTests(): void {
  hold = null
  inFlight = null
}
