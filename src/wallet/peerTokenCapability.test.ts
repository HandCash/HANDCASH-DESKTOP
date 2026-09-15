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
  it('flags bare addresses', () => {
    expect(assessPeerBsv21Support({})).toBe('no-identity')
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
  it('is silent when supported', () => {
    expect(peerBsv21SupportWarning('supported')).toBeNull()
    expect(peerBsv21SupportWarning('self')).toBeNull()
  })

  it('warns when unknown', () => {
    expect(peerBsv21SupportWarning('unknown')).toMatch(/could not verify/i)
  })
})
