import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  decodeMessageBody,
  defaultMessageboxBase,
  deliverOutbound,
  encodeMessageBody,
  isMessageboxFileUrl,
  normalizeMessageboxBase,
} from './messageTransport'

describe('message transport envelopes', () => {
  it('leaves plain text readable by older clients', () => {
    expect(encodeMessageBody({ kind: 'text', text: 'hello' })).toBe('hello')
    expect(decodeMessageBody('hello')).toEqual({ kind: 'text', text: 'hello' })
  })

  it('round-trips a sub-cent tip as a semantic card', () => {
    const decoded = decodeMessageBody(
      encodeMessageBody({
        kind: 'tip',
        text: 'Tiny but real',
        meta: { sats: 1, amountLabel: '1 sat', txid: 'a'.repeat(64) },
      }),
    )
    expect(decoded).toMatchObject({
      kind: 'tip',
      text: 'Tiny but real',
      meta: { sats: 1, amountLabel: '1 sat', txid: 'a'.repeat(64) },
    })
  })

  it('round-trips BRC-29 remittance on tip cards', () => {
    const brc29 = {
      derivationPrefix: 'pre==',
      derivationSuffix: 'suf==',
      outputIndex: 0,
    }
    const decoded = decodeMessageBody(
      encodeMessageBody({
        kind: 'tip',
        text: 'Tip',
        meta: { sats: 100, txid: 'd'.repeat(64), brc29 },
      }),
    )
    expect(decoded.meta?.brc29).toEqual(brc29)
  })

  it('round-trips a validated attachment without private payment metadata', () => {
    const attachment = {
      id: 'file-id',
      name: 'receipt.pdf',
      contentType: 'application/pdf',
      size: 1234,
      url: 'https://brc-cloud.bcryderman.workers.dev/v1/messagebox/files/key',
      expiresAt: Date.now() + 1_000,
    }
    expect(
      decodeMessageBody(
        encodeMessageBody({
          kind: 'file',
          text: attachment.name,
          meta: { attachment, to: 'must-not-leak' },
        }),
      ),
    ).toMatchObject({ kind: 'file', meta: { attachment } })
  })

  it('accepts federated messagebox file hosts', () => {
    const attachment = {
      id: 'file-id',
      name: 'photo.png',
      contentType: 'image/png',
      size: 99,
      url: 'https://mb.other.example/v1/messagebox/files/02ab/deadbeef',
    }
    expect(isMessageboxFileUrl(attachment.url)).toBe(true)
    expect(
      decodeMessageBody(
        encodeMessageBody({
          kind: 'file',
          text: attachment.name,
          meta: { attachment },
        }),
      ).kind,
    ).toBe('file')
  })

  it('rejects foreign attachment hosts', () => {
    expect(
      decodeMessageBody(
        `handcash-message:${JSON.stringify({
          version: 1,
          kind: 'file',
          text: 'bad',
          meta: {
            attachment: {
              id: 'x',
              name: 'bad.pdf',
              contentType: 'application/pdf',
              size: 1,
              url: 'https://evil.example/steal',
            },
          },
        })}`,
      ),
    ).toEqual({ kind: 'text', text: 'Unsupported file attachment' })
  })

  it('degrades malformed or unsafe envelopes to text', () => {
    expect(
      decodeMessageBody(
        `handcash-message:${JSON.stringify({
          version: 1,
          kind: 'file',
          text: 'bad',
          meta: {
            attachment: {
              id: 'x',
              name: 'bad',
              contentType: 'text/html',
              size: 1,
              url: 'javascript:alert(1)',
            },
          },
        })}`,
      ),
    ).toEqual({ kind: 'text', text: 'Unsupported file attachment' })
  })
})

describe('messagebox base URL', () => {
  it('defaults to the HandCash BRC-CLOUD convenience box', () => {
    expect(defaultMessageboxBase()).toMatch(/\/v1\/messagebox$/)
    expect(normalizeMessageboxBase(null)).toBe(defaultMessageboxBase())
    expect(normalizeMessageboxBase('')).toBe(defaultMessageboxBase())
  })

  it('preserves a resolved peer messagebox URL', () => {
    expect(normalizeMessageboxBase('https://mb.peer.example/v1/messagebox/')).toBe(
      'https://mb.peer.example/v1/messagebox',
    )
  })

  it('posts deliverOutbound to a non-default messagebox base', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const root = PrivateKey.fromRandom()
    const calls: { url: string; headers: Headers; body: string }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body || ''),
      })
      return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await deliverOutbound({
      recipientIdentityKey: '02' + 'ab'.repeat(32),
      senderIdentityKey: root.toPublicKey().toString(),
      rootKeyHex: root.toHex(),
      body: 'hello federation',
      peerId: 'peer-1',
      messagebox: 'https://mb.peer.example/v1/messagebox',
    })

    expect(result).toEqual({
      delivered: 'cloud',
      messagebox: 'https://mb.peer.example/v1/messagebox',
    })
    expect(calls[0]?.url).toBe('https://mb.peer.example/v1/messagebox/sendMessage')
    expect(calls[0]?.headers.get('X-BRC33-Identity')).toBe(
      root.toPublicKey().toString().toLowerCase(),
    )
    expect(calls[0]?.headers.get('X-BRC33-Signature')).toMatch(/^[0-9a-f]{128}$/i)
    expect(JSON.parse(calls[0]!.body).message).toMatchObject({
      recipient: '02' + 'ab'.repeat(32),
      messageBox: 'inbox',
      body: 'hello federation',
    })
    expect(JSON.parse(calls[0]!.body).message.sender).toBeUndefined()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
