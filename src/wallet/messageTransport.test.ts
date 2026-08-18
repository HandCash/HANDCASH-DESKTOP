import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  decodeMessageBody,
  defaultMessageboxBase,
  deliverOutbound,
  encodeMessageBody,
  isMessageboxFileUrl,
  normalizeMessageboxBase,
  notifyPeerBrc29Payment,
  notifyPeerItemIncoming,
  uploadMessageboxBytes,
  withOptionalBeefB64,
} from './messageTransport'

describe('message transport envelopes', () => {
  it('leaves plain text readable by older clients', () => {
    expect(encodeMessageBody({ kind: 'text', text: 'hello' })).toBe('hello')
    expect(decodeMessageBody('hello')).toEqual({ kind: 'text', text: 'hello' })
  })

  it('round-trips tagged BSV-21 settle metadata', () => {
    const tokenId = `${'ab'.repeat(32)}_0`
    const decoded = decodeMessageBody(
      encodeMessageBody({
        kind: 'tip',
        text: 'Sent you TST',
        meta: {
          txid: 'cd'.repeat(32),
          item: true,
          asset: {
            kind: 'fungible',
            tokenId,
            amount: '125',
            sym: 'TST',
            dec: 2,
          },
        },
      }),
    )
    expect(decoded.meta?.item).toBe(true)
    expect(decoded.meta?.asset).toEqual({
      kind: 'fungible',
      tokenId,
      amount: '125',
      sym: 'TST',
      dec: 2,
    })
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

  it('round-trips a soft-latch item settle flag', () => {
    const decoded = decodeMessageBody(
      encodeMessageBody({
        kind: 'tip',
        text: 'Sent you Fox',
        meta: { sats: 1, txid: 'e'.repeat(64), item: true },
      }),
    )
    expect(decoded.meta?.item).toBe(true)
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

  it('uploads BEEF as raw bytes with Content-Length (not a File body)', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const root = PrivateKey.fromRandom()
    const recipient = '02' + 'ab'.repeat(32)
    const bytes = new Uint8Array([1, 2, 3, 4])
    let body: unknown
    let headers: Headers | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body
        headers = new Headers(init?.headers)
        return new Response(
          JSON.stringify({
            status: 'success',
            file: {
              id: 'a'.repeat(48),
              name: 'item.beef',
              contentType: 'application/octet-stream',
              size: 4,
              url: 'https://brc-cloud.bcryderman.workers.dev/v1/messagebox/files/02ab/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
              expiresAt: Date.now() + 1000,
            },
          }),
          { status: 200 },
        )
      }),
    )

    const file = await uploadMessageboxBytes({
      bytes,
      filename: 'item.beef',
      recipientIdentityKey: recipient,
      senderIdentityKey: root.toPublicKey().toString(),
      rootKeyHex: root.toHex(),
      messagebox: 'https://mb.peer.example/v1/messagebox',
    })

    expect(file.name).toBe('item.beef')
    expect(body).toBeInstanceOf(Blob)
    expect(body).not.toBeInstanceOf(File)
    expect(headers?.get('Content-Type')).toBe('application/octet-stream')
    expect(await (body as Blob).arrayBuffer().then((b) => [...new Uint8Array(b)])).toEqual([
      1, 2, 3, 4,
    ])
  })

  it('inlines small Atomic BEEF in sendMessage (no /files)', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const root = PrivateKey.fromRandom()
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      }),
    )

    const result = await notifyPeerItemIncoming({
      recipientIdentityKey: '02' + 'ab'.repeat(32),
      rootKeyHex: root.toHex(),
      senderIdentityKey: root.toPublicKey().toString(),
      txid: 'a'.repeat(64),
      itemName: 'Test',
      atomicBeef: [1, 2, 3],
    })

    expect(result).toEqual({ delivered: 'cloud', beefInBox: true })
    expect(urls.some((u) => u.includes('/files'))).toBe(false)
    expect(urls.some((u) => u.includes('/sendMessage'))).toBe(true)
  })

  it('omits inline BEEF when it would exceed the sendMessage cap', async () => {
    const base = encodeMessageBody({
      kind: 'pay-sent',
      text: 'Pay',
      meta: {
        txid: 'a'.repeat(64),
        brc29: { derivationPrefix: 'pre', derivationSuffix: 'suf', outputIndex: 0 },
      },
    })
    const huge = Array.from({ length: 20_000 }, (_, i) => i % 256)
    expect(withOptionalBeefB64(base, huge)).toEqual({ body: base, beefInBox: false })
    expect(withOptionalBeefB64(base, [1, 2, 3]).beefInBox).toBe(true)
  })

  it('still delivers remittance when inline BEEF does not fit', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const root = PrivateKey.fromRandom()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'success' }), { status: 200 })),
    )
    const huge = Array.from({ length: 20_000 }, (_, i) => i % 256)
    const result = await notifyPeerBrc29Payment({
      recipientIdentityKey: '02' + 'ab'.repeat(32),
      rootKeyHex: root.toHex(),
      senderIdentityKey: root.toPublicKey().toString(),
      txid: 'a'.repeat(64),
      satoshis: 1000,
      remittance: {
        derivationPrefix: 'pre',
        derivationSuffix: 'suf',
        outputIndex: 0,
      },
      atomicBeef: huge,
    })
    expect(result).toEqual({ delivered: 'cloud', beefInBox: false })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
