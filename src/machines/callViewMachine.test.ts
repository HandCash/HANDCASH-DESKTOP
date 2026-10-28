import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { callViewMachine, nearestCorner } from './callViewMachine'

function view() {
  const actor = createActor(callViewMachine)
  actor.start()
  return actor
}

describe('callView chart', () => {
  it('moving around the wallet shrinks the call to a tile, and a click expands it', () => {
    const a = view()
    expect(a.getSnapshot().value).toBe('stage')
    a.send({ type: 'NAVIGATED' })
    expect(a.getSnapshot().value).toBe('pip')
    a.send({ type: 'NAVIGATED' })
    expect(a.getSnapshot().value).toBe('pip')
    a.send({ type: 'EXPAND' })
    expect(a.getSnapshot().value).toBe('stage')
  })

  it('the tile keeps the corner it was dragged to, across calls', () => {
    const a = view()
    a.send({ type: 'SHRINK' })
    a.send({ type: 'MOVE', corner: 'top-left' })
    a.send({ type: 'RESET' })
    expect(a.getSnapshot().value).toBe('stage')
    expect(a.getSnapshot().context.corner).toBe('top-left')
  })

  it('the system window takes over from either view and hands back to the stage', () => {
    const a = view()
    a.send({ type: 'SHRINK' })
    a.send({ type: 'ENTERED_SYSTEM_PIP' })
    expect(a.getSnapshot().value).toBe('popped')
    a.send({ type: 'NAVIGATED' })
    expect(a.getSnapshot().value).toBe('popped')
    a.send({ type: 'LEFT_SYSTEM_PIP' })
    expect(a.getSnapshot().value).toBe('stage')
    a.send({ type: 'ENTERED_SYSTEM_PIP' })
    a.send({ type: 'RESET' })
    expect(a.getSnapshot().value).toBe('stage')
  })

  it('snaps to the nearest corner', () => {
    expect(nearestCorner(10, 10, 1000, 800)).toBe('top-left')
    expect(nearestCorner(900, 10, 1000, 800)).toBe('top-right')
    expect(nearestCorner(10, 700, 1000, 800)).toBe('bottom-left')
    expect(nearestCorner(900, 700, 1000, 800)).toBe('bottom-right')
  })
})
