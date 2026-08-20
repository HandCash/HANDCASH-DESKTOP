import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { modelViewerMachine } from './modelViewerMachine'

describe('modelViewerMachine', () => {
  it('keeps the model hidden until its first frame is ready', () => {
    const actor = createActor(modelViewerMachine).start()
    expect(actor.getSnapshot().matches('loading')).toBe(true)
    actor.send({ type: 'READY' })
    expect(actor.getSnapshot().matches('ready')).toBe(true)
  })

  it('names a failed load and remounts only on explicit retry', () => {
    const actor = createActor(modelViewerMachine).start()
    actor.send({ type: 'FAIL', error: 'model fetch failed' })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(actor.getSnapshot().context.error).toBe('model fetch failed')
    actor.send({ type: 'RETRY' })
    expect(actor.getSnapshot().matches('loading')).toBe(true)
    expect(actor.getSnapshot().context.attempt).toBe(1)
    expect(actor.getSnapshot().context.error).toBeNull()
  })
})
