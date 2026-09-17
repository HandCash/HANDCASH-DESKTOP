import { describe, expect, it } from 'vitest'
import {
  chooseFungibleChainFate,
  FUNGIBLE_SETTLE_GRACE_MS,
} from './fungibleChainFate'

const held = {
  inLiveBasket: true,
  liveReadUsable: true,
  onChain: null,
  ageMs: 0,
}

describe('chooseFungibleChainFate', () => {
  it('keeps a card the live basket returned', () => {
    expect(chooseFungibleChainFate(held)).toEqual({ kind: 'held' })
  })

  it('never retires a card on a read it could not perform', () => {
    expect(
      chooseFungibleChainFate({
        inLiveBasket: false,
        liveReadUsable: false,
        onChain: null,
        ageMs: FUNGIBLE_SETTLE_GRACE_MS * 100,
      }),
    ).toEqual({ kind: 'awaitingBasket', reason: 'live-read-unavailable' })
  })

  it('keeps an on-chain tip the basket has not projected yet', () => {
    expect(
      chooseFungibleChainFate({
        inLiveBasket: false,
        liveReadUsable: true,
        onChain: true,
        ageMs: FUNGIBLE_SETTLE_GRACE_MS * 100,
      }),
    ).toEqual({ kind: 'awaitingBasket', reason: 'basket-projection-lag' })
  })

  it('gives a fresh mint time to broadcast and project', () => {
    expect(
      chooseFungibleChainFate({
        inLiveBasket: false,
        liveReadUsable: true,
        onChain: null,
        ageMs: 5_000,
      }),
    ).toEqual({ kind: 'awaitingBasket', reason: 'settling' })
  })

  it('keeps an aged mint when chain presence is unknown', () => {
    expect(
      chooseFungibleChainFate({
        inLiveBasket: false,
        liveReadUsable: true,
        onChain: null,
        ageMs: FUNGIBLE_SETTLE_GRACE_MS + 1,
      }),
    ).toEqual({ kind: 'awaitingBasket', reason: 'chain-unknown' })
  })

  it('does not delete an old row on unknown chain presence', () => {
    // Durable rows written before `seenAt` existed compute their age from 0.
    expect(
      chooseFungibleChainFate({
        inLiveBasket: false,
        liveReadUsable: true,
        onChain: null,
        ageMs: Date.now(),
      }),
    ).toEqual({ kind: 'awaitingBasket', reason: 'chain-unknown' })
  })

  it('retires only after an explicit absent verdict and grace', () => {
    expect(
      chooseFungibleChainFate({
        inLiveBasket: false,
        liveReadUsable: true,
        onChain: false,
        ageMs: FUNGIBLE_SETTLE_GRACE_MS + 1,
      }),
    ).toEqual({ kind: 'unconfirmed', reason: 'never-seen-on-chain' })
  })
})
