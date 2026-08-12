import { describe, expect, it } from 'vitest'
import {
  chooseBrc29SettlePath,
  isBrc29PeerDeliver,
} from './brc29SettlePath'

const US =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const PEER =
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'

describe('chooseBrc29SettlePath', () => {
  it('same identity (any hex case) → selfReceive', () => {
    expect(
      chooseBrc29SettlePath({
        payeeIdentityKey: US.toUpperCase(),
        ourIdentityKey: US,
      }),
    ).toEqual({ settle: 'selfReceive' })
    expect(
      isBrc29PeerDeliver(
        chooseBrc29SettlePath({ payeeIdentityKey: US, ourIdentityKey: US }),
      ),
    ).toBe(false)
  })

  it('HandCash peer → deliver remittance, no sender broadcast yet', () => {
    const path = chooseBrc29SettlePath({
      payeeIdentityKey: PEER,
      ourIdentityKey: US,
    })
    expect(path).toEqual({
      settle: 'peerDeliver',
      recipientIdentityKey: PEER.toLowerCase(),
    })
    expect(isBrc29PeerDeliver(path)).toBe(true)
  })

  it('refuses an invalid payee key', () => {
    expect(() =>
      chooseBrc29SettlePath({
        payeeIdentityKey: 'not-a-key',
        ourIdentityKey: US,
      }),
    ).toThrow(/invalid payee/i)
  })
})
