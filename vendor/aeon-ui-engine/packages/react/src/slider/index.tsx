import { partAttrs, partOnlyAttrs, sliderAnatomy } from '@aeon-ui/core'
import { sliderMachine, snapSliderValue } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

export interface SliderContextValue {
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  dragging: boolean
  /** Nested region value from the machine: `interaction.idle` | `interaction.dragging`. */
  interaction: 'idle' | 'dragging'
  send: ReturnType<typeof useAeonMachine<typeof sliderMachine>>[1]
  onValueChange?: (value: number) => void
  /** Snap, store and report a user-intended value. */
  commit: (value: number) => void
  setValueFromClientX: (clientX: number) => void
  trackRef: React.RefObject<HTMLDivElement | null>
}

const SliderCtx = createContext<SliderContextValue | null>(null)

/**
 * Read the slider's live machine state from inside `Slider.Root`.
 * `interaction` is the nested region value — the same thing the snapshot holds.
 */
export function useSliderContext() {
  const ctx = useContext(SliderCtx)
  if (!ctx) throw new Error('Slider parts must be used within Slider.Root')
  return ctx
}

function percent(value: number, min: number, max: number) {
  if (max <= min) return 0
  return ((value - min) / (max - min)) * 100
}

export interface SliderRootProps {
  value?: number
  defaultValue?: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  onValueChange?: (value: number) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, SliderRootProps>(function SliderRoot(
  {
    value,
    defaultValue,
    min = 0,
    max = 100,
    step = 1,
    disabled = false,
    onValueChange,
    children,
    className,
    ...rest
  },
  ref,
) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [snapshot, send] = useAeonMachine(sliderMachine, {
    input: {
      value: defaultValue ?? min,
      min,
      max,
      step,
      disabled,
    },
  })

  const resolvedValue = value ?? snapshot.context.value
  const dragging = snapshot.matches({ interaction: 'dragging' })

  useEffect(() => {
    if (value !== undefined) send({ type: 'SET_VALUE', value })
  }, [value, send])

  useEffect(() => {
    send({ type: 'SET_BOUNDS', min, max, step })
  }, [min, max, step, send])

  useEffect(() => {
    send({ type: 'SET_DISABLED', disabled })
  }, [disabled, send])

  /**
   * Interaction is emitted here, never echoed from the resolved value. A
   * controlled slider therefore reports what the user did (Aeon ≤1.4.0 stayed
   * silent while `value` was set) and never fires on mount.
   */
  const commit = useCallback(
    (next: number) => {
      if (disabled) return
      const snapped = snapSliderValue(next, min, max, step)
      send({ type: 'SET_VALUE', value: snapped })
      onValueChange?.(snapped)
    },
    [disabled, min, max, step, send, onValueChange],
  )

  const setValueFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track || disabled) return
      const rect = track.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      commit(min + ratio * (max - min))
    },
    [commit, disabled, min, max],
  )

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: globalThis.PointerEvent) => setValueFromClientX(e.clientX)
    const onUp = () => send({ type: 'POINTER_UP' })
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, setValueFromClientX, send])

  const ctx = useMemo(
    () => ({
      value: resolvedValue,
      min,
      max,
      step,
      disabled,
      dragging,
      interaction: (dragging ? 'dragging' : 'idle') as 'idle' | 'dragging',
      send,
      onValueChange,
      commit,
      setValueFromClientX,
      trackRef,
    }),
    [
      resolvedValue,
      min,
      max,
      step,
      disabled,
      dragging,
      send,
      onValueChange,
      commit,
      setValueFromClientX,
    ],
  )

  return (
    <SliderCtx.Provider value={ctx}>
      <div
        ref={ref}
        className={className}
        {...mergeProps(
          partAttrs(sliderAnatomy.scope, sliderAnatomy.root, {
            state: dragging ? 'dragging' : 'idle',
            disabled,
          }),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </SliderCtx.Provider>
  )
})

const Track = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function SliderTrack(
  { onPointerDown, ...rest },
  ref,
) {
  const { disabled, send, setValueFromClientX, trackRef } = useSliderContext()

  return (
    <div
      ref={(node) => {
        trackRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      {...mergeProps(
        partOnlyAttrs(sliderAnatomy.track),
        {
          onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
            onPointerDown?.(e)
            if (disabled || e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            send({ type: 'POINTER_DOWN' })
            setValueFromClientX(e.clientX)
          },
        },
        rest,
      )}
    />
  )
})

const Range = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function SliderRange(
  { style, ...rest },
  ref,
) {
  const { value, min, max } = useSliderContext()
  return (
    <div
      ref={ref}
      {...mergeProps(partOnlyAttrs(sliderAnatomy.range), rest, {
        style: { ...style, width: `${percent(value, min, max)}%` },
      })}
    />
  )
})

const Thumb = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function SliderThumb(
  { onKeyDown, onPointerDown, style, ...rest },
  ref,
) {
  const { value, min, max, step, disabled, dragging, send, commit, setValueFromClientX } =
    useSliderContext()

  return (
    <span
      ref={ref}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={disabled || undefined}
      {...mergeProps(
        partOnlyAttrs(sliderAnatomy.thumb, { state: dragging ? 'dragging' : disabled ? 'disabled' : 'idle' }),
        {
          style: { ...style, left: `${percent(value, min, max)}%` },
          onPointerDown: (e: PointerEvent<HTMLSpanElement>) => {
            onPointerDown?.(e)
            if (disabled || e.button !== 0) return
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            send({ type: 'POINTER_DOWN' })
            setValueFromClientX(e.clientX)
          },
          onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
            onKeyDown?.(e)
            if (disabled || e.defaultPrevented) return
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault()
              commit(value + step)
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault()
              commit(value - step)
            }
            if (e.key === 'PageUp') {
              e.preventDefault()
              commit(value + (max - min) / 10)
            }
            if (e.key === 'PageDown') {
              e.preventDefault()
              commit(value - (max - min) / 10)
            }
            if (e.key === 'Home') {
              e.preventDefault()
              commit(min)
            }
            if (e.key === 'End') {
              e.preventDefault()
              commit(max)
            }
          },
        },
        rest,
      )}
    />
  )
})

const ValueText = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function SliderValueText(
  props,
  ref,
) {
  const { value } = useSliderContext()
  return (
    <span ref={ref} {...mergeProps(partOnlyAttrs(sliderAnatomy.valueText), props)}>
      {props.children ?? value}
    </span>
  )
})

export const Slider = { Root, Track, Range, Thumb, ValueText }
