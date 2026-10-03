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
})
