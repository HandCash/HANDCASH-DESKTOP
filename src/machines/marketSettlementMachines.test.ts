import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import {
  marketPurchaseMachine,
  mayBroadcastMarketPurchase,
  mustAbortMarketPurchase,
} from './marketPurchaseMachine'
import {
  marketSellerSettlementMachine,
  sellerMayConfirmBroadcast,
} from './marketSellerSettlementMachine'

describe('market settlement machines', () => {
  it('aborts a reserved buyer action on timeout', () => {
    const actor = createActor(marketPurchaseMachine).start()
    actor.send({
      type: 'START',
      listingKey: 'tip:nonce',
      path: {
        path: 'atomicPeerSettlement',
        sellerIdentityKey: 'seller',
        feeIdentityKey: 'fee',
      },
    })
    actor.send({ type: 'VERIFIED' })
    actor.send({ type: 'RESERVED', reference: 'buyer-local-reference' })
    actor.send({ type: 'TIMEOUT' })
    expect(mustAbortMarketPurchase(actor.getSnapshot())).toBe(true)
    expect(mayBroadcastMarketPurchase(actor.getSnapshot())).toBe(false)
  })

  it('refuses duplicate seller requests before signing', () => {
    const actor = createActor(marketSellerSettlementMachine).start()
    actor.send({
      type: 'START',
      listingKey: 'tip:nonce',
      buyerIdentityKey: 'buyer',
      path: {
        settle: 'peerDeliver',
        buyerIdentityKey: 'buyer',
        listingKey: 'tip:nonce',
      },
    })
    actor.send({ type: 'DUPLICATE' })
    expect(actor.getSnapshot().matches('refused')).toBe(true)
    expect(sellerMayConfirmBroadcast(actor.getSnapshot())).toBe(false)
  })

  it('permits seller confirmation only after peer delivery', () => {
    const actor = createActor(marketSellerSettlementMachine).start()
    actor.send({
      type: 'START',
      listingKey: 'tip:nonce',
      buyerIdentityKey: 'buyer',
      path: {
        settle: 'peerDeliver',
        buyerIdentityKey: 'buyer',
        listingKey: 'tip:nonce',
      },
    })
    actor.send({ type: 'VALIDATED' })
    actor.send({ type: 'ITEM_INPUT_SIGNED' })
    expect(sellerMayConfirmBroadcast(actor.getSnapshot())).toBe(false)
    actor.send({ type: 'DELIVERED' })
    expect(sellerMayConfirmBroadcast(actor.getSnapshot())).toBe(true)
  })
})
