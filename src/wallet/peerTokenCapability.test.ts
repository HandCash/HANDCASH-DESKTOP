import { describe, expect, it, vi } from 'vitest'

vi.mock('./session', () => ({
  getActiveWallet: () => ({ identityKey: '02' + 'ab'.repeat(32) }),
}))

import {
  assessPeerBsv21Support,
  parseWalletProtocols,
  peerBsv21SupportWarning,
} from './peerTokenCapability'

describe('parseWalletProtocols', () => {
  it('normalizes aliases to bsv21', () => {
    expect(parseWalletProtocols(['BSV-21', '1sat', 'brc-162'])).toEqual([
      'bsv21',
      '1sat',
      'bsv21',
    ].filter((v, i, a) => a.indexOf(v) === i))
    expect(parseWalletProtocols(['bsv21', '1sat'])).toEqual(['bsv21', '1sat'])
  })
})

describe('assessPeerBsv21Support', () => {
  it('stays idle until a recipient is named', () => {
    expect(assessPeerBsv21Support({})).toBe('idle')
    expect(assessPeerBsv21Support({ destination: '   ' })).toBe('idle')
    expect(assessPeerBsv21Support({ destination: '1abc' })).toBe('idle')
    expect(peerBsv21SupportWarning('idle')).toBeNull()
  })

  it('flags a typed address with no identity', () => {
    expect(
      assessPeerBsv21Support({
        destination: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      }),
    ).toBe('no-identity')
  })

  it('treats self as supported path', () => {
    expect(
      assessPeerBsv21Support({ recipientIdentityKey: '02' + 'ab'.repeat(32) }),
    ).toBe('self')
  })

  it('reads explicit protocols', () => {
    expect(
      assessPeerBsv21Support({
        recipientIdentityKey: '03' + 'cd'.repeat(32),
        protocols: ['bsv21'],
      }),
    ).toBe('supported')
    expect(
      assessPeerBsv21Support({
        recipientIdentityKey: '03' + 'cd'.repeat(32),
        protocols: ['1sat'],
      }),
    ).toBe('unsupported')
    expect(
      assessPeerBsv21Support({
        recipientIdentityKey: '03' + 'cd'.repeat(32),
        protocols: [],
      }),
    ).toBe('unknown')
  })
})

describe('peerBsv21SupportWarning', () => {
  it('is silent when idle or supported', () => {
    expect(peerBsv21SupportWarning('idle')).toBeNull()
    expect(peerBsv21SupportWarning('supported')).toBeNull()
    expect(peerBsv21SupportWarning('self')).toBeNull()
  })

  it('warns when unknown', () => {
    expect(peerBsv21SupportWarning('unknown')).toMatch(/could not verify/i)
  })
})
