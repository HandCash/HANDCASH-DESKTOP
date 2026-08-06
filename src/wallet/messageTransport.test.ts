import { describe, expect, it } from 'vitest'

import { decodeMessageBody, encodeMessageBody } from './messageTransport'

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
