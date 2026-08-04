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

interface SliderContextValue {
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  dragging: boolean
  send: ReturnType<typeof useAeonMachine<typeof sliderMachine>>[1]
  onValueChange?: (value: number) => void
  setValueFromClientX: (clientX: number) => void
  trackRef: React.RefObject<HTMLDivElement | null>
}

const SliderCtx = createContext<SliderContextValue | null>(null)

function useSliderCtx() {
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
    onValueChange?.(resolvedValue)
  }, [resolvedValue, onValueChange])

  useEffect(() => {
    if (value !== undefined) send({ type: 'SET_VALUE', value })
  }, [value, send])

  const setValueFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track || disabled) return
      const rect = track.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const next = snapSliderValue(min + ratio * (max - min), min, max, step)
      send({ type: 'SET_VALUE', value: next })
      if (value === undefined) onValueChange?.(next)
    },
    [disabled, min, max, step, send, value, onValueChange],
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
      send,
      onValueChange,
      setValueFromClientX,
      trackRef,
    }),
    [resolvedValue, min, max, step, disabled, dragging, send, onValueChange, setValueFromClientX],
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
  const { disabled, send, setValueFromClientX, trackRef } = useSliderCtx()

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
  const { value, min, max } = useSliderCtx()
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
  const { value, min, max, step, disabled, dragging, send, setValueFromClientX } = useSliderCtx()

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
              send({ type: 'STEP', delta: step })
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault()
              send({ type: 'STEP', delta: -step })
            }
            if (e.key === 'Home') {
              e.preventDefault()
              send({ type: 'HOME' })
            }
            if (e.key === 'End') {
              e.preventDefault()
              send({ type: 'END' })
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
  const { value } = useSliderCtx()
  return (
    <span ref={ref} {...mergeProps(partOnlyAttrs(sliderAnatomy.valueText), props)}>
      {props.children ?? value}
    </span>
  )
})

export const Slider = { Root, Track, Range, Thumb, ValueText }
