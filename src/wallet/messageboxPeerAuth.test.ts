import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Peer,
  PrivateKey,
  ProtoWallet,
  SessionManager,
  Utils,
  normalizeBRC100ByteFields,
  snapshotAuthMessage,
  stringifyBRC100,
  type AuthMessage,
  type RequestedCertificateSet,
  type Transport,
} from '@bsv/sdk'

vi.mock('./diagnosticLog', () => ({ logDiag: vi.fn() }))

import { logDiag } from './diagnosticLog'
import { MessageboxPeerRefused, messageboxPeerFetch, resetMessageboxPeerAuth } from './messageboxPeerAuth'

const { Reader, Writer, toArray, toBase64, toHex } = Utils

const ORIGIN = 'https://mb.peer.example'
const SEND_URL = `${ORIGIN}/v1/messagebox/sendMessage`

class OneShotTransport implements Transport {
  sent: AuthMessage[] = []
  callback?: (message: AuthMessage) => Promise<void>
  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.callback = callback
  }
  async send(message: AuthMessage): Promise<void> {
    this.sent.push(message)
  }
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<number[]> {
  if (body == null) return []
  if (typeof body === 'string') return Array.from(new TextEncoder().encode(body))
  if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  if (Array.isArray(body)) return body as number[]
  return Array.from(new Uint8Array(await new Response(body).arrayBuffer()))
}

function writeOptionalText(writer: InstanceType<typeof Writer>, value: string): void {
  if (value.length === 0) {
    writer.writeVarIntNum(-1)
    return
  }
  const bytes = toArray(value, 'utf8')
  writer.writeVarIntNum(bytes.length)
  writer.write(bytes)
}

function writeHeaderPair(writer: InstanceType<typeof Writer>, key: string, value: string): void {
  const keyBytes = toArray(key, 'utf8')
  writer.writeVarIntNum(keyBytes.length)
  writer.write(keyBytes)
  const valueBytes = toArray(value, 'utf8')
  writer.writeVarIntNum(valueBytes.length)
  writer.write(valueBytes)
}

function flipped(signature: number[]): number[] {
  const copy = [...signature]
  copy[copy.length - 1] ^= 1
  return copy
}

/** The general message AuthFetch signed for this HTTP request (BRC-104 § general messages). */
function generalMessage(method: string, url: URL, headers: Headers, body: number[]) {
  const requestId = headers.get('x-bsv-auth-request-id')!
  const writer = new Writer()
  writer.write(toArray(requestId, 'base64'))
  writer.writeVarIntNum(method.length)
  writer.write(toArray(method, 'utf8'))
  writeOptionalText(writer, url.pathname)
  writeOptionalText(writer, url.search)
  const included: [string, string][] = []
  headers.forEach((value, rawKey) => {
    const key = rawKey.toLowerCase()
    if ((key.startsWith('x-bsv-') || key === 'content-type' || key === 'authorization') && !key.startsWith('x-bsv-auth')) {
      included.push([key, key === 'content-type' ? value.split(';')[0].trim() : value])
    }
  })
  included.sort(([a], [b]) => a.localeCompare(b))
  writer.writeVarIntNum(included.length)
  for (const [key, value] of included) writeHeaderPair(writer, key, value)
  if (body.length === 0) writer.writeVarIntNum(-1)
  else {
    writer.writeVarIntNum(body.length)
    writer.write(body)
  }
  const message = {
    messageType: 'general',
    version: headers.get('x-bsv-auth-version')!,
    identityKey: headers.get('x-bsv-auth-identity-key')!,
    nonce: headers.get('x-bsv-auth-nonce')!,
    yourNonce: headers.get('x-bsv-auth-your-nonce')!,
    payload: writer.toArray(),
    signature: toArray(headers.get('x-bsv-auth-signature')!, 'hex'),
  } as AuthMessage
  return { requestId, message }
}

function responsePayload(requestId: string, status: number, body: number[]): number[] {
  const writer = new Writer()
  writer.write(toArray(requestId, 'base64'))
  writer.writeVarIntNum(status)
  writer.writeVarIntNum(0)
  writer.writeVarIntNum(body.length)
  writer.write(body)
  return writer.toArray()
}

type BoxOptions = {
  tamperHandshake?: boolean
  tamperResponse?: boolean
  requestCertificates?: RequestedCertificateSet
}

