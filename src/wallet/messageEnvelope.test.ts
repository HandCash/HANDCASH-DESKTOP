import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import {
  canonicalizeJson,
  looksLikePeerEnvelope,
  openPeerMessage,
  sealPeerMessage,
} from './messageEnvelope'

describe('BRC-169 peer envelopes', () => {
  it('canonicalizes objects with sorted keys', () => {
    expect(canonicalizeJson({ b: 1, a: { d: true, c: null } })).toBe(
      '{"a":{"c":null,"d":true},"b":1}',
    )
  })

  it('round-trips chat so the messagebox operator cannot read the body', () => {
    const sender = PrivateKey.fromRandom()
    const recipient = PrivateKey.fromRandom()
    const plaintext = 'handcash-message:{"version":1,"kind":"text","text":"secret"}'
    const wire = sealPeerMessage({
      plaintext,
      rootKeyHex: sender.toHex(),
      recipientIdentityKey: recipient.toPublicKey().toString(),
    })
    expect(looksLikePeerEnvelope(wire)).toBe(true)
    expect(wire).not.toContain('secret')
    expect(wire).not.toContain('handcash-message:')
    expect(openPeerMessage({ body: wire, rootKeyHex: recipient.toHex() })).toEqual({
      plaintext,
      sealed: true,
    })
    expect(openPeerMessage({ body: wire, rootKeyHex: sender.toHex() })).toEqual({
      refuse: 'invalid-envelope',
    })
  })

  it('keeps legacy plaintext readable', () => {
    expect(
      openPeerMessage({
        body: 'hello federation',
        rootKeyHex: PrivateKey.fromRandom().toHex(),
      }),
    ).toEqual({ plaintext: 'hello federation', sealed: false })
  })

  it('refuses a tampered envelope', () => {
    const sender = PrivateKey.fromRandom()
    const recipient = PrivateKey.fromRandom()
    const wire = sealPeerMessage({
      plaintext: 'hello',
      rootKeyHex: sender.toHex(),
      recipientIdentityKey: recipient.toPublicKey().toString(),
    })
    const parsed = JSON.parse(wire) as { created: string }
    parsed.created = '1999-01-01T00:00:00.000Z'
    expect(
      openPeerMessage({
        body: JSON.stringify(parsed),
        rootKeyHex: recipient.toHex(),
      }),
    ).toEqual({ refuse: 'invalid-envelope' })
  })

  it('refuses an envelope whose signer differs from the transport sender', () => {
    const sender = PrivateKey.fromRandom()
    const recipient = PrivateKey.fromRandom()
    const impostor = PrivateKey.fromRandom()
    const wire = sealPeerMessage({
      plaintext: 'hello',
      rootKeyHex: sender.toHex(),
      recipientIdentityKey: recipient.toPublicKey().toString(),
    })
    expect(
      openPeerMessage({
        body: wire,
        rootKeyHex: recipient.toHex(),
        expectedSenderIdentityKey: impostor.toPublicKey().toString(),
      }),
    ).toEqual({ refuse: 'invalid-envelope' })
  })
})
