import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { walletAccountMenuMachine } from './walletAccountMenuMachine'

function start() {
  const openProfile = vi.fn()
  const recheckDisplacement = vi.fn()
  const viewAccount = vi.fn()
  const actor = createActor(
    walletAccountMenuMachine.provide({ actions: { openProfile, recheckDisplacement, viewAccount } }),
  ).start()
  actor.send({ type: 'TOGGLE' })
  return { actor, openProfile, recheckDisplacement, viewAccount }
}

describe('wallet account menu', () => {
  it("editing the active account's profile opens Publish identity at once", () => {
    const { actor, openProfile } = start()
    actor.send({ type: 'EDIT_PROFILE', accountIndex: 0, active: true })
    expect(actor.getSnapshot().value).toBe('closed')
    expect(openProfile).toHaveBeenCalledTimes(1)
  })

  it("editing another account's profile switches first, then opens Publish identity", () => {
    const { actor, openProfile } = start()
    actor.send({ type: 'EDIT_PROFILE', accountIndex: 2, active: false })
    expect(actor.getSnapshot().value).toBe('switching')
    expect(actor.getSnapshot().context.targetAccountIndex).toBe(2)
    expect(openProfile).not.toHaveBeenCalled()
    actor.send({ type: 'SWITCHED' })
    expect(actor.getSnapshot().value).toBe('closed')
    expect(openProfile).toHaveBeenCalledTimes(1)
  })

  it('a plain switch, or a failed one, never opens Publish identity', () => {
    const { actor, openProfile } = start()
    actor.send({ type: 'EDIT_PROFILE', accountIndex: 2, active: false })
    actor.send({ type: 'FAIL', error: 'locked' })
    expect(actor.getSnapshot().value).toBe('open')
    actor.send({ type: 'CHOOSE', accountIndex: 1 })
    actor.send({ type: 'SWITCHED' })
    expect(actor.getSnapshot().value).toBe('closed')
    expect(openProfile).not.toHaveBeenCalled()
  })

  it('choosing an account held on another device only views it: no switch, no move', () => {
    const { actor, viewAccount, openProfile } = start()
    actor.send({ type: 'VIEW', accountIndex: 3 })
    expect(actor.getSnapshot().value).toBe('closed')
    expect(actor.getSnapshot().context.targetAccountIndex).toBeNull()
    expect(viewAccount).toHaveBeenCalledTimes(1)
    expect(openProfile).not.toHaveBeenCalled()
  })

  it('has no move step: selecting can never start a move', () => {
    const { actor } = start()
    for (const type of ['MOVE', 'MOVE_PHASE', 'MOVED'] as const) {
      expect(actor.getSnapshot().can({ type } as never)).toBe(false)
    }
    expect(walletAccountMenuMachine.config.states).not.toHaveProperty('moving')
  })

  it('has no manual release or take-over step', () => {
    const { actor } = start()
    for (const type of ['RELEASE', 'TAKE', 'CONFIRM', 'HELD_ELSEWHERE'] as const) {
      expect(actor.getSnapshot().can({ type } as never)).toBe(false)
    }
  })

  it('keeps a displaced wallet visible, whether another local wallet exists or not', () => {
    for (const nextAccountIndex of [2, null]) {
      const { actor, recheckDisplacement } = start()
      actor.send({ type: 'DISPLACED', nextAccountIndex })
      expect(actor.getSnapshot().value).toBe('open')
      expect(actor.getSnapshot().context.targetAccountIndex).toBeNull()
      actor.send({ type: 'TOGGLE' })
      actor.send({ type: 'DISPLACED', nextAccountIndex })
      expect(actor.getSnapshot().value).toBe('closed')
      expect(actor.getSnapshot().context.targetAccountIndex).toBeNull()
      expect(recheckDisplacement).not.toHaveBeenCalled()
      actor.stop()
    }
  })

  it('a displacement during switching is checked again once the switch lands or fails', () => {
    for (const settle of [{ type: 'SWITCHED' }, { type: 'FAIL', error: 'locked' }] as const) {
      const { actor, recheckDisplacement } = start()
      actor.send({ type: 'CHOOSE', accountIndex: 1 })
      actor.send({ type: 'DISPLACED', nextAccountIndex: 2 })
      expect(actor.getSnapshot().value).toBe('switching')
      expect(recheckDisplacement).not.toHaveBeenCalled()
      actor.send(settle)
      expect(actor.getSnapshot().value).toBe(settle.type === 'SWITCHED' ? 'closed' : 'open')
      expect(actor.getSnapshot().context.displacedWhileBusy).toBe(false)
      expect(recheckDisplacement).toHaveBeenCalledTimes(1)
    }
  })

  it('a displacement during creating is checked again once the new wallet opens or fails', () => {
    for (const settle of [{ type: 'CREATED' }, { type: 'FAIL', error: 'offline' }] as const) {
      const { actor, recheckDisplacement } = start()
      actor.send({ type: 'CREATE' })
      actor.send({ type: 'DISPLACED', nextAccountIndex: 2 })
      expect(actor.getSnapshot().value).toBe('creating')
      actor.send(settle)
      expect(actor.getSnapshot().value).toBe(settle.type === 'CREATED' ? 'closed' : 'open')
      expect(recheckDisplacement).toHaveBeenCalledTimes(1)
    }
  })

  it('accepts a displacement in every state and never rechecks without one', () => {
    const { actor, recheckDisplacement } = start()
    for (const step of [
      { type: 'TOGGLE' },
      { type: 'TOGGLE' },
      { type: 'CHOOSE', accountIndex: 1 },
      { type: 'SWITCHED' },
      { type: 'TOGGLE' },
      { type: 'CREATE' },
      { type: 'CREATED' },
    ] as const) {
      expect(actor.getSnapshot().can({ type: 'DISPLACED', nextAccountIndex: 1 })).toBe(true)
      actor.send(step)
    }
    expect(recheckDisplacement).not.toHaveBeenCalled()
  })
})
