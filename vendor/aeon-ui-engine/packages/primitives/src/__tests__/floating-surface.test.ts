import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { dialogMachine } from '../machines/dialog.js'
import { popoverMachine } from '../machines/popover.js'

const machines = [
  { name: 'popoverMachine', machine: popoverMachine, input: { open: false } },
  { name: 'dialogMachine', machine: dialogMachine, input: { open: false } },
] as const

describe.each(machines)('$name', ({ machine, input }) => {
  it('opens on TOGGLE and closes on outside pointer', () => {
    const actor = createActor(machine, { input })
    actor.start()
    actor.send({ type: 'TOGGLE' })
    expect(actor.getSnapshot().matches('open')).toBe(true)
    actor.send({ type: 'POINTER_DOWN_OUTSIDE' })
    expect(actor.getSnapshot().matches('closed')).toBe(true)
  })

  it('respects controlled SET_OPEN', () => {
    const actor = createActor(machine, { input })
    actor.start()
    actor.send({ type: 'SET_OPEN', open: true })
    expect(actor.getSnapshot().matches('open')).toBe(true)
    actor.send({ type: 'SET_OPEN', open: false })
    expect(actor.getSnapshot().matches('closed')).toBe(true)
  })
})
