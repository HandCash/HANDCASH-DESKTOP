import { describe, expect, it, vi } from 'vitest'
import type { SettleRecord } from './settleStore'

vi.mock('./settleStore', () => ({ activeSwaps: () => [] }))
const { swapUnlockHold } = await import('./unlockHold')

const NOW = 1_800_000_000_000
const rec = (over: Partial<SettleRecord>): SettleRecord => ({ role: 'taker', own: {}, peer: {}, ...over }) as SettleRecord

describe('swap unlock hold', () => {
  it('holds until the latest deadline of a swap waiting on this wallet', () => {
    const a = rec({ waiting: { for: 'peer-funding', until: NOW + 3_600_000 } })
    const b = rec({ waiting: { for: 'peer-burial', until: NOW + 7_200_000 } })
    expect(swapUnlockHold([a, b], NOW)).toBe(NOW + 7_200_000)
  })

  it('does not hold for refunds, a past deadline, or a maker whose lock is out', () => {
    expect(swapUnlockHold([rec({ waiting: { for: 'locktime', until: NOW + 1000 } })], NOW)).toBeNull()
    expect(swapUnlockHold([rec({ waiting: { for: 'peer-burial', until: NOW - 1 } })], NOW)).toBeNull()
    expect(swapUnlockHold([rec({ role: 'maker', own: { funding: { txid: 'a', main: 0 } }, waiting: { for: 'secret', until: NOW + 1000 } })], NOW)).toBeNull()
    expect(swapUnlockHold([], NOW)).toBeNull()
  })

  it('holds a swap mid-step for a short while', () => {
    expect(swapUnlockHold([rec({ phase: 'claiming' })], NOW)).toBe(NOW + 10 * 60_000)
  })
})
