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
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await deliverOutbound({
      recipientIdentityKey: '02' + 'ab'.repeat(32),
      senderIdentityKey: '03' + 'cd'.repeat(32),
      body: 'hello federation',
      peerId: 'peer-1',
      messagebox: 'https://mb.peer.example/v1/messagebox',
    })

    expect(result).toEqual({
      delivered: 'cloud',
      messagebox: 'https://mb.peer.example/v1/messagebox',
    })
    expect(calls[0]).toBe('https://mb.peer.example/v1/messagebox/sendMessage')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
