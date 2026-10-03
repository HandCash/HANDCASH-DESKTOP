import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { wipeMachine } from './wipeMachine'

function blocked() {
  const actor = createActor(wipeMachine).start()
  actor.send({ type: 'VERIFIED', password: null })
  actor.send({ type: 'TOGGLE_ACK', acknowledged: true })
  actor.send({ type: 'CHANGE_CONFIRM', confirmText: 'delete' })
  actor.send({ type: 'SUBMIT' })
  actor.send({
    type: 'BLOCKED',
    reason: 'History didn’t sync: Failed to fetch',
    refusal: { kind: 'upload-failed', detail: 'Failed to fetch' },
  })
  return actor
}

describe('wipeMachine', () => {
  it('keeps the refusal when the history gate blocks', () => {
    const actor = blocked()
    expect(actor.getSnapshot().value).toBe('blocked')
    expect(actor.getSnapshot().context.refusal).toEqual({ kind: 'upload-failed', detail: 'Failed to fetch' })
  })

  it('wipes from blocked only with an overridden gate', () => {
    const actor = blocked()
    actor.send({ type: 'OVERRIDE', gate: { kind: 'synced', checkedAt: Date.now() } })
    expect(actor.getSnapshot().value).toBe('blocked')
    actor.send({ type: 'OVERRIDE', gate: { kind: 'overridden', checkedAt: Date.now() } })
    expect(actor.getSnapshot().value).toBe('wiping')
    expect(actor.getSnapshot().context.gate?.kind).toBe('overridden')
  })

  it('ignores OVERRIDE outside blocked', () => {
    const actor = createActor(wipeMachine).start()
    actor.send({ type: 'OVERRIDE', gate: { kind: 'overridden', checkedAt: Date.now() } })
    expect(actor.getSnapshot().value).toBe('idle')
  })
})
