import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
const refusal = vi.hoisted(() => ({ value: null as string | null }))
const runtime = vi.hoisted(() => ({ value: null as { runtimeId: string; instance: { identityKey: string; accountIndex: number } } | null }))
vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => runtime.value,
  assertRuntimeCurrent: (captured: unknown) => { if (captured !== runtime.value) throw new Error('account changed') },
}))
vi.mock('./vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => refusal.value }))
const custody = vi.hoisted(() => ({
  move: vi.fn(async () => ({ kind: 'moved' as const, forced: false })),
  arrive: vi.fn(async () => {}),
}))
vi.mock('./accountMove', () => ({ moveAccountHere: custody.move }))
vi.mock('./spendArrival', () => ({ mergeArrivedForSpend: custody.arrive }))

import { moveActiveAccountForSpend, spendNeedsMove, type SpendAccount } from './spendAutoMove'
import { ACCOUNT_HELD_ELSEWHERE } from './vaultAccounts'

const account = { identityKey: 'ik-1', accountIndex: 0, vaultMaster: {} } as unknown as SpendAccount

beforeEach(() => {
  vi.clearAllMocks()
  refusal.value = null
  runtime.value = null
})

describe('spendNeedsMove', () => {
  it('only a held-elsewhere refusal can be cured by moving', () => {
    expect(spendNeedsMove(ACCOUNT_HELD_ELSEWHERE)).toBe(true)
    expect(spendNeedsMove('This wallet is moving to another device.')).toBe(false)
    expect(spendNeedsMove(null)).toBe(false)
  })
})

describe('moveActiveAccountForSpend', () => {
  it('refuses a locked device before starting any move', async () => {
    await expect(moveActiveAccountForSpend(account)).rejects.toThrow('WALLET_LOCKED')
  })

  it.each([
    { identityKey: 'other-account', accountIndex: 0 },
    { identityKey: account.identityKey, accountIndex: 1 },
  ])('refuses an account captured before the current selection: %j', async (instance) => {
    runtime.value = { runtimeId: 'new-selection', instance }
    await expect(moveActiveAccountForSpend(account)).rejects.toThrow('Wallet account changed')
  })

  it('does not reuse a disposed runtime move when the same account is reopened', async () => {
    let finish!: (value: { kind: 'moved'; forced: boolean }) => void
    custody.move.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    runtime.value = { runtimeId: 'first-open', instance: account }
    const first = moveActiveAccountForSpend(account)
    const rejected = expect(first).rejects.toThrow('account changed')
    await vi.waitFor(() => expect(custody.move).toHaveBeenCalledTimes(1))
    runtime.value = { runtimeId: 'second-open', instance: account }
    await moveActiveAccountForSpend(account)
    expect(custody.move).toHaveBeenCalledTimes(2)
    expect(custody.arrive).toHaveBeenCalledOnce()
    finish({ kind: 'moved', forced: false })
    await rejected
    expect(custody.arrive).toHaveBeenCalledOnce()
  })

  it('does not let a different index inherit a valid in-flight account move', async () => {
    let finish!: (value: { kind: 'moved'; forced: boolean }) => void
    custody.move.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    runtime.value = { runtimeId: 'same-runtime', instance: account }
    const moving = moveActiveAccountForSpend(account)
    await vi.waitFor(() => expect(custody.move).toHaveBeenCalledOnce())
    await expect(moveActiveAccountForSpend({ ...account, accountIndex: 1 })).rejects.toThrow('Wallet account changed')
    expect(custody.move).toHaveBeenCalledOnce()
    finish({ kind: 'moved', forced: false })
    await moving
  })

  it('does not merge arrival history after the signing intent account changed', async () => {
    let current = true
    const arrive = vi.fn(async () => {})
    await expect(moveActiveAccountForSpend(account, {
      assertCurrent: () => { if (!current) throw new Error('account changed') },
      move: async () => { current = false; return { ok: true } },
      arrive,
    })).rejects.toThrow('account changed')
    expect(arrive).not.toHaveBeenCalled()
  })

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
