import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { walletAccountMenuMachine } from './walletAccountMenuMachine'

function start() {
  const openProfile = vi.fn()
  const recheckDisplacement = vi.fn()
  const actor = createActor(
    walletAccountMenuMachine.provide({ actions: { openProfile, recheckDisplacement } }),
  ).start()
  actor.send({ type: 'TOGGLE' })
  return { actor, openProfile, recheckDisplacement }
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

  it('moving an account here never asks: it reports each phase, then switches to it', () => {
    const { actor } = start()
    actor.send({ type: 'MOVE', accountIndex: 3 })
    expect(actor.getSnapshot().value).toBe('moving')
    expect(actor.getSnapshot().context).toMatchObject({ targetAccountIndex: 3, movePhase: 'reading' })
    actor.send({ type: 'MOVE_PHASE', phase: 'awaitingAccept' })
    expect(actor.getSnapshot().context.movePhase).toBe('awaitingAccept')
    actor.send({ type: 'MOVE_PHASE', phase: 'forcing' })
    actor.send({ type: 'MOVED' })
    expect(actor.getSnapshot().value).toBe('switching')
    expect(actor.getSnapshot().context).toMatchObject({ targetAccountIndex: 3, movePhase: null })
    actor.send({ type: 'SWITCHED' })
    expect(actor.getSnapshot().value).toBe('closed')
  })

  it('a failed move returns to the open menu with its reason and no target', () => {
    const { actor } = start()
    actor.send({ type: 'MOVE', accountIndex: 3 })
    actor.send({ type: 'FAIL', error: 'offline' })
    expect(actor.getSnapshot().value).toBe('open')
    expect(actor.getSnapshot().context).toMatchObject({ targetAccountIndex: null, movePhase: null, error: 'offline' })
  })

  it('has no manual release or take-over step', () => {
    const { actor } = start()
    for (const type of ['RELEASE', 'TAKE', 'CONFIRM', 'HELD_ELSEWHERE'] as const) {
      expect(actor.getSnapshot().can({ type } as never)).toBe(false)
    }
  })

  it('a displaced account is left from an idle menu; mid-switch it is recorded, not acted on', () => {
    const { actor, recheckDisplacement } = start()
    actor.send({ type: 'TOGGLE' })
    actor.send({ type: 'DISPLACED', nextAccountIndex: 2 })
    expect(actor.getSnapshot().value).toBe('switching')
    expect(actor.getSnapshot().context.targetAccountIndex).toBe(2)
    actor.send({ type: 'DISPLACED', nextAccountIndex: 4 })
    expect(actor.getSnapshot().value).toBe('switching')
    expect(actor.getSnapshot().context).toMatchObject({ targetAccountIndex: 2, displacedWhileBusy: true })
    expect(recheckDisplacement).not.toHaveBeenCalled()

    const none = start().actor
    none.send({ type: 'DISPLACED', nextAccountIndex: null })
    expect(none.getSnapshot().value).toBe('creating')
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

  it('a displacement during a move survives into the switch and is checked when it settles', () => {
    const { actor, recheckDisplacement } = start()
    actor.send({ type: 'MOVE', accountIndex: 3 })
    actor.send({ type: 'DISPLACED', nextAccountIndex: null })
    expect(actor.getSnapshot().value).toBe('moving')
    actor.send({ type: 'MOVED' })
    expect(actor.getSnapshot().value).toBe('switching')
    expect(actor.getSnapshot().context.displacedWhileBusy).toBe(true)
    expect(recheckDisplacement).not.toHaveBeenCalled()
    actor.send({ type: 'SWITCHED' })
    expect(recheckDisplacement).toHaveBeenCalledTimes(1)

    const failed = start()
    failed.actor.send({ type: 'MOVE', accountIndex: 3 })
    failed.actor.send({ type: 'DISPLACED', nextAccountIndex: 1 })
    failed.actor.send({ type: 'FAIL', error: 'offline' })
    expect(failed.actor.getSnapshot().value).toBe('open')
    expect(failed.recheckDisplacement).toHaveBeenCalledTimes(1)
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
