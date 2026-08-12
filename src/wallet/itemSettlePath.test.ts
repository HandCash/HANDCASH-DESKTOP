import { describe, expect, it } from 'vitest'
import {
  chooseItemSettlePath,
  isPeerDeliverSettle,
  isSenderBroadcastSettle,
} from './itemSettlePath'

const IDENTITY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('chooseItemSettlePath', () => {
  it('self-pay always settles locally (broadcast here)', () => {
    expect(
      chooseItemSettlePath({
        paysOurAddress: true,
        recipientIdentityKey: IDENTITY,
      }),
    ).toEqual({ settle: 'selfReceive' })
    expect(
      isSenderBroadcastSettle(
        chooseItemSettlePath({ paysOurAddress: true, recipientIdentityKey: null }),
      ),
    ).toBe(true)
  })

  it('HandCash peer → deliver Atomic BEEF, no sender broadcast', () => {
    const path = chooseItemSettlePath({
      paysOurAddress: false,
      recipientIdentityKey: IDENTITY,
    })
    expect(path).toEqual({
      settle: 'peerDeliver',
      recipientIdentityKey: IDENTITY.toLowerCase(),
    })
    expect(isPeerDeliverSettle(path)).toBe(true)
    expect(isSenderBroadcastSettle(path)).toBe(false)
  })

  it('pasted address / missing identity → sender broadcast only', () => {
    expect(
      chooseItemSettlePath({
        paysOurAddress: false,
        recipientIdentityKey: null,
      }),
    ).toEqual({ settle: 'externalBroadcast', reason: 'no-peer-identity' })
    expect(
      chooseItemSettlePath({
        paysOurAddress: false,
        recipientIdentityKey: 'not-a-key',
      }),
    ).toEqual({ settle: 'externalBroadcast', reason: 'no-peer-identity' })
  })

  it('never invents broadcast-then-notify', () => {
    const path = chooseItemSettlePath({
      paysOurAddress: false,
      recipientIdentityKey: IDENTITY,
    })
    expect(path.settle).not.toBe('externalBroadcast')
    expect(path.settle).not.toBe('selfReceive')
  })
})
