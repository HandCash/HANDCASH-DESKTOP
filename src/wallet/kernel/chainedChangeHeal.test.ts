import { describe, expect, it } from 'vitest'
import {
  CHAINED_CHANGE_HEAL_COOLDOWN_MS,
  CHAINED_CHANGE_HEAL_STUCK_RETRY_MS,
  decideChainedChangeHeal,
  type ChainedChangeHealState,
} from './chainedChangeHeal'

const idle: ChainedChangeHealState = {
  stuckSats: -1,
  stuckAt: 0,
  lastAttemptAt: 0,
  inFlight: false,
}

describe('decideChainedChangeHeal', () => {
  it('runs when pending change appears', () => {
    expect(
      decideChainedChangeHeal({ pendingChange: 8822, now: 1_000_000, state: idle }),
    ).toEqual({ run: true })
  })

  it('does nothing without pending change', () => {
    expect(
      decideChainedChangeHeal({ pendingChange: 0, now: 1_000_000, state: idle }),
    ).toEqual({ run: false, reason: 'noPendingChange' })
  })

  it('will not stack a second attempt on a running one', () => {
    expect(
      decideChainedChangeHeal({
        pendingChange: 8822,
        now: 1_000_000,
        state: { ...idle, inFlight: true },
      }),
    ).toEqual({ run: false, reason: 'inFlight' })
  })

  it('holds off inside the cooldown', () => {
    expect(
      decideChainedChangeHeal({
        pendingChange: 8822,
        now: 1_000_000,
        state: { ...idle, lastAttemptAt: 1_000_000 - 1 },
      }),
    ).toEqual({ run: false, reason: 'cooldown' })
  })

  /**
   * The freeze: an unmined tx with no proof kept 8822 sats pending, and the
   * promotion re-ran every cooldown forever, each pass blocking the renderer.
   */
  it('stops retrying an amount it already failed to move', () => {
    const now = 5_000_000
    const state: ChainedChangeHealState = {
      stuckSats: 8822,
      stuckAt: now - CHAINED_CHANGE_HEAL_COOLDOWN_MS * 4,
      lastAttemptAt: now - CHAINED_CHANGE_HEAL_COOLDOWN_MS * 4,
      inFlight: false,
    }
    expect(
      decideChainedChangeHeal({ pendingChange: 8822, now, state }),
    ).toEqual({ run: false, reason: 'knownStuck' })
  })

  it('retries once a stuck amount changes', () => {
    const now = 5_000_000
    const state: ChainedChangeHealState = {
      stuckSats: 8822,
      stuckAt: now - CHAINED_CHANGE_HEAL_COOLDOWN_MS * 4,
      lastAttemptAt: now - CHAINED_CHANGE_HEAL_COOLDOWN_MS * 4,
      inFlight: false,
    }
    expect(
      decideChainedChangeHeal({ pendingChange: 9000, now, state }),
    ).toEqual({ run: true })
  })

  it('retries a stuck amount after the long backoff, in case it became promotable', () => {
    const now = 9_000_000
    const state: ChainedChangeHealState = {
      stuckSats: 8822,
      stuckAt: now - CHAINED_CHANGE_HEAL_STUCK_RETRY_MS - 1,
      lastAttemptAt: now - CHAINED_CHANGE_HEAL_STUCK_RETRY_MS - 1,
      inFlight: false,
    }
    expect(decideChainedChangeHeal({ pendingChange: 8822, now, state })).toEqual({
      run: true,
    })
  })
})
