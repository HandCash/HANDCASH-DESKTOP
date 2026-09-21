import { describe, expect, it } from 'vitest'
import {
  chooseItemSettlePath,
  isPeerDeliverSettle,
} from './itemSettlePath'

const IDENTITY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('chooseItemSettlePath', () => {
  it('self-pay always settles metadata locally', () => {
    expect(
      chooseItemSettlePath({
        paysOurAddress: true,
        recipientIdentityKey: IDENTITY,
      }),
    ).toEqual({ settle: 'selfReceive' })
  })

  it('HandCash peer → notify with Atomic BEEF metadata', () => {
    const path = chooseItemSettlePath({
      paysOurAddress: false,
      recipientIdentityKey: IDENTITY,
    })
    expect(path).toEqual({
      settle: 'peerDeliver',
      recipientIdentityKey: IDENTITY.toLowerCase(),
    })
    expect(isPeerDeliverSettle(path)).toBe(true)
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

  it('keeps peer metadata routing distinct from address-only routing', () => {
    const path = chooseItemSettlePath({
      paysOurAddress: false,
      recipientIdentityKey: IDENTITY,
    })
    expect(path.settle).not.toBe('externalBroadcast')
    expect(path.settle).not.toBe('selfReceive')
  })
})
