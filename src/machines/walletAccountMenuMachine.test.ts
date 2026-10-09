import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { walletAccountMenuMachine } from './walletAccountMenuMachine'

function start() {
  const openProfile = vi.fn()
  const actor = createActor(walletAccountMenuMachine.provide({ actions: { openProfile } })).start()
  actor.send({ type: 'TOGGLE' })
  return { actor, openProfile }
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

  it('moving an account here: a released one switches at once, a held one asks first', () => {
    const { actor } = start()
    actor.send({ type: 'TAKE', accountIndex: 3 })
    expect(actor.getSnapshot().value).toBe('taking')
    actor.send({ type: 'HELD_ELSEWHERE' })
    expect(actor.getSnapshot().value).toBe('confirmTakeover')
    actor.send({ type: 'CANCEL' })
    expect(actor.getSnapshot().value).toBe('open')
    expect(actor.getSnapshot().context.targetAccountIndex).toBeNull()

    actor.send({ type: 'TAKE', accountIndex: 3 })
    actor.send({ type: 'HELD_ELSEWHERE' })
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().value).toBe('taking')
    expect(actor.getSnapshot().context.force).toBe(true)
    actor.send({ type: 'TAKEN' })
    expect(actor.getSnapshot().value).toBe('switching')
    expect(actor.getSnapshot().context).toMatchObject({ targetAccountIndex: 3, force: false })
    actor.send({ type: 'SWITCHED' })
    expect(actor.getSnapshot().value).toBe('closed')
  })

  it('releasing the active account confirms, then leaves for a held account or a new one', () => {
    const { actor } = start()
    actor.send({ type: 'RELEASE' })
    expect(actor.getSnapshot().value).toBe('confirmRelease')
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().value).toBe('releasing')
    actor.send({ type: 'RELEASED', nextAccountIndex: 1 })
    expect(actor.getSnapshot().value).toBe('switching')
    expect(actor.getSnapshot().context.targetAccountIndex).toBe(1)

    const second = start().actor
    second.send({ type: 'RELEASE' })
    second.send({ type: 'CONFIRM' })
    second.send({ type: 'RELEASED', nextAccountIndex: null })
    expect(second.getSnapshot().value).toBe('creating')

    const failed = start().actor
    failed.send({ type: 'RELEASE' })
    failed.send({ type: 'CONFIRM' })
    failed.send({ type: 'FAIL', error: 'offline' })
    expect(failed.getSnapshot().value).toBe('open')
    expect(failed.getSnapshot().context.error).toBe('offline')
  })

  it('a displaced account is left from an idle menu, never mid-switch', () => {
    const { actor } = start()
    actor.send({ type: 'TOGGLE' })
    actor.send({ type: 'DISPLACED', nextAccountIndex: 2 })
    expect(actor.getSnapshot().value).toBe('switching')
    expect(actor.getSnapshot().context.targetAccountIndex).toBe(2)
    actor.send({ type: 'DISPLACED', nextAccountIndex: 4 })
    expect(actor.getSnapshot().context.targetAccountIndex).toBe(2)

    const none = start().actor
    none.send({ type: 'DISPLACED', nextAccountIndex: null })
    expect(none.getSnapshot().value).toBe('creating')
  })
})
