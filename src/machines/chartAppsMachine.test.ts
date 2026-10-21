import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { chartAppsMachine } from './chartAppsMachine'

describe('chartAppsMachine', () => {
  it('shows what an app can do before it runs, then runs it', () => {
    const actor = createActor(chartAppsMachine).start()
    actor.send({ type: 'RUN' })
    expect(actor.getSnapshot().value).toBe('list')
    actor.send({ type: 'OPEN', appId: 'tip-jar', verified: true })
    expect(actor.getSnapshot().value).toBe('reviewing')
    actor.send({ type: 'RUN' })
    expect(actor.getSnapshot().value).toBe('running')
    actor.send({ type: 'BACK' })
    expect(actor.getSnapshot().value).toBe('list')
    expect(actor.getSnapshot().context.appId).toBeNull()
  })

  it('never runs an app that failed verification', () => {
    const actor = createActor(chartAppsMachine).start()
    actor.send({ type: 'OPEN', appId: 'tampered', verified: false })
    actor.send({ type: 'RUN' })
    expect(actor.getSnapshot().value).toBe('reviewing')
  })
})