/** A messagebox serving BRC-104, the server half ported from BRC-CLOUD's wallet-storage worker. */
function brc104Box(options: BoxOptions = {}) {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const sessions = new SessionManager()
  const handled: { identityKey: string; body: string }[] = []
  const certificatesSent: unknown[][] = []
  const makePeer = () => {
    const transport = new OneShotTransport()
    return { transport, peer: new Peer(wallet, transport, options.requestCertificates, sessions) }
  }

  async function handshake(text: string): Promise<Response> {
    const message = snapshotAuthMessage(
      normalizeBRC100ByteFields(JSON.parse(text), ['payload', 'signature']),
    ) as AuthMessage
    const { peer, transport } = makePeer()
    await peer.ready
    if (message.messageType === 'certificateResponse') certificatesSent.push(message.certificates ?? [])
    try {
      await transport.callback!(message)
    } catch {
      return new Response('{}', { status: 401 })
    }
    if (message.messageType !== 'initialRequest') return new Response('{}', { status: 200 })
    const found = transport.sent.find((m) => m.yourNonce === message.initialNonce)!
    const reply = options.tamperHandshake ? { ...found, signature: flipped(found.signature!) } : found
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-bsv-auth-version': reply.version,
      'x-bsv-auth-message-type': reply.messageType,
      'x-bsv-auth-identity-key': reply.identityKey,
      'x-bsv-auth-nonce': reply.nonce!,
      'x-bsv-auth-your-nonce': reply.yourNonce!,
      'x-bsv-auth-signature': toHex(reply.signature!),
    }
    return new Response(stringifyBRC100(reply), { status: 200, headers })
  }

  async function authenticated(method: string, url: URL, headers: Headers, body: number[]): Promise<Response> {
    const { requestId, message } = generalMessage(method, url, headers, body)
    const { peer, transport } = makePeer()
    await peer.ready
    let verified: string | undefined
    const listener = peer.listenForGeneralMessages((sender, payload) => {
      if (toBase64(new Reader(payload).read(32)) === requestId) verified = sender
    })
    try {
      await transport.callback!(message)
    } catch {
      return new Response('{}', { status: 401 })
    } finally {
      peer.stopListeningForGeneralMessages(listener)
    }
    if (!verified) return new Response('{}', { status: 401 })
    handled.push({ identityKey: verified, body: new TextDecoder().decode(new Uint8Array(body)) })
    const reply = toArray(JSON.stringify({ status: 'success' }), 'utf8')
    await peer.toPeer(responsePayload(requestId, 200, reply), message.yourNonce)
    const signed = transport.sent.find((m) => m.messageType === 'general')!
    const signature = options.tamperResponse ? flipped(signed.signature!) : signed.signature!
    return new Response(new Uint8Array(reply), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-bsv-auth-version': signed.version,
        'x-bsv-auth-identity-key': signed.identityKey,
        'x-bsv-auth-nonce': signed.nonce!,
        'x-bsv-auth-your-nonce': signed.yourNonce!,
        'x-bsv-auth-signature': toHex(signature),
        'x-bsv-auth-request-id': requestId,
      },
    })
  }

  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    const body = await bodyBytes(init.body)
    if (url.pathname === '/.well-known/auth') return handshake(new TextDecoder().decode(new Uint8Array(body)))
    if (headers.has('x-bsv-auth-request-id')) return authenticated(init.method ?? 'GET', url, headers, body)
    return new Response(JSON.stringify({ status: 'error' }), { status: 401 })
  })

  const calls = (path: string) => fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === path).length

  return { fetch, calls, handled, certificatesSent }
}

function sendInit(extra: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-BRC33-Identity': 'interim',
      ...extra,
    }),
    body: JSON.stringify({ message: { recipient: 'peer', messageBox: 'inbox', body: 'sealed' } }),
  }
}

