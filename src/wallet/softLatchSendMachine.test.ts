import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { softLatchSendMachine } from './softLatchSendMachine'

const TX = 'a'.repeat(64)

describe('softLatchSendMachine', () => {
  it('createAction with txid goes straight to done', () => {
    const actor = createActor(softLatchSendMachine).start()
    actor.send({ type: 'START', outpoint: `${TX}.0` })
    actor.send({ type: 'BUILT' })
    actor.send({ type: 'CREATED', txid: 'b'.repeat(64) })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('createAction without txid requires signing', () => {
    const actor = createActor(softLatchSendMachine).start()
    actor.send({ type: 'START', outpoint: `${TX}.0` })
    actor.send({ type: 'BUILT' })
    actor.send({ type: 'CREATED' })
    expect(actor.getSnapshot().matches('signing')).toBe(true)
    actor.send({ type: 'SIGNED', txid: 'c'.repeat(64) })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('FAIL from createAction does not invent another path', () => {
    const actor = createActor(softLatchSendMachine).start()
    actor.send({ type: 'START', outpoint: `${TX}.0` })
    actor.send({ type: 'BUILT' })
    actor.send({ type: 'FAIL', error: 'insufficient' })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
  })
})
