import { describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'

import {
  freshMessageboxAuthHeaders,
  messageboxAuthHeaders,
  messageboxAuthPreimage,
  signMessageboxAuth,
  verifyMessageboxAuth,
  verifyMessageboxAuthrite,
} from './messageboxAuth'

describe('messageboxAuth', () => {
  it('round-trips a listMessages identity proof', () => {
    const root = PrivateKey.fromRandom()
    const signed = signMessageboxAuth({
      rootKeyHex: root.toHex(),
      method: 'listMessages',
      messageBox: 'inbox',
      timestamp: 1_700_000_000_000,
    })
    expect(signed.identityKey).toBe(root.toPublicKey().toString().toLowerCase())
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/i)
    expect(
      verifyMessageboxAuth({
        ...signed,
        method: 'listMessages',
        messageBox: 'inbox',
        now: 1_700_000_000_000,
      }),
    ).toBe(true)
  })

  it('rejects wrong method or stale timestamp', () => {
    const root = PrivateKey.fromRandom()
    const signed = signMessageboxAuth({
      rootKeyHex: root.toHex(),
      method: 'sendMessage',
      messageBox: 'inbox',
      timestamp: 1_700_000_000_000,
    })
    expect(
      verifyMessageboxAuth({
        ...signed,
        method: 'listMessages',
        messageBox: 'inbox',
        now: 1_700_000_000_000,
      }),
    ).toBe(false)
    expect(
      verifyMessageboxAuth({
        ...signed,
        method: 'sendMessage',
        messageBox: 'inbox',
        now: 1_700_000_000_000 + 10 * 60 * 1000,
      }),
    ).toBe(false)
  })

  it('builds the canonical preimage', () => {
    expect(
      messageboxAuthPreimage({
        method: 'acknowledgeMessage',
        messageBox: 'inbox',
        timestamp: 42,
      }),
    ).toBe('BRC-33-lite\nacknowledgeMessage\ninbox\n42')
  })

  it('also signs BRC-103 identity headers alongside BRC-33-lite', () => {
    const root = PrivateKey.fromRandom()
    const signed = signMessageboxAuth({
      rootKeyHex: root.toHex(),
      method: 'sendMessage',
      messageBox: 'inbox',
      timestamp: 1_700_000_000_000,
      nonce: 'abc123',
    })
    expect(signed.nonce).toBe('abc123')
    expect(signed.authriteSignature).toMatch(/^[0-9a-f]{128}$/i)
    const headers = messageboxAuthHeaders(signed)
    expect(headers['X-BRC33-Signature']).toBeTruthy()
    expect(headers['X-BRC103-Signature']).toBeUndefined()
    expect(messageboxAuthHeaders(signed, { includeAuthrite: true })['X-BRC103-Signature']).toBe(
      signed.authriteSignature,
    )
    expect(
      verifyMessageboxAuthrite({
        identityKey: signed.identityKey,
        method: 'sendMessage',
        messageBox: 'inbox',
        timestamp: signed.timestamp,
        nonce: signed.nonce,
        signature: signed.authriteSignature,
        now: 1_700_000_000_000,
      }),
    ).toBe(true)
  })

  it('fresh headers always include Identity, Timestamp, and Signature', () => {
    const root = PrivateKey.fromRandom()
    const headers = freshMessageboxAuthHeaders({
      rootKeyHex: root.toHex(),
      method: 'sendMessage',
    })
    expect(headers['X-BRC33-Identity']).toBe(
      root.toPublicKey().toString().toLowerCase(),
    )
    expect(headers['X-BRC33-Timestamp']).toMatch(/^\d+$/)
    expect(Number(headers['X-BRC33-Timestamp'])).toBeGreaterThan(0)
    expect(headers['X-BRC33-Signature']).toMatch(/^[0-9a-f]{128}$/i)
    expect(headers['X-BRC103-Signature']).toBeUndefined()
  })

  it('re-signs with a new Date.now() on every call', () => {
    const root = PrivateKey.fromRandom()
    let now = 1_700_000_000_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1_000
      return now
    })
    try {
      const first = freshMessageboxAuthHeaders({
        rootKeyHex: root.toHex(),
        method: 'sendMessage',
      })
      const second = freshMessageboxAuthHeaders({
        rootKeyHex: root.toHex(),
        method: 'sendMessage',
      })
      expect(first['X-BRC33-Timestamp']).not.toBe(second['X-BRC33-Timestamp'])
      expect(first['X-BRC33-Signature']).not.toBe(second['X-BRC33-Signature'])
      expect(Number(second['X-BRC33-Timestamp'])).toBeGreaterThan(
        Number(first['X-BRC33-Timestamp']),
      )
    } finally {
      spy.mockRestore()
    }
  })
})
