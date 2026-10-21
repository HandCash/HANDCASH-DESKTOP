/** BRC-CLOUD sign-in relay: `/v1/signin/*`. */
import { signedIdentityFetch } from '../identityRequestAuth'
import { DEFAULT_BRC_CLOUD_BASE_URL } from '../walletConfig'

export const SIGNIN_SCOPE = 'device-signin'

export type SigninState =
  | 'open'
  | 'challenged'
  | 'revealed'
  | 'sent'
  | 'received'
  | 'refused'
  | 'expired'

export type SigninCode = { requestId: string; expiresInSec: number; devCode?: string }

export type SigninStart = {
  binding: string
  expiresAt: number
  online: number
  devices: Array<{ label: string; lastSeen: number }>
}

export type SigninStatus = {
  state: SigninState
  rB: string | null
  sealedVault: string | null
  approverLabel: string | null
  expiresAt: number
}

export type SigninRequest = {
  binding: string
  state: SigninState
  label: string
  location: string
  loginKey: string
  commitment: string
  rB: string | null
  rA: string | null
  deviceId: string | null
  approverLabel: string | null
  createdAt: number
  expiresAt: number
}

export class SigninError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'SigninError'
  }
}

const url = (path: string) => `${DEFAULT_BRC_CLOUD_BASE_URL}${path}`

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new SigninError(String(body.error ?? `http-${res.status}`), res.status, body)
  return body as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => parse<T>(res))
}

function signed<T>(
  keyHex: string,
  path: string,
  init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'POST'
  const hasBody = method !== 'GET'
  return signedIdentityFetch(keyHex, SIGNIN_SCOPE, url(path), {
    method,
    headers: hasBody
      ? { 'Content-Type': 'application/json', Accept: 'application/json' }
      : { Accept: 'application/json' },
    ...(hasBody ? { body: JSON.stringify(init.body ?? {}) } : {}),
  }).then((res) => parse<T>(res))
}

export function requestSigninCode(email: string, purpose: 'signin' | 'register'): Promise<SigninCode> {
  return post('/v1/signin/code', { email, purpose })
}

export function openSigninRequest(args: {
  requestId: string
  code: string
  loginKey: string
  commitment: string
  label: string
}): Promise<SigninStart> {
  return post('/v1/signin/request', args)
}

export function readSigninStatus(loginKeyHex: string, binding: string): Promise<SigninStatus> {
  return signed(loginKeyHex, `/v1/signin/status?binding=${encodeURIComponent(binding)}`, { method: 'GET' })
}

export function revealSignin(loginKeyHex: string, binding: string, rA: string): Promise<{ ok: true }> {
  return signed(loginKeyHex, '/v1/signin/reveal', { body: { binding, rA } })
}

export function confirmSigninReceived(loginKeyHex: string, binding: string): Promise<{ ok: true }> {
  return signed(loginKeyHex, '/v1/signin/received', { body: { binding } })
}

export function registerSigninEmail(
  walletKeyHex: string,
  requestId: string,
  code: string,
): Promise<{ ok: true; email: string }> {
  return signed(walletKeyHex, '/v1/signin/account', { body: { requestId, code } })
}

export function removeSigninEmail(walletKeyHex: string): Promise<{ ok: true }> {
  return signed(walletKeyHex, '/v1/signin/account', { method: 'DELETE' })
}

export function reportSigninPresence(
  walletKeyHex: string,
  deviceId: string,
  label: string,
  state: 'active' | 'signedOut',
): Promise<{ ok: true }> {
  return signed(walletKeyHex, '/v1/signin/presence', { body: { deviceId, label, state } })
}

export function listSigninRequests(
  walletKeyHex: string,
): Promise<{ registered: boolean; requests: SigninRequest[] }> {
  return signed(walletKeyHex, '/v1/signin/pending', { method: 'GET' })
}

export function challengeSignin(
  walletKeyHex: string,
  binding: string,
  rB: string,
  deviceId: string,
): Promise<{ ok: true }> {
  return signed(walletKeyHex, '/v1/signin/challenge', { body: { binding, rB, deviceId } })
}

export function completeSignin(
  walletKeyHex: string,
  binding: string,
  deviceId: string,
  sealedVault: string,
): Promise<{ ok: true }> {
  return signed(walletKeyHex, '/v1/signin/complete', { body: { binding, deviceId, sealedVault } })
}

export function refuseSignin(walletKeyHex: string, binding: string): Promise<{ ok: true }> {
  return signed(walletKeyHex, '/v1/signin/refuse', { body: { binding } })
}

/** Plain words for a relay refusal, naming what it waits on. */
export function signinErrorText(error: unknown): string {
  if (!(error instanceof SigninError)) {
    return error instanceof Error ? error.message : String(error)
  }
  switch (error.code) {
    case 'invalid-code':
      return 'That code is wrong. Check the latest email and try again.'
    case 'expired-or-unknown-request':
    case 'expired-or-used-request':
      return 'That code expired or was used up. Send a new one.'
    case 'no-wallet-for-email':
      return 'No HandCash wallet uses this email for sign-in.'
    case 'signin-open':
      return 'A sign-in for this wallet is already waiting. Finish it on your device or wait 10 minutes.'
    case 'signin-locked':
      return `Sign-in is paused until ${new Date(Number(error.detail.until)).toLocaleString()} after repeated refused requests.`
    case 'signin-rate-limit':
    case 'Too many sign-in requests; try again later':
      return 'Too many attempts from here. Try again in an hour.'
    case 'invalid-email':
      return 'Enter a valid email address.'
    default:
      return `Sign-in failed (${error.code}).`
  }
}
