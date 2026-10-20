import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { rangeSliderMachine } from '../machines/range-slider.js'

describe('rangeSliderMachine', () => {
  it('normalizes and enforces minStepsBetween on SET_VALUES', () => {
    const actor = createActor(rangeSliderMachine, {
      input: { values: [10, 90], min: 0, max: 100, step: 1, minStepsBetween: 10 },
    }).start()

    actor.send({ type: 'SET_VALUES', values: [50, 55] })
    expect(actor.getSnapshot().context.values).toEqual([50, 60])
  })

  it('moves start thumb with gap constraint while dragging', () => {
    const actor = createActor(rangeSliderMachine, {
      input: { values: [20, 80], min: 0, max: 100, step: 1, minStepsBetween: 5 },
    }).start()

    actor.send({ type: 'POINTER_DOWN', thumb: 0 })
    actor.send({ type: 'POINTER_MOVE', value: 90 })
    expect(actor.getSnapshot().context.values).toEqual([75, 80])
    expect(actor.getSnapshot().matches({ interaction: 'dragging' })).toBe(true)

    actor.send({ type: 'POINTER_UP' })
    expect(actor.getSnapshot().matches({ interaction: 'idle' })).toBe(true)
    expect(actor.getSnapshot().context.activeThumb).toBeNull()
  })

  it('ignores interaction when disabled', () => {
    const actor = createActor(rangeSliderMachine, {
      input: { values: [10, 40], min: 0, max: 100, step: 1, disabled: true },
    }).start()

    actor.send({ type: 'POINTER_DOWN', thumb: 1 })
    expect(actor.getSnapshot().matches({ interaction: 'idle' })).toBe(true)
    expect(actor.getSnapshot().context.values).toEqual([10, 40])
  })
})
