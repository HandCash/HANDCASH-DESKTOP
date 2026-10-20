import { partAttrs, partOnlyAttrs, rangeSliderAnatomy } from '@aeon-ui/core'
import {
  rangeSliderMachine,
  snapRangeSliderValue,
} from '@aeon-ui/primitives'
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

type ThumbIndex = 0 | 1

interface RangeSliderContextValue {
  values: [number, number]
  min: number
  max: number
  step: number
  disabled: boolean
  dragging: boolean
  activeThumb: ThumbIndex | null
  send: ReturnType<typeof useAeonMachine<typeof rangeSliderMachine>>[1]
  setThumbFromClientX: (thumb: ThumbIndex, clientX: number) => void
  trackRef: React.RefObject<HTMLDivElement | null>
}

const RangeSliderCtx = createContext<RangeSliderContextValue | null>(null)

function useRangeSliderCtx() {
  const ctx = useContext(RangeSliderCtx)
  if (!ctx) throw new Error('RangeSlider parts must be used within RangeSlider.Root')
  return ctx
}

function percent(value: number, min: number, max: number) {
  if (max <= min) return 0
  return ((value - min) / (max - min)) * 100
}

export interface RangeSliderRootProps {
  value?: [number, number]
  defaultValue?: [number, number]
  min?: number
  max?: number
  step?: number
  minStepsBetween?: number
  disabled?: boolean
  onValueChange?: (value: [number, number]) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, RangeSliderRootProps>(function RangeSliderRoot(
  {
    value,
    defaultValue,
    min = 0,
    max = 100,
    step = 1,
    minStepsBetween = 0,
    disabled = false,
    onValueChange,
    children,
    className,
    ...rest
  },
  ref,
) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [snapshot, send] = useAeonMachine(rangeSliderMachine, {
    input: {
      values: defaultValue ?? [min, max],
      min,
      max,
      step,
      minStepsBetween,
      disabled,
    },
  })

  const resolvedValues = value ?? snapshot.context.values
  const dragging = snapshot.matches({ interaction: 'dragging' })
  const activeThumb = snapshot.context.activeThumb

  useEffect(() => {
    if (value !== undefined) send({ type: 'SET_VALUES', values: value })
  }, [value, send])

  useEffect(() => {
    send({ type: 'SET_BOUNDS', min, max, step, minStepsBetween })
  }, [min, max, step, minStepsBetween, send])

  useEffect(() => {
    send({ type: 'SET_DISABLED', disabled })
  }, [disabled, send])

  const setThumbFromClientX = useCallback(
    (thumb: ThumbIndex, clientX: number) => {
      const track = trackRef.current
      if (!track || disabled) return
      const rect = track.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const next = snapRangeSliderValue(min + ratio * (max - min), min, max, step)
      send({ type: 'POINTER_MOVE', value: next })
      if (value === undefined) {
        // Machine updates async via snapshot; notify after POINTER_MOVE by reading next tick
        // Consumers in uncontrolled mode get onValueChange from effect below.
      }
      void thumb
    },
    [disabled, min, max, step, send, value],
  )

  const lastNotified = useRef<string>('')
  useEffect(() => {
    const key = resolvedValues.join(',')
    if (key === lastNotified.current) return
    lastNotified.current = key
    onValueChange?.(resolvedValues)
  }, [resolvedValues, onValueChange])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: globalThis.PointerEvent) => {
      if (activeThumb == null) return
      setThumbFromClientX(activeThumb, e.clientX)
    }
    const onUp = () => send({ type: 'POINTER_UP' })
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, activeThumb, setThumbFromClientX, send])

  const ctx = useMemo(
    () => ({
      values: resolvedValues,
      min,
      max,
      step,
      disabled,
      dragging,
      activeThumb,
      send,
      setThumbFromClientX,
      trackRef,
    }),
    [
      resolvedValues,
      min,
      max,
      step,
      disabled,
      dragging,
      activeThumb,
      send,
      setThumbFromClientX,
    ],
  )

  return (
    <RangeSliderCtx.Provider value={ctx}>
      <div
        ref={ref}
        className={className}
        {...mergeProps(
          partAttrs(rangeSliderAnatomy.scope, rangeSliderAnatomy.root, {
            state: dragging ? 'dragging' : 'idle',
            disabled,
          }),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </RangeSliderCtx.Provider>
  )
})

