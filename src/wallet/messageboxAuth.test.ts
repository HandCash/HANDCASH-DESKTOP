import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'

import {
  messageboxAuthPreimage,
  signMessageboxAuth,
  verifyMessageboxAuth,
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
})
