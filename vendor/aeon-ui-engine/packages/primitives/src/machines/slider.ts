import { assign, setup } from 'xstate'

export interface SliderContext {
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
}

export type SliderEvent =
  | { type: 'SET_VALUE'; value: number }
  | { type: 'STEP'; delta: number }
  | { type: 'POINTER_DOWN' }
  | { type: 'POINTER_UP' }
  | { type: 'HOME' }
  | { type: 'END' }
  | { type: 'SET_BOUNDS'; min: number; max: number; step: number }
  | { type: 'SET_DISABLED'; disabled: boolean }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function snap(value: number, min: number, max: number, step: number) {
  if (step <= 0) return clamp(value, min, max)
  const snapped = min + Math.round((value - min) / step) * step
  return clamp(snapped, min, max)
}

/** Range control — idle vs dragging interaction regions. */
export const sliderMachine = setup({
  types: {
    context: {} as SliderContext,
    events: {} as SliderEvent,
    input: {} as SliderContext,
  },
  guards: {
    notDisabled: ({ context }) => !context.disabled,
  },
  actions: {
    setValue: assign({
      value: ({ context, event }) =>
        event.type === 'SET_VALUE'
          ? snap(event.value, context.min, context.max, context.step)
          : context.value,
    }),
    step: assign({
      value: ({ context, event }) =>
        event.type === 'STEP'
          ? snap(context.value + event.delta, context.min, context.max, context.step)
          : context.value,
    }),
    home: assign({
      value: ({ context }) => context.min,
    }),
    end: assign({
      value: ({ context }) => context.max,
    }),
    setBounds: assign(({ context, event }) => {
      if (event.type !== 'SET_BOUNDS') return context
      const { min, max, step } = event
      return { ...context, min, max, step, value: snap(context.value, min, max, step) }
    }),
    setDisabled: assign({
      disabled: ({ context, event }) =>
        event.type === 'SET_DISABLED' ? event.disabled : context.disabled,
    }),
  },
}).createMachine({
  id: 'slider',
  context: ({ input }) => ({
    value: snap(input.value ?? input.min, input.min, input.max, input.step),
    min: input.min,
    max: input.max,
    step: input.step,
    disabled: input.disabled ?? false,
  }),
  initial: 'interaction',
  // Bounds and disabled follow the host regardless of interaction state, so a
  // range that widens (audio duration arriving) stops clamping to stale limits.
  on: {
    SET_BOUNDS: { actions: 'setBounds' },
    SET_DISABLED: { actions: 'setDisabled' },
  },
  states: {
    interaction: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            SET_VALUE: { actions: 'setValue', guard: 'notDisabled' },
            STEP: { actions: 'step', guard: 'notDisabled' },
            HOME: { actions: 'home', guard: 'notDisabled' },
            END: { actions: 'end', guard: 'notDisabled' },
            POINTER_DOWN: { target: 'dragging', guard: 'notDisabled' },
          },
        },
        dragging: {
          on: {
            SET_VALUE: { actions: 'setValue' },
            POINTER_UP: 'idle',
          },
        },
      },
    },
  },
})

export { clamp as clampSliderValue, snap as snapSliderValue }
