import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { bsvSendMachine } from './bsvSendMachine'

describe('bsvSendMachine', () => {
  it('preparing → broadcasting → done', () => {
    const actor = createActor(bsvSendMachine).start()
    actor.send({ type: 'START', to: '1Abc', satoshis: 1000 })
    expect(actor.getSnapshot().matches('preparing')).toBe(true)
    actor.send({ type: 'READY' })
    expect(actor.getSnapshot().matches('broadcasting')).toBe(true)
    actor.send({ type: 'BROADCASTED', txid: 'a'.repeat(64) })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('FAIL from preparing surfaces as failed', () => {
    const actor = createActor(bsvSendMachine).start()
    actor.send({ type: 'START', to: '1Abc', satoshis: 1000 })
    actor.send({ type: 'FAIL', error: 'Not enough BSV' })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(actor.getSnapshot().context.error).toBe('Not enough BSV')
  })
})
