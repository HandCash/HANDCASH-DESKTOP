import { PrivateKey } from '@bsv/sdk'
import { signedHeaders, verifyIdentifier } from './crypto'
import {
  BRC250_HOST,
  type GoogleAttempt,
  type GoogleAttemptStatus,
  type LoginStart,
  type LoginStatus,
} from './types'

export type Brc250Manifest = {
  v: 1
  host: string
  attesterKey: string
  googleClientIds: string[]
  methods: string[]
  recoveryWaitSeconds: number
}

async function responseJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: string
  }
  if (!res.ok) {
    throw new Error(body.error || `BRC-250 host refused (${res.status})`)
  }
  return body
}

export async function fetchBrc250Manifest(
  host = BRC250_HOST,
): Promise<Brc250Manifest> {
  const res = await fetch(`${host}/.well-known/brc250.json`, {
    headers: { Accept: 'application/json' },
  })
  const manifest = await responseJson<Brc250Manifest>(res)
  if (
    manifest.v !== 1 ||
    !/^(02|03)[0-9a-f]{64}$/i.test(manifest.attesterKey) ||
    !manifest.googleClientIds?.length
  ) throw new Error('BRC-250 host manifest is invalid')
  return manifest
}

export async function createGoogleAttempt(args: {
  purpose: 'enroll' | 'login'
  loginKey: string
  commitment: string
  context: string
  host?: string
}): Promise<GoogleAttempt> {
  const host = args.host ?? BRC250_HOST
  const res = await fetch(`${host}/v1/google/attempt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      purpose: args.purpose,
      loginKey: args.loginKey,
      commitment: args.commitment,
      context: args.context,
    }),
  })
  return responseJson<GoogleAttempt>(res)
}

export async function readGoogleAttempt(
  binding: string,
  host = BRC250_HOST,
): Promise<GoogleAttemptStatus> {
  const res = await fetch(
    `${host}/v1/google/status?binding=${encodeURIComponent(binding)}`,
    { headers: { Accept: 'application/json' } },
  )
  return responseJson<GoogleAttemptStatus>(res)
}

export async function verifiedGoogleProof(
  binding: string,
  host = BRC250_HOST,
  expected?: { loginKey: string; commitment: string; purpose: 'enroll' | 'login' },
): Promise<Extract<GoogleAttemptStatus, { state: 'ready' }>['loginProof'] | null> {
  const status = await readGoogleAttempt(binding, host)
  if (status.state !== 'ready') return null
  const manifest = await fetchBrc250Manifest(host)
  const { identifier, idToken } = status.loginProof
  if (
    identifier.binding !== binding ||
    (expected &&
      (identifier.loginKey.toLowerCase() !== expected.loginKey.toLowerCase() ||
        identifier.commitment.toLowerCase() !== expected.commitment.toLowerCase() ||
        identifier.purpose !== expected.purpose)) ||
    identifier.exp < Date.now() ||
    !verifyIdentifier(identifier, manifest.attesterKey)
  ) throw new Error('Google login identifier was not signed by the pinned host')
  await verifyGoogleToken(idToken, {
    binding,
    clientIds: manifest.googleClientIds,
  })
  return status.loginProof
}

export async function signedBrc250Fetch<T>(args: {
  path: string
  key: PrivateKey
  method?: 'GET' | 'POST'
  body?: unknown
  host?: string
}): Promise<T> {
  const host = args.host ?? BRC250_HOST
  const method = args.method ?? 'POST'
  const bodyText = method === 'GET' ? '' : JSON.stringify(args.body ?? {})
  const res = await fetch(`${host}${args.path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...signedHeaders(args.key, method, args.path, bodyText),
    },
    ...(method === 'POST' ? { body: bodyText } : {}),
  })
  return responseJson<T>(res)
}

export function startLoginRequest(
  key: PrivateKey,
  binding: string,
  host = BRC250_HOST,
): Promise<LoginStart> {
  return signedBrc250Fetch({
    host,
    path: '/v1/login/start',
    key,
    body: { binding },
  })
}

export function readLoginStatus(
  key: PrivateKey,
  binding: string,
  host = BRC250_HOST,
): Promise<LoginStatus> {
  const path = `/v1/login/status?binding=${encodeURIComponent(binding)}`
  return signedBrc250Fetch({ host, path, key, method: 'GET' })
}

type Jwt = {
  iss?: string
  aud?: string | string[]
  nonce?: string
  email?: string
  email_verified?: boolean | string
  exp?: number
}

function decodePart(value: string): unknown {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '=',
  )
  return JSON.parse(atob(padded))
}

async function verifyGoogleToken(
  token: string,
  args: { binding: string; clientIds: string[] },
): Promise<Jwt> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Google returned an invalid token')
  const header = decodePart(parts[0]!) as { alg?: string; kid?: string }
  const claims = decodePart(parts[1]!) as Jwt
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (
    header.alg !== 'RS256' ||
    !header.kid ||
    !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss ?? '') ||
    !audiences.some((aud) => aud && args.clientIds.includes(aud)) ||
    claims.nonce !== args.binding ||
    (claims.email_verified !== true && claims.email_verified !== 'true') ||
    !claims.email ||
    !claims.exp ||
    claims.exp * 1000 <= Date.now()
  ) throw new Error('Google token claims do not match this device login')
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs')
  const jwks = (await responseJson<{
    keys: Array<JsonWebKey & { kid?: string }>
  }>(res)).keys
  const jwk = jwks.find((candidate) => candidate.kid === header.kid)
  if (!jwk) throw new Error('Google signing key was not found')
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const signature = Uint8Array.from(
    atob(parts[2]!.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(parts[2]!.length / 4) * 4,
      '=',
    )),
    (ch) => ch.charCodeAt(0),
  )
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  )
  if (!ok) throw new Error('Google token signature is invalid')
  return claims
}

export function googleEmailOf(idToken: string): string {
  const claims = decodePart(idToken.split('.')[1] ?? '') as Jwt
  return claims.email?.trim().toLowerCase() ?? ''
}