describe('messageboxPeerFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(logDiag).mockClear()
    resetMessageboxPeerAuth()
  })

  it('sends requests as signed BRC-103 general messages to a box that completes the handshake', async () => {
    const box = brc104Box()
    vi.stubGlobal('fetch', box.fetch)
    const root = PrivateKey.fromRandom()
    const interim = vi.fn(async () => new Response('interim'))

    const first = await messageboxPeerFetch(root.toHex(), SEND_URL, sendInit(), interim)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ status: 'success' })
    expect(box.handled[0]?.identityKey).toBe(root.toPublicKey().toString())
    expect(JSON.parse(box.handled[0]!.body).message.recipient).toBe('peer')

    const handshakes = box.calls('/.well-known/auth')
    await messageboxPeerFetch(root.toHex(), SEND_URL, sendInit(), interim)
    expect(box.calls('/.well-known/auth')).toBe(handshakes)
    expect(box.handled).toHaveLength(2)
    expect(interim).not.toHaveBeenCalled()
  })

  it('refuses a box whose handshake signature does not verify, before sending the request', async () => {
    const box = brc104Box({ tamperHandshake: true })
    vi.stubGlobal('fetch', box.fetch)
    const interim = vi.fn(async () => new Response('interim'))

    await expect(
      messageboxPeerFetch(PrivateKey.fromRandom().toHex(), SEND_URL, sendInit(), interim),
    ).rejects.toBeInstanceOf(MessageboxPeerRefused)
    expect(box.calls('/v1/messagebox/sendMessage')).toBe(0)
    expect(box.handled).toHaveLength(0)
    expect(interim).not.toHaveBeenCalled()
  })

  it('refuses a response whose signature does not verify', async () => {
    const box = brc104Box({ tamperResponse: true })
    vi.stubGlobal('fetch', box.fetch)
    const interim = vi.fn(async () => new Response('interim'))

    await expect(
      messageboxPeerFetch(PrivateKey.fromRandom().toHex(), SEND_URL, sendInit(), interim),
    ).rejects.toBeInstanceOf(MessageboxPeerRefused)
    expect(interim).not.toHaveBeenCalled()
  })

  it('never downgrades a box that passed the handshake to the interim proof', async () => {
    const box = brc104Box()
    vi.stubGlobal('fetch', box.fetch)
    const root = PrivateKey.fromRandom()
    const interim = vi.fn(async () => new Response('interim'))
    await messageboxPeerFetch(root.toHex(), SEND_URL, sendInit(), interim)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    await expect(
      messageboxPeerFetch(root.toHex(), SEND_URL, sendInit(), interim),
    ).rejects.toBeInstanceOf(MessageboxPeerRefused)
    expect(interim).not.toHaveBeenCalled()
  })

  it('keeps the interim proof for a box without BRC-104 and probes it once', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname === '/.well-known/auth'
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify({ status: 'success' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const root = PrivateKey.fromRandom()
    const interim = vi.fn(async () => new Response('interim'))

    expect(await (await messageboxPeerFetch(root.toHex(), SEND_URL, sendInit(), interim)).text()).toBe('interim')
    expect(await (await messageboxPeerFetch(root.toHex(), SEND_URL, sendInit(), interim)).text()).toBe('interim')
    expect(interim).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a box that asks for certificates, revealing none', async () => {
    const box = brc104Box({
      requestCertificates: {
        certifiers: [PrivateKey.fromRandom().toPublicKey().toString()],
        types: { [toBase64(new Array(32).fill(7))]: ['email'] },
      },
    })
    vi.stubGlobal('fetch', box.fetch)
    const interim = vi.fn(async () => new Response('interim'))

    await expect(
      messageboxPeerFetch(PrivateKey.fromRandom().toHex(), SEND_URL, sendInit(), interim),
    ).rejects.toBeInstanceOf(MessageboxPeerRefused)
    expect(box.certificatesSent).toHaveLength(0)
    expect(box.handled).toHaveLength(0)
    expect(interim).not.toHaveBeenCalled()
    expect(logDiag).toHaveBeenCalledWith('messagebox', 'warn', 'BRC-104 box asked for certificates', { origin: ORIGIN })
  })

  it('keeps requests the session cannot sign, and BRC-CLOUD, on the interim proof', async () => {
    const fetchMock = vi.fn(async () => new Response('unexpected'))
    vi.stubGlobal('fetch', fetchMock)
    const root = PrivateKey.fromRandom().toHex()
    const interim = vi.fn(async () => new Response('interim'))

    await messageboxPeerFetch(root, `${ORIGIN}/v1/messagebox/files`, sendInit({ 'X-HandCash-Recipient': 'peer' }), interim)
    await messageboxPeerFetch(root, 'https://brc-cloud.bcryderman.workers.dev/v1/messagebox/sendMessage', sendInit(), interim)
    await messageboxPeerFetch(root, '/v1/messagebox/sendMessage', sendInit(), interim)
    expect(interim).toHaveBeenCalledTimes(3)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
