import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
const snapshot = vi.fn()
vi.mock('./balanceSnapshot', () => ({ readTrustedBalanceSnapshot: (...args: unknown[]) => snapshot(...args) }))

import {
  accountViewBalance,
  clearAccountView,
  getAccountView,
  subscribeAccountView,
  takeViewedAccountForSpend,
  viewAccount,
  type AccountView,
} from './accountView'
import type { VaultMaster } from './vaultMaster'

const view: AccountView = {
  masterIdentityKey: 'master',
  accountIndex: 2,
  identityKey: 'ik-2',
  chain: 'main',
  name: 'Savings',
}
const master = {} as VaultMaster

function steps(overrides: Partial<{ move: boolean | string; switchFails: boolean; arriveFails: boolean }> = {}) {
  const order: string[] = []
  return {
    order,
    steps: {
      move: vi.fn(async () => {
        order.push('move')
        const move = overrides.move ?? true
        return move === true ? ({ ok: true } as const) : ({ ok: false, message: String(move) } as const)
      }),
      switchTo: vi.fn(async (index: number) => {
        order.push(`switch:${index}`)
        if (overrides.switchFails) throw new Error('held elsewhere')
        return { accountIndex: index }
      }),
      arrive: vi.fn(async () => {
        order.push('arrive')
        if (overrides.arriveFails) throw new Error('history could not be loaded')
      }),
    },
  }
}

describe('account view', () => {
  beforeEach(() => {
    clearAccountView()
    snapshot.mockReset()
  })

  it('viewing is a plain store: it notifies and never moves anything', () => {
    const listener = vi.fn()
    const off = subscribeAccountView(listener)
    viewAccount(view)
    expect(getAccountView()).toEqual(view)
    clearAccountView()
    expect(getAccountView()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
  })

  it('shows the cached balance with its age, or unavailable, never an invented zero', () => {
    snapshot.mockReturnValueOnce({ identityKey: 'ik-2', chain: 'main', sats: 1234, readAt: 99 })
    expect(accountViewBalance(view)).toEqual({ kind: 'cached', sats: 1234, readAt: 99 })
    snapshot.mockReturnValueOnce(null)
    expect(accountViewBalance(view)).toEqual({ kind: 'unavailable' })
  })

  it('a spend moves the account here, then switches, then merges its history', async () => {
    viewAccount(view)
    const { order, steps: s } = steps()
    await expect(takeViewedAccountForSpend({ view, master }, s)).resolves.toEqual({ accountIndex: 2 })
    expect(order).toEqual(['move', 'switch:2', 'arrive'])
    expect(getAccountView()).toBeNull()
  })

  it('a failed move never switches, so nothing can spend', async () => {
    viewAccount(view)
    const { order, steps: s } = steps({ move: 'other device offline' })
    await expect(takeViewedAccountForSpend({ view, master }, s)).rejects.toThrow('other device offline')
    expect(order).toEqual(['move'])
    expect(s.switchTo).not.toHaveBeenCalled()
    expect(getAccountView()).toEqual(view)
  })

  it('a refused switch or a failed merge rejects the spend', async () => {
    for (const fail of [{ switchFails: true }, { arriveFails: true }]) {
      viewAccount(view)
      const { steps: s } = steps(fail)
      await expect(takeViewedAccountForSpend({ view, master }, s)).rejects.toThrow()
    }
  })

  it('concurrent spends from one viewed account share one move', async () => {
    const { steps: s } = steps()
    await Promise.all([
      takeViewedAccountForSpend({ view, master }, s),
      takeViewedAccountForSpend({ view, master }, s),
    ])
    expect(s.move).toHaveBeenCalledTimes(1)
  })
})
