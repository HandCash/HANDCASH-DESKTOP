import { assign, setup } from 'xstate'

export interface RangeSliderContext {
  values: [number, number]
  min: number
  max: number
  step: number
  minStepsBetween: number
  disabled: boolean
  activeThumb: 0 | 1 | null
}

export type RangeSliderEvent =
  | { type: 'SET_VALUES'; values: [number, number] }
  | { type: 'SET_BOUNDS'; min: number; max: number; step: number; minStepsBetween: number }
  | { type: 'SET_DISABLED'; disabled: boolean }
  | { type: 'POINTER_DOWN'; thumb: 0 | 1 }
  | { type: 'POINTER_MOVE'; value: number }
  | { type: 'POINTER_UP' }
  | { type: 'STEP'; thumb: 0 | 1; delta: number }
  | { type: 'HOME'; thumb: 0 | 1 }
  | { type: 'END'; thumb: 0 | 1 }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function snap(value: number, min: number, max: number, step: number) {
  if (step <= 0) return clamp(value, min, max)
  const snapped = min + Math.round((value - min) / step) * step
  return clamp(snapped, min, max)
}

function normalizePair(
  raw: [number, number],
  min: number,
  max: number,
  step: number,
  minStepsBetween: number,
): [number, number] {
  const gap = Math.max(0, minStepsBetween) * (step > 0 ? step : 1)
  let a = snap(raw[0], min, max, step)
  let b = snap(raw[1], min, max, step)
  if (a > b) [a, b] = [b, a]
  if (b - a < gap) {
    if (a + gap <= max) b = snap(a + gap, min, max, step)
    else a = snap(b - gap, min, max, step)
    if (a > b) [a, b] = [b, a]
  }
  return [a, b]
}

function moveThumb(
  context: RangeSliderContext,
  thumb: 0 | 1,
  nextRaw: number,
): [number, number] {
  const { min, max, step, minStepsBetween, values } = context
  const gap = Math.max(0, minStepsBetween) * (step > 0 ? step : 1)
  const next = snap(nextRaw, min, max, step)
  if (thumb === 0) {
    const maxStart = values[1] - gap
    return [clamp(next, min, maxStart), values[1]]
  }
  const minEnd = values[0] + gap
  return [values[0], clamp(next, minEnd, max)]
}

export type RangeSliderInput = {
  values: [number, number]
  min: number
  max: number
  step: number
  minStepsBetween?: number
  disabled?: boolean
}

/** Two-thumb range control — idle vs dragging with activeThumb in context. */
export const rangeSliderMachine = setup({
  types: {
    context: {} as RangeSliderContext,
    events: {} as RangeSliderEvent,
    input: {} as RangeSliderInput,
  },
  guards: {
    notDisabled: ({ context }) => !context.disabled,
  },
  actions: {
    setValues: assign({
      values: ({ context, event }) => {
        if (event.type !== 'SET_VALUES') return context.values
        return normalizePair(
          event.values,
          context.min,
          context.max,
          context.step,
          context.minStepsBetween,
        )
      },
    }),
    setBounds: assign(({ context, event }) => {
      if (event.type !== 'SET_BOUNDS') return {}
      const next = {
        min: event.min,
        max: event.max,
        step: event.step,
        minStepsBetween: event.minStepsBetween,
      }
      return {
        ...next,
        values: normalizePair(
          context.values,
          next.min,
          next.max,
          next.step,
          next.minStepsBetween,
        ),
      }
    }),
    setDisabled: assign({
      disabled: ({ context, event }) =>
        event.type === 'SET_DISABLED' ? event.disabled : context.disabled,
    }),
    pointerDown: assign({
      activeThumb: ({ event }) => (event.type === 'POINTER_DOWN' ? event.thumb : null),
    }),
    pointerMove: assign({
      values: ({ context, event }) => {
        if (event.type !== 'POINTER_MOVE' || context.activeThumb == null) {
          return context.values
        }
        return moveThumb(context, context.activeThumb, event.value)
      },
    }),
    pointerUp: assign({
      activeThumb: null,
    }),
    stepThumb: assign({
      values: ({ context, event }) => {
        if (event.type !== 'STEP') return context.values
        const current = context.values[event.thumb]
        return moveThumb(context, event.thumb, current + event.delta)
      },
    }),
    homeThumb: assign({
      values: ({ context, event }) => {
        if (event.type !== 'HOME') return context.values
        return moveThumb(context, event.thumb, context.min)
      },
    }),
    endThumb: assign({
      values: ({ context, event }) => {
        if (event.type !== 'END') return context.values
        return moveThumb(context, event.thumb, context.max)
      },
    }),
  },
}).createMachine({
  id: 'rangeSlider',
  context: ({ input }) => {
    const min = input.min
    const max = input.max
    const step = input.step
    const minStepsBetween = input.minStepsBetween ?? 0
    return {
      values: normalizePair(input.values, min, max, step, minStepsBetween),
      min,
      max,
      step,
      minStepsBetween,
      disabled: input.disabled ?? false,
      activeThumb: null,
    }
  },
  initial: 'interaction',
  states: {
    interaction: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            SET_VALUES: { actions: 'setValues', guard: 'notDisabled' },
            SET_BOUNDS: { actions: 'setBounds' },
            SET_DISABLED: { actions: 'setDisabled' },
            POINTER_DOWN: { target: 'dragging', actions: 'pointerDown', guard: 'notDisabled' },
            STEP: { actions: 'stepThumb', guard: 'notDisabled' },
            HOME: { actions: 'homeThumb', guard: 'notDisabled' },
            END: { actions: 'endThumb', guard: 'notDisabled' },
          },
        },
        dragging: {
          on: {
            POINTER_MOVE: { actions: 'pointerMove' },
            POINTER_UP: { target: 'idle', actions: 'pointerUp' },
            SET_VALUES: { actions: 'setValues' },
            SET_BOUNDS: { actions: 'setBounds' },
            SET_DISABLED: { actions: 'setDisabled' },
          },
        },
      },
    },
  },
})

export {
  clamp as clampRangeSliderValue,
  snap as snapRangeSliderValue,
  normalizePair as normalizeRangeSliderValues,
}
