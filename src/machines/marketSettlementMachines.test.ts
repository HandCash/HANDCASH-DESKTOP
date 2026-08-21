import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import {
  marketPurchaseMachine,
  mayAbortMarketPurchase,
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
    actor.send({ type: 'SELLER_INPUTS_SIGNED' })
    expect(sellerMayConfirmBroadcast(actor.getSnapshot())).toBe(false)
    actor.send({ type: 'DELIVERED' })
    expect(sellerMayConfirmBroadcast(actor.getSnapshot())).toBe(true)
  })

  it('routes a lost buyer result to recovery without an abort edge', () => {
    const actor = createActor(marketPurchaseMachine).start()
    actor.send({
      type: 'START',
      listingKey: 'tip:offer',
      path: {
        path: 'atomicPeerSettlement',
        sellerIdentityKey: 'seller',
        feeIdentityKey: 'fee',
      },
    })
    actor.send({ type: 'VERIFIED' })
    actor.send({ type: 'RESERVED', reference: 'ref' })
    actor.send({ type: 'SELLER_SIGNED' })
    actor.send({ type: 'SIGNING' })
    actor.send({ type: 'FAIL', error: 'receipt lost after broadcast' })
    expect(actor.getSnapshot().matches('recovery')).toBe(true)
    expect(mustAbortMarketPurchase(actor.getSnapshot())).toBe(false)
    expect(mayAbortMarketPurchase(actor.getSnapshot())).toBe(false)
  })

  it('may abort only before wallet signing starts', () => {
    const actor = createActor(marketPurchaseMachine).start()
    actor.send({
      type: 'START',
      listingKey: 'tip:offer',
      path: {
        path: 'atomicPeerSettlement',
        sellerIdentityKey: 'seller',
        feeIdentityKey: 'fee',
      },
    })
    actor.send({ type: 'VERIFIED' })
    actor.send({ type: 'RESERVED', reference: 'ref' })
    expect(mayAbortMarketPurchase(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SELLER_SIGNED' })
    expect(mayAbortMarketPurchase(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SIGNING' })
    expect(mayAbortMarketPurchase(actor.getSnapshot())).toBe(false)
  })
})
