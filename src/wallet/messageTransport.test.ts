import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  decodeMessageBody,
  decodeMarketSettlementWire,
  defaultMessageboxBase,
  deliverMarketSettlementWire,
  deliverOutbound,
  encodeMessageBody,
  encodeMarketSettlementWire,
  isMessageboxFileUrl,
  normalizeMessageboxBase,
  notifyPeerBrc29Payment,
  notifyPeerItemIncoming,
  publicMessageboxBase,
  uploadMessageboxBytes,
  withOptionalBeefB64,
  withOptionalProvenance,
} from './messageTransport'

describe('message transport envelopes', () => {
  it('round-trips bounded market settlement responses', () => {
    const body = encodeMarketSettlementWire({
      type: 'sign-response',
      saleId: 'sale-1',
      accepted: true,
      unlockingScript: 'ab'.repeat(108),
    })
    expect(decodeMarketSettlementWire(body)).toMatchObject({
      type: 'sign-response',
      saleId: 'sale-1',
      accepted: true,
    })
    expect(() =>
      encodeMarketSettlementWire({
        type: 'receipt',
        saleId: 'sale-2',
        txid: 'ab'.repeat(32),
        atomicBeefB64: 'x'.repeat(16_000),
      }),
    ).toThrow(/body limit/i)
  })

  it('keeps oversized receipts inline and lets the seller fetch BEEF by txid', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const root = PrivateKey.fromRandom()
    const recipient = PrivateKey.fromRandom()
    let sentBody = ''
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        urls.push(url)
        sentBody = String(init?.body ?? '')
        return new Response(JSON.stringify({ status: 'success' }), {
          status: 200,
        })
      }),
    )

    await expect(
      deliverMarketSettlementWire({
        wire: {
          type: 'receipt',
          saleId: 'sale-large',
          txid: 'ab'.repeat(32),
          atomicBeefB64: 'x'.repeat(20_000),
        },
        recipientIdentityKey: recipient.toPublicKey().toString(),
        rootKeyHex: root.toHex(),
        senderIdentityKey: root.toPublicKey().toString(),
        messagebox: 'https://mb.peer.example/v1/messagebox',
      }),
    ).resolves.toBe(true)

    const { openPeerMessage } = await import('./messageEnvelope')
    const outer = JSON.parse(sentBody)
    const opened = openPeerMessage({
      body: outer.message.body,
      rootKeyHex: recipient.toHex(),
    })
    expect('plaintext' in opened && opened.sealed).toBe(true)
    const inner = 'plaintext' in opened ? opened.plaintext : ''
    expect(decodeMarketSettlementWire(inner)).toMatchObject({
      type: 'receipt',
      saleId: 'sale-large',
      txid: 'ab'.repeat(32),
    })
    expect(decodeMarketSettlementWire(inner)).not.toHaveProperty('atomicBeefB64')
    expect(urls.some((url) => url.endsWith('/files'))).toBe(false)
    expect(outer.message.body).not.toContain('sale-large')
    expect(outer.message.body.length).toBeLessThan(16_000)
  })

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

  it('does not expose the retired fungible wire variant', () => {
    const decoded = decodeMessageBody(
      encodeMessageBody({
        kind: 'tip',
        text: 'Historical transfer',
        meta: {
          txid: 'cd'.repeat(32),
          item: true,
          asset: {
            kind: 'fungible',
            tokenId: `${'ab'.repeat(32)}_0`,
            amount: '125',
            sym: 'OLD',
            dec: 0,
          },
        },
      }).replace('"fungible"', '"1sat-ft"'),
    )
    expect(decoded.meta?.item).toBe(true)
    expect(decoded.meta?.asset).toBeUndefined()
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

  it('expands the development proxy route for durable market records', () => {
    expect(publicMessageboxBase('/v1/messagebox')).toBe(
      'https://brc-cloud.bcryderman.workers.dev/v1/messagebox',
    )
    expect(publicMessageboxBase('https://mb.peer.example/v1/messagebox')).toBe(
      'https://mb.peer.example/v1/messagebox',
    )
  })

  it('posts deliverOutbound to a non-default messagebox base', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const { openPeerMessage } = await import('./messageEnvelope')
    const root = PrivateKey.fromRandom()
    const recipient = PrivateKey.fromRandom()
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
      recipientIdentityKey: recipient.toPublicKey().toString(),
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
    expect(calls[0]?.headers.get('X-BRC103-Identity')).toBeNull()
    expect(calls[0]?.headers.get('X-BRC33-Timestamp')).toMatch(/^\d+$/)
    expect(Number(calls[0]?.headers.get('X-BRC33-Timestamp'))).toBeGreaterThan(0)
    expect(calls[0]?.headers.get('X-BRC33-Signature')).toMatch(/^[0-9a-f]{128}$/i)
    const message = JSON.parse(calls[0]!.body).message
    expect(message).toMatchObject({
      recipient: recipient.toPublicKey().toString(),
      messageBox: 'inbox',
    })
    expect(message.body).not.toContain('hello federation')
    expect(
      openPeerMessage({ body: message.body, rootKeyHex: recipient.toHex() }),
    ).toEqual({ plaintext: 'hello federation', sealed: true })
    expect(message.sender).toBeUndefined()
  })

  it('sends sealed chat on a live IPv6 session and skips the box', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const { openPeerMessage } = await import('./messageEnvelope')
    const {
      installDirectSessionPort,
      rememberSessionOffer,
      resetDirectSessions,
      setDirectSessionIdentity,
    } = await import('./directSession/session')
    const { signSessionHello, signSessionOffer, signSessionWelcome } =
      await import('./directSession/protocol')
    const a = PrivateKey.fromRandom()
    const b = PrivateKey.fromRandom()
    const aKey = a.toPublicKey().toString().toLowerCase()
    const bKey = b.toPublicKey().toString().toLowerCase()
    const dialer = aKey < bKey ? a : b
    const acceptor = aKey < bKey ? b : a
    const dialerKey = dialer.toPublicKey().toString().toLowerCase()
    const acceptorKey = acceptor.toPublicKey().toString().toLowerCase()
    setDirectSessionIdentity({ rootKeyHex: dialer.toHex(), identityKey: dialerKey })
    rememberSessionOffer(
      signSessionOffer({
        rootKeyHex: acceptor.toHex(),
        counterparty: dialerKey,
        host: '2001:db8:2::8',
        port: 9,
      }),
    )
    const sent: string[] = []
    installDirectSessionPort({
      listen: async () => null,
      connect: async (args) => {
        const parsed = JSON.parse(args.hello) as ReturnType<typeof signSessionHello>
        const welcome = signSessionWelcome({
          rootKeyHex: acceptor.toHex(),
          hello: parsed,
        })
        return { ok: true, remoteHello: JSON.stringify(welcome), socketId: 'sock' }
      },
      send: async (_id, body) => {
        sent.push(body)
        return true
      },
      close: async () => undefined,
      accept: async () => undefined,
      reject: async () => undefined,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('box must not run')
      }),
    )

    const result = await deliverOutbound({
      recipientIdentityKey: acceptorKey,
      senderIdentityKey: dialerKey,
      rootKeyHex: dialer.toHex(),
      body: 'hello ipv6',
      peerId: 'peer-1',
      messagebox: 'https://mb.peer.example/v1/messagebox',
    })

    expect(result.delivered).toBe('direct')
    expect(sent[0]).not.toContain('hello ipv6')
    expect(openPeerMessage({ body: sent[0]!, rootKeyHex: acceptor.toHex() })).toEqual({
      plaintext: 'hello ipv6',
      sealed: true,
    })
    resetDirectSessions()
    installDirectSessionPort(null)
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
    const recipient = PrivateKey.fromRandom()
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      }),
    )

    const result = await notifyPeerItemIncoming({
      recipientIdentityKey: recipient.toPublicKey().toString(),
      rootKeyHex: root.toHex(),
      senderIdentityKey: root.toPublicKey().toString(),
      txid: 'a'.repeat(64),
      itemName: 'Test',
      atomicBeef: [1, 2, 3],
    })

    expect(result).toEqual({
      delivered: 'cloud',
      beefInBox: true,
      provenanceInBox: false,
    })
    expect(urls.some((u) => u.includes('/files'))).toBe(false)
    expect(urls.some((u) => u.includes('/sendMessage'))).toBe(true)
  })

  it('puts BRC-150 remittance on the item inbox card so the peer can verify', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const { openPeerMessage } = await import('./messageEnvelope')
    const root = PrivateKey.fromRandom()
    const recipientKey = PrivateKey.fromRandom()
    let sentBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = String(init?.body ?? '')
        return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      }),
    )
    const provenance = {
      v: 2 as const,
      origin: `${'aa'.repeat(32)}_0`,
      tip: `${'bb'.repeat(32)}_0`,
      path: [`${'bb'.repeat(32)}_0`, `${'aa'.repeat(32)}_0`],
      beefB64: btoa('beef'),
    }
    const result = await notifyPeerItemIncoming({
      recipientIdentityKey: recipientKey.toPublicKey().toString(),
      rootKeyHex: root.toHex(),
      senderIdentityKey: root.toPublicKey().toString(),
      txid: 'c'.repeat(64),
      itemName: 'Fox',
      itemOutputIndex: 2,
      atomicBeef: [1, 2, 3],
      provenance,
    })
    expect(result.provenanceInBox).toBe(true)
    expect(result.beefInBox).toBe(true)
    const opened = openPeerMessage({
      body: JSON.parse(sentBody).message.body,
      rootKeyHex: recipientKey.toHex(),
    })
    expect('plaintext' in opened).toBe(true)
    const decoded = decodeMessageBody('plaintext' in opened ? opened.plaintext : '')
    expect(decoded.meta?.provenance?.origin).toBe(provenance.origin)
    expect(decoded.meta?.itemOutputIndex).toBe(2)
    expect(withOptionalProvenance(encodeMessageBody({
      kind: 'tip',
      text: 'x',
      meta: { item: true, txid: 'c'.repeat(64) },
    }), provenance).provenanceInBox).toBe(true)
  })

  it('keeps oversized item BEEF off /files and still delivers the inbox card', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const root = PrivateKey.fromRandom()
    const recipientKey = PrivateKey.fromRandom()
    const recipient = recipientKey.toPublicKey().toString()
    const txid = 'a'.repeat(64)
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      }),
    )

    const result = await notifyPeerItemIncoming({
      recipientIdentityKey: recipient,
      rootKeyHex: root.toHex(),
      senderIdentityKey: root.toPublicKey().toString(),
      messagebox: 'https://mb.peer.example/v1/messagebox',
      txid,
      itemName: 'Large proof item',
      atomicBeef: Array.from({ length: 20_000 }, (_, i) => i % 256),
    })

    expect(result).toEqual({
      delivered: 'cloud',
      beefInBox: false,
      provenanceInBox: false,
    })
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
    const recipient = PrivateKey.fromRandom()
    const huge = Array.from({ length: 20_000 }, (_, i) => i % 256)
    const result = await notifyPeerBrc29Payment({
      recipientIdentityKey: recipient.toPublicKey().toString(),
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
    expect(result).toEqual({
      delivered: 'cloud',
      beefInBox: false,
      provenanceInBox: false,
    })
  })
  it('notifyPeerItemIncoming sends X-BRC33 Identity, Timestamp, and Signature', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const root = PrivateKey.fromRandom()
    const recipient = PrivateKey.fromRandom()
    let headers: Headers | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        headers = new Headers(init?.headers)
        return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      }),
    )

    const result = await notifyPeerItemIncoming({
      recipientIdentityKey: recipient.toPublicKey().toString(),
      rootKeyHex: root.toHex(),
      senderIdentityKey: root.toPublicKey().toString(),
      txid: 'a'.repeat(64),
      itemName: 'KING',
      asset: {
        kind: 'fungible',
        tokenId: `${'ab'.repeat(32)}_0`,
        amount: '10',
        sym: 'KING',
        dec: 0,
      },
    })

    expect(result.delivered).toBe('cloud')
    expect(headers?.get('X-BRC33-Identity')).toBe(
      root.toPublicKey().toString().toLowerCase(),
    )
    expect(headers?.get('X-BRC33-Timestamp')).toMatch(/^\d+$/)
    expect(Number(headers?.get('X-BRC33-Timestamp'))).toBeGreaterThan(0)
    expect(headers?.get('X-BRC33-Signature')).toMatch(/^[0-9a-f]{128}$/i)
  })

  it('re-signs a fresh timestamp on each notify retry', async () => {
    const { PrivateKey } = await import('@bsv/sdk')
    const root = PrivateKey.fromRandom()
    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1_000
      return now
    })
    const timestamps: string[] = []
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        timestamps.push(headers.get('X-BRC33-Timestamp') || '')
        n += 1
        if (n < 3) {
          return new Response(
            JSON.stringify({ status: 'error', error: 'auth-timestamp' }),
            { status: 401 },
          )
        }
        return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      }),
    )

    const result = await notifyPeerItemIncoming({
      recipientIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
      rootKeyHex: root.toHex(),
      senderIdentityKey: root.toPublicKey().toString(),
      txid: 'b'.repeat(64),
      itemName: 'KING',
    })

    expect(result.delivered).toBe('cloud')
    expect(timestamps).toHaveLength(3)
    expect(new Set(timestamps).size).toBe(3)
    expect(Number(timestamps[1])).toBeGreaterThan(Number(timestamps[0]))
    expect(Number(timestamps[2])).toBeGreaterThan(Number(timestamps[1]))
  })

})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