const Track = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function RangeSliderTrack(
  { onPointerDown, ...rest },
  ref,
) {
  const { disabled, values, send, setThumbFromClientX, trackRef, min, max } = useRangeSliderCtx()

  return (
    <div
      ref={(node) => {
        trackRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      {...mergeProps(
        partOnlyAttrs(rangeSliderAnatomy.track),
        {
          onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
            onPointerDown?.(e)
            if (disabled || e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            const rect = e.currentTarget.getBoundingClientRect()
            const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
            const pointerValue = min + ratio * (max - min)
            const dist0 = Math.abs(pointerValue - values[0])
            const dist1 = Math.abs(pointerValue - values[1])
            const thumb: ThumbIndex = dist0 <= dist1 ? 0 : 1
            send({ type: 'POINTER_DOWN', thumb })
            setThumbFromClientX(thumb, e.clientX)
          },
        },
        rest,
      )}
    />
  )
})

const Range = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function RangeSliderRange(
  { style, ...rest },
  ref,
) {
  const { values, min, max } = useRangeSliderCtx()
  const left = percent(values[0], min, max)
  const right = percent(values[1], min, max)
  return (
    <div
      ref={ref}
      aria-hidden
      {...mergeProps(partOnlyAttrs(rangeSliderAnatomy.range), rest, {
        style: { ...style, left: `${left}%`, width: `${Math.max(0, right - left)}%` },
      })}
    />
  )
})

export interface RangeSliderThumbProps extends HTMLAttributes<HTMLSpanElement> {
  index: ThumbIndex
}

const Thumb = forwardRef<HTMLSpanElement, RangeSliderThumbProps>(function RangeSliderThumb(
  { index, onKeyDown, onPointerDown, style, ...rest },
  ref,
) {
  const { values, min, max, step, disabled, dragging, activeThumb, send, setThumbFromClientX } =
    useRangeSliderCtx()
  const value = values[index]
  const isActive = dragging && activeThumb === index

  return (
    <span
      ref={ref}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={disabled || undefined}
      data-aeon-index={index}
      {...mergeProps(
        partOnlyAttrs(rangeSliderAnatomy.thumb, {
          state: isActive ? 'dragging' : disabled ? 'disabled' : 'idle',
        }),
        {
          style: { ...style, left: `${percent(value, min, max)}%` },
          onPointerDown: (e: PointerEvent<HTMLSpanElement>) => {
            onPointerDown?.(e)
            if (disabled || e.button !== 0) return
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            send({ type: 'POINTER_DOWN', thumb: index })
            setThumbFromClientX(index, e.clientX)
          },
          onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
            onKeyDown?.(e)
            if (disabled || e.defaultPrevented) return
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault()
              send({ type: 'STEP', thumb: index, delta: step })
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault()
              send({ type: 'STEP', thumb: index, delta: -step })
            }
            if (e.key === 'Home') {
              e.preventDefault()
              send({ type: 'HOME', thumb: index })
            }
            if (e.key === 'End') {
              e.preventDefault()
              send({ type: 'END', thumb: index })
            }
          },
        },
        rest,
      )}
    />
  )
})

const ValueText = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function RangeSliderValueText(props, ref) {
    const { values } = useRangeSliderCtx()
    return (
      <span ref={ref} {...mergeProps(partOnlyAttrs(rangeSliderAnatomy.valueText), props)}>
        {props.children ?? `${values[0]} – ${values[1]}`}
      </span>
    )
  },
)

export const RangeSlider = { Root, Track, Range, Thumb, ValueText }
