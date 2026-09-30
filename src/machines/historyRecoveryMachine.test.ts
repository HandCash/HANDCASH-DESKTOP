import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { stateToAttr } from '@aeon-ui/core'
import {
  HISTORY_RESTORE_STAGES,
  HISTORY_RESTORE_STAGE_LABELS,
  historyRecoveryMachine,
  historyRestoreProgress,
  historyRestoreStageFace,
  historyRestoreStageIndex,
} from './historyRecoveryMachine'

function foundActor() {
  const actor = createActor(historyRecoveryMachine).start()
  actor.send({ type: 'FOUND', bytes: 4096 })
  return actor
}

describe('historyRecoveryMachine', () => {
  it('starts probing and shows no bar until a restore is underway', () => {
    const actor = createActor(historyRecoveryMachine).start()
    expect(actor.getSnapshot().matches('probing')).toBe(true)
    expect(historyRestoreProgress(actor.getSnapshot())).toBeNull()
    expect(historyRestoreStageFace(actor.getSnapshot(), 'download')).toBe('pending')
  })

  it('classifies the probe: found keeps the size, missing is terminal, unreachable keeps the reason', () => {
    const found = foundActor()
    expect(found.getSnapshot().matches('found')).toBe(true)
    expect(found.getSnapshot().context.bytes).toBe(4096)

    const missing = createActor(historyRecoveryMachine).start()
    missing.send({ type: 'MISSING' })
    expect(missing.getSnapshot().matches('missing')).toBe(true)
    expect(missing.getSnapshot().status).toBe('done')

    const unreachable = createActor(historyRecoveryMachine).start()
    unreachable.send({ type: 'UNREACHABLE', message: 'offline' })
    expect(unreachable.getSnapshot().matches('unreachable')).toBe(true)
    expect(unreachable.getSnapshot().context.error).toBe('offline')
  })

  it('walks the stages in domain order and projects a bar that moves from the first stage', () => {
    const actor = foundActor()
    actor.send({ type: 'RESTORE' })
    expect(actor.getSnapshot().matches({ restoring: 'download' })).toBe(true)
    expect(historyRestoreProgress(actor.getSnapshot())).toEqual({
      value: 0.5,
      max: HISTORY_RESTORE_STAGES.length,
    })

    for (const [index, stage] of HISTORY_RESTORE_STAGES.entries()) {
      actor.send({ type: 'STAGE', stage })
      const snapshot = actor.getSnapshot()
      expect(snapshot.matches({ restoring: stage })).toBe(true)
      expect(historyRestoreStageIndex(snapshot)).toBe(index)
      expect(historyRestoreStageFace(snapshot, stage)).toBe('active')
      if (index > 0) {
        expect(historyRestoreStageFace(snapshot, HISTORY_RESTORE_STAGES[index - 1])).toBe('done')
      }
      if (index < HISTORY_RESTORE_STAGES.length - 1) {
        expect(historyRestoreStageFace(snapshot, HISTORY_RESTORE_STAGES[index + 1])).toBe('pending')
      }
    }

    actor.send({ type: 'SUCCEED', balanceSats: 1234 })
    const done = actor.getSnapshot()
    expect(done.matches('done')).toBe(true)
    expect(done.context.balanceSats).toBe(1234)
    expect(historyRestoreProgress(done)).toEqual({
      value: HISTORY_RESTORE_STAGES.length,
      max: HISTORY_RESTORE_STAGES.length,
    })
    expect(HISTORY_RESTORE_STAGES.every((s) => historyRestoreStageFace(done, s) === 'done')).toBe(
      true
    )
  })

  it('projects nested restoring faces as a flat CSS token', () => {
    const actor = foundActor()
    actor.send({ type: 'RESTORE' })
    actor.send({ type: 'STAGE', stage: 'merge' })
    // CSS keys on the `restoring` prefix: [data-aeon-state^='restoring']
    expect(stateToAttr(actor.getSnapshot().value)).toBe('restoring:merge')
  })

  it('routes an old-password refusal to legacy and lets one retry restart the stages', () => {
    const actor = foundActor()
    actor.send({ type: 'RESTORE' })
    actor.send({ type: 'STAGE', stage: 'merge' })
    actor.send({ type: 'LEGACY_NEEDED', message: 'older unlock password' })
    expect(actor.getSnapshot().matches('legacy')).toBe(true)
    expect(actor.getSnapshot().context.error).toBe('older unlock password')
    expect(historyRestoreProgress(actor.getSnapshot())).toBeNull()

    actor.send({ type: 'RESTORE' })
    expect(actor.getSnapshot().matches({ restoring: 'download' })).toBe(true)
    expect(actor.getSnapshot().context.error).toBeNull()
  })

  it('keeps any other refusal in failure with the message and allows retry', () => {
    const actor = foundActor()
    actor.send({ type: 'RESTORE' })
    actor.send({ type: 'FAIL', message: 'network down' })
    expect(actor.getSnapshot().matches('failure')).toBe(true)
    expect(actor.getSnapshot().context.error).toBe('network down')
    actor.send({ type: 'RESTORE' })
    expect(actor.getSnapshot().matches('restoring')).toBe(true)
  })

  it('ignores stage reports outside of restoring and restore while probing', () => {
    const actor = createActor(historyRecoveryMachine).start()
    actor.send({ type: 'STAGE', stage: 'merge' })
    actor.send({ type: 'RESTORE' })
    expect(actor.getSnapshot().matches('probing')).toBe(true)
  })

  it('labels every stage', () => {
    for (const stage of HISTORY_RESTORE_STAGES) {
      expect(HISTORY_RESTORE_STAGE_LABELS[stage].length).toBeGreaterThan(0)
    }
  })
})
