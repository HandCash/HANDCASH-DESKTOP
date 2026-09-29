import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import {
  ACTION_STAGES,
  actionLifecycleFace,
  actionLifecycleMachine,
  actionProgress,
  actionStageIndex,
} from './actionLifecycleMachine'

const start = (input: Partial<Parameters<typeof createActor>[1]>['input'] = {}) => {
  const actor = createActor(actionLifecycleMachine, {
    input: { id: 'action:1', origin: 'app.example', method: 'createAction', ...input },
  })
  actor.start()
  return actor
}

describe('actionLifecycleMachine', () => {
  it('walks every stage in domain order and settles', () => {
    const actor = start()
    expect(actionLifecycleFace(actor.getSnapshot())).toBe('approving')
    for (const stage of ACTION_STAGES.slice(1)) {
      actor.send({ type: 'STAGE', stage })
      expect(actionLifecycleFace(actor.getSnapshot())).toBe(stage)
    }
    actor.send({ type: 'SETTLE' })
    expect(actionLifecycleFace(actor.getSnapshot())).toBe('settled')
    expect(actor.getSnapshot().status).toBe('done')
    expect(actionProgress(actor.getSnapshot())).toEqual({
      value: ACTION_STAGES.length,
      max: ACTION_STAGES.length,
    })
  })

  it('keeps the txid and touched outputs it learns along the way', () => {
    const actor = start({ outpoints: ['AA_0'] })
    actor.send({ type: 'STAGE', stage: 'signing' })
    actor.send({ type: 'TXID', txid: 'AB'.repeat(32) })
    actor.send({ type: 'TOUCH', outpoints: ['bb.1', 'aa_0'] })
    const { context } = actor.getSnapshot()
    expect(context.txid).toBe('ab'.repeat(32))
    expect(context.outpoints).toEqual(['aa.0', 'bb.1'])
  })

  it('fails from any live stage with the reason kept', () => {
    const actor = start()
    actor.send({ type: 'STAGE', stage: 'broadcasting' })
    actor.send({ type: 'FAIL', reason: 'Insufficient funds' })
    const snapshot = actor.getSnapshot()
    expect(actionLifecycleFace(snapshot)).toBe('failed')
    expect(snapshot.context.error).toBe('Insufficient funds')
    expect(actionStageIndex(snapshot)).toBeNull()
    expect(actionProgress(snapshot)).toBeNull()
  })

  it('projects the live stage as half done so the bar moves on entry', () => {
    const actor = start()
    expect(actionProgress(actor.getSnapshot())).toEqual({ value: 0.5, max: 5 })
    actor.send({ type: 'STAGE', stage: 'settling' })
    expect(actionProgress(actor.getSnapshot())).toEqual({ value: 4.5, max: 5 })
  })

  it('is a flat chart: every face is a CSS token', () => {
    const actor = start()
    actor.send({ type: 'STAGE', stage: 'signing' })
    expect(typeof actor.getSnapshot().value).toBe('string')
  })
})
