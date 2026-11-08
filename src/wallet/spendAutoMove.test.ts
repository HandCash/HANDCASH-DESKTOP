import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
const refusal = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('./vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => refusal.value }))

import { moveActiveAccountForSpend, spendNeedsMove, type SpendAccount } from './spendAutoMove'
import { ACCOUNT_HELD_ELSEWHERE } from './vaultAccounts'

const account = { identityKey: 'ik-1', accountIndex: 0, vaultMaster: {} } as unknown as SpendAccount

beforeEach(() => {
  refusal.value = null
})

describe('spendNeedsMove', () => {
  it('only a held-elsewhere refusal can be cured by moving', () => {
    expect(spendNeedsMove(ACCOUNT_HELD_ELSEWHERE)).toBe(true)
    expect(spendNeedsMove('This wallet is moving to another device.')).toBe(false)
    expect(spendNeedsMove(null)).toBe(false)
  })
})

describe('moveActiveAccountForSpend', () => {
  it('moves, merges the arrived history, then resolves', async () => {
    const order: string[] = []
    await moveActiveAccountForSpend(account, {
      move: async () => (order.push('move'), { ok: true }),
      arrive: async () => void order.push('arrive'),
    })
    expect(order).toEqual(['move', 'arrive'])
  })

  it('shares one move between concurrent spends', async () => {
    const move = vi.fn(async () => ({ ok: true as const }))
    const steps = { move, arrive: async () => {} }
    await Promise.all([moveActiveAccountForSpend(account, steps), moveActiveAccountForSpend(account, steps)])
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('fails the spend with the move message and never merges', async () => {
    const arrive = vi.fn(async () => {})
    await expect(
      moveActiveAccountForSpend(account, { move: async () => ({ ok: false, message: 'No answer.' }), arrive }),
    ).rejects.toThrow('No answer.')
    expect(arrive).not.toHaveBeenCalled()
  })

  it('refuses the spend when the history merge fails', async () => {
    await expect(
      moveActiveAccountForSpend(account, {
        move: async () => ({ ok: true }),
        arrive: async () => {
          throw new Error('history could not be loaded')
        },
      }),
    ).rejects.toThrow('history could not be loaded')
  })

  it('refuses when this install still does not hold the wallet afterwards', async () => {
    refusal.value = ACCOUNT_HELD_ELSEWHERE
    await expect(
      moveActiveAccountForSpend(account, { move: async () => ({ ok: true }), arrive: async () => {} }),
    ).rejects.toThrow('could not be moved here')
  })

  it('allows a retry after a failure', async () => {
    await expect(
      moveActiveAccountForSpend(account, { move: async () => ({ ok: false, message: 'x' }), arrive: async () => {} }),
    ).rejects.toThrow()
    await expect(
      moveActiveAccountForSpend(account, { move: async () => ({ ok: true }), arrive: async () => {} }),
    ).resolves.toBeUndefined()
  })
})
