import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { sendMachine } from './sendMachine'

function drafted() {
  const actor = createActor(sendMachine).start()
  actor.send({ type: 'EDIT', to: '1BitcoinAddress', amount: '0.5' })
  return actor
}

describe('sendMachine', () => {
  it('runs the pre-review balance check as a phase of editing', () => {
    const actor = drafted()
    actor.send({ type: 'CHECK' })

    const snapshot = actor.getSnapshot()
    expect(snapshot.matches('editing')).toBe(true)
    expect(snapshot.matches({ editing: 'checking' })).toBe(true)

    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().matches('confirming')).toBe(true)
  })

  it('refuses to check or review an empty draft', () => {
    const actor = createActor(sendMachine).start()
    actor.send({ type: 'CHECK' })
    expect(actor.getSnapshot().matches({ editing: 'idle' })).toBe(true)
    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().matches({ editing: 'idle' })).toBe(true)
  })

  it('ignores a second check while one is in flight', () => {
    const actor = drafted()
    actor.send({ type: 'CHECK' })
    actor.send({ type: 'CHECK' })
    expect(actor.getSnapshot().matches({ editing: 'checking' })).toBe(true)
  })

  it('drops a refused check back to idle with the draft intact', () => {
    const actor = drafted()
    actor.send({ type: 'CHECK' })
    actor.send({ type: 'REFUSE' })

    const snapshot = actor.getSnapshot()
    expect(snapshot.matches({ editing: 'idle' })).toBe(true)
    expect(snapshot.context.to).toBe('1BitcoinAddress')
    expect(snapshot.context.amount).toBe('0.5')
  })

  it('still lets the draft change while checking', () => {
    const actor = drafted()
    actor.send({ type: 'CHECK' })
    actor.send({ type: 'EDIT', amount: '0.75' })
    expect(actor.getSnapshot().matches({ editing: 'checking' })).toBe(true)
    expect(actor.getSnapshot().context.amount).toBe('0.75')
  })
})
