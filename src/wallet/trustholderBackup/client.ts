/**
 * HTTP client for BRC-CLOUD trustholders (HandCash / Haste).
 * Wire: GET /info, POST /auth/start|complete, GET|PUT|DELETE /share
 */
import type {
  TrustholderAuthStart,
  TrustholderErrorBody,
  TrustholderInfo,
} from './types'

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

export class TrustholderHttpError extends Error {
  status: number
  code: string
  portal?: string

  constructor(status: number, body: TrustholderErrorBody) {
    super(body.message || body.error || `Trustholder error ${status}`)
    this.name = 'TrustholderHttpError'
    this.status = status
    this.code = body.error || 'error'
    if (body.portal) this.portal = body.portal
  }
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  const body = await readJson<T & TrustholderErrorBody>(res)
  if (!res.ok) throw new TrustholderHttpError(res.status, body)
  return body
}

export async function fetchTrustholderInfo(baseUrl: string): Promise<TrustholderInfo> {
  const res = await fetch(`${normalizeBase(baseUrl)}/info`)
  const data = await parseOrThrow<TrustholderInfo>(res)
  return {
    ...data,
    authMethods: Array.isArray(data.authMethods) ? data.authMethods : [],
  }
}

export async function startEmailOtpAuth(
  baseUrl: string,
  email: string,
): Promise<TrustholderAuthStart> {
  const res = await fetch(`${normalizeBase(baseUrl)}/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'email-otp',
      params: { email: email.trim() },
    }),
  })
  return parseOrThrow(res)
}

export async function startDevTokenAuth(baseUrl: string): Promise<TrustholderAuthStart> {
  const res = await fetch(`${normalizeBase(baseUrl)}/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'dev-token' }),
  })
  return parseOrThrow(res)
}

export async function completeAuth(
  baseUrl: string,
  requestId: string,
  code?: string,
): Promise<{ token: string; expiresInSec: number }> {
  const body: Record<string, unknown> = { requestId }
  if (code?.trim()) body.response = { code: code.trim() }
  const res = await fetch(`${normalizeBase(baseUrl)}/auth/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseOrThrow(res)
}

export async function depositShare(
  baseUrl: string,
  token: string,
  share: string,
): Promise<{ ok: true }> {
  const res = await fetch(`${normalizeBase(baseUrl)}/share`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ share: share.trim() }),
  })
  return parseOrThrow(res)
}

export async function retrieveShare(
  baseUrl: string,
  token: string,
): Promise<{ share: string; enrolledAt?: string }> {
  const res = await fetch(`${normalizeBase(baseUrl)}/share`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  })
  return parseOrThrow(res)
}

export async function deleteShare(baseUrl: string, token: string): Promise<{ ok: true }> {
  const res = await fetch(`${normalizeBase(baseUrl)}/share`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  return parseOrThrow(res)
}
