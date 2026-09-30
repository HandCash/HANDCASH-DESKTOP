import { signIdentityText } from './messageboxAuth'

const BOUND_HEADERS = [
  'content-type', 'content-disposition', 'x-handcash-recipient', 'x-brc33-recipient',
  'x-handcash-filename', 'x-brc33-filename', 'x-handcash-exported-at',
  'x-handcash-spendable-sats', 'x-handcash-action-count', 'if-match',
] as const

async function bodyBytes(body?: BodyInit | null): Promise<Uint8Array<ArrayBuffer>> {
  if (body == null) return new Uint8Array()
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  throw new Error('Signed requests require a bounded string, byte buffer, or Blob')
}

export async function signedIdentityHeaders(rootKeyHex: string, scope: string, url: string,
  init: RequestInit = {}, timestamp = Date.now(), nonce?: string): Promise<Headers> {
  const target = new URL(url, typeof location === 'undefined' ? 'https://handcash.invalid' : location.href)
  const headers = new Headers(init.headers)
  if (init.body instanceof Blob && init.body.type && !headers.has('Content-Type')) {
    headers.set('Content-Type', init.body.type)
  }
  const bytes = await bodyBytes(init.body)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const bodyHash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
  const random = crypto.getRandomValues(new Uint8Array(16))
  const requestNonce = nonce ?? Array.from(random, b => b.toString(16).padStart(2, '0')).join('')
  const text = JSON.stringify(['HandCash-request-v1', scope, (init.method || 'GET').toUpperCase(),
    target.pathname + target.search, timestamp, requestNonce, bodyHash,
    BOUND_HEADERS.map(name => [name, headers.get(name) || ''])])
  const proof = signIdentityText(rootKeyHex, text)
  headers.set('X-HandCash-Identity', proof.identityKey)
  headers.set('X-HandCash-Timestamp', String(timestamp))
  headers.set('X-HandCash-Nonce', requestNonce)
  headers.set('X-HandCash-Request-Signature', proof.signature)
  return headers
}

/** Sign the exact final body immediately before each fetch, including retries. */
export async function signedIdentityFetch(rootKeyHex: string, scope: string, url: string,
  init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: await signedIdentityHeaders(rootKeyHex, scope, url, init) })
}
