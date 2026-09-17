import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { assetSendMachine } from './assetSendMachine'

describe('assetSendMachine', () => {
  it('reviews a collectable send from a recipient without inventing an amount', () => {
    const actor = createActor(assetSendMachine).start()
    actor.send({ type: 'EDIT', to: '1Addressxxxxxxxxxxxxxxxxx' })
    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().matches('confirming')).toBe(true)
  })

  it('will not review a token send until quantity is set', () => {
    const actor = createActor(assetSendMachine, {
      input: { needsQuantity: true },
    }).start()
    actor.send({ type: 'EDIT', to: '1Addressxxxxxxxxxxxxxxxxx' })
    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().matches('editing')).toBe(true)
    actor.send({ type: 'EDIT', quantity: '2.5' })
    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().matches('confirming')).toBe(true)
  })

  it('will not review when the domain send chart refused', () => {
    const actor = createActor(assetSendMachine).start()
    actor.send({ type: 'EDIT', to: '1Addressxxxxxxxxxxxxxxxxx' })
    actor.send({
      type: 'CLASSIFY',
      refuseReason: 'This collectable is covenant-locked and can no longer be sent.',
    })
    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().matches('editing')).toBe(true)
    expect(actor.getSnapshot().context.refuseReason).toMatch(/covenant-locked/)
  })
})
