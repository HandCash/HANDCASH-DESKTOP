import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { activityActionMachine } from './activityActionMachine'

describe('activityActionMachine', () => {
  it('runs one named action and returns to idle on success', () => {
    const actor = createActor(activityActionMachine).start()
    actor.send({ type: 'START', action: 'retry' })
    expect(actor.getSnapshot().matches('busy')).toBe(true)
    expect(actor.getSnapshot().context.action).toBe('retry')
    actor.send({ type: 'SUCCEED' })
    expect(actor.getSnapshot().matches('idle')).toBe(true)
    expect(actor.getSnapshot().context.action).toBeNull()
  })

  it('refuses a competing action while one is in flight', () => {
    const actor = createActor(activityActionMachine).start()
    actor.send({ type: 'START', action: 'rebroadcastAll' })
    actor.send({ type: 'START', action: 'clearAll' })
    expect(actor.getSnapshot().matches('busy')).toBe(true)
    expect(actor.getSnapshot().context.action).toBe('rebroadcastAll')
  })

  it('keeps the failed action and reason until reset or retried', () => {
    const actor = createActor(activityActionMachine).start()
    actor.send({ type: 'START', action: 'reclaim' })
    actor.send({ type: 'FAIL', error: 'inputs already spent' })
    expect(actor.getSnapshot().matches('failure')).toBe(true)
    expect(actor.getSnapshot().context).toEqual({
      action: 'reclaim',
      confirm: null,
      error: 'inputs already spent',
    })
    actor.send({ type: 'START', action: 'clear' })
    expect(actor.getSnapshot().matches('busy')).toBe(true)
    expect(actor.getSnapshot().context.error).toBeNull()
    actor.send({ type: 'SUCCEED' })
    actor.send({ type: 'RESET' })
    expect(actor.getSnapshot().matches('idle')).toBe(true)
  })

  it('ignores a stale RESET while a mutation is running', () => {
    const actor = createActor(activityActionMachine).start()
    actor.send({ type: 'START', action: 'clear' })
    actor.send({ type: 'RESET' })
    expect(actor.getSnapshot().matches('busy')).toBe(true)
  })

  const confirm = {
    title: 'Take these coins back?',
    body: 'Nothing was published, so the coins are yours to spend again.',
    confirmLabel: 'Take back',
    danger: true,
  }

  it('holds the confirm copy as a state until the user decides', () => {
    const actor = createActor(activityActionMachine).start()
    actor.send({ type: 'REQUEST', action: 'reclaim', confirm })
    expect(actor.getSnapshot().matches('confirming')).toBe(true)
    expect(actor.getSnapshot().context).toEqual({ action: 'reclaim', confirm, error: null })
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().matches('busy')).toBe(true)
    expect(actor.getSnapshot().context.action).toBe('reclaim')
    expect(actor.getSnapshot().context.confirm).toBeNull()
  })

  it('cancelling a confirm returns to idle with nothing run', () => {
    const actor = createActor(activityActionMachine).start()
    actor.send({ type: 'REQUEST', action: 'clearAll', confirm })
    actor.send({ type: 'CANCEL' })
    expect(actor.getSnapshot().matches('idle')).toBe(true)
    expect(actor.getSnapshot().context.action).toBeNull()
  })

  it('refuses a new request while confirming or busy', () => {
    const actor = createActor(activityActionMachine).start()
    actor.send({ type: 'REQUEST', action: 'clearAll', confirm })
    actor.send({ type: 'REQUEST', action: 'rebroadcastAll', confirm })
    actor.send({ type: 'START', action: 'publishPending' })
    expect(actor.getSnapshot().matches('confirming')).toBe(true)
    expect(actor.getSnapshot().context.action).toBe('clearAll')
  })
})
