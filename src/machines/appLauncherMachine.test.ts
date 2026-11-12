import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { appLauncherMachine } from './appLauncherMachine'

function start() {
  const launch = vi.fn()
  const actor = createActor(
    appLauncherMachine.provide({ actions: { launch: (_, params) => launch(params.id) } }),
  ).start()
  return { actor, launch }
}

describe('appLauncher chart', () => {
  it('first tap shows the label, second tap on the same tile launches it', () => {
    const { actor, launch } = start()
    actor.send({ type: 'TAP', id: 'native:notes' })
    expect(actor.getSnapshot().matches('focused')).toBe(true)
    expect(actor.getSnapshot().context.focused).toBe('native:notes')
    expect(launch).not.toHaveBeenCalled()
    actor.send({ type: 'TAP', id: 'native:notes' })
    expect(launch).toHaveBeenCalledWith('native:notes')
    expect(actor.getSnapshot().matches('idle')).toBe(true)
    expect(actor.getSnapshot().context.focused).toBeNull()
  })

  it('tapping another tile moves focus without launching; DISMISS clears it', () => {
    const { actor, launch } = start()
    actor.send({ type: 'TAP', id: 'a' })
    actor.send({ type: 'TAP', id: 'b' })
    expect(actor.getSnapshot().context.focused).toBe('b')
    actor.send({ type: 'DISMISS' })
    expect(actor.getSnapshot().matches('idle')).toBe(true)
    expect(launch).not.toHaveBeenCalled()
  })
})
