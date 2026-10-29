import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { permissionDecisionMachine } from './permissionDecisionMachine'

describe('permissionDecisionMachine', () => {
  it('commits only one decision until the next prompt resets it', () => {
    const actor = createActor(permissionDecisionMachine).start()

    actor.send({ type: 'APPROVE' })
    expect(actor.getSnapshot().matches('committing')).toBe(true)

    actor.send({ type: 'APPROVE' })
    actor.send({ type: 'CANCEL' })
    expect(actor.getSnapshot().matches('committing')).toBe(true)

    actor.send({ type: 'RESET' })
    expect(actor.getSnapshot().matches('pending')).toBe(true)
  })
  it('owns lifetime selection, resets between requests and ignores changes after commitment', () => {
    const actor = createActor(permissionDecisionMachine).start()
    expect(actor.getSnapshot().context.lifetime).toBe('session')
    actor.send({ type: 'CHOOSE_LIFETIME', value: 'remember' })
    expect(actor.getSnapshot().context.lifetime).toBe('remember')
    actor.send({ type: 'APPROVE' })
    actor.send({ type: 'CHOOSE_LIFETIME', value: 'once' })
    expect(actor.getSnapshot().context.lifetime).toBe('remember')
    actor.send({ type: 'RESET' })
    expect(actor.getSnapshot().context.lifetime).toBe('session')
  })

})
