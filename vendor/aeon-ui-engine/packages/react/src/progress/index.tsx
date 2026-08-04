import { partAttrs, partOnlyAttrs, progressAnatomy } from '@aeon-ui/core'
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { mergeProps } from '../utils/merge-props.js'

type ProgressState = 'idle' | 'loading' | 'complete'

interface ProgressContextValue {
  value: number
  max: number
  indeterminate: boolean
  state: ProgressState
}

const ProgressCtx = createContext<ProgressContextValue | null>(null)

function useProgressCtx() {
  const ctx = useContext(ProgressCtx)
  if (!ctx) throw new Error('Progress parts must be used within Progress.Root')
  return ctx
}

function resolveProgressState(value: number, max: number, indeterminate: boolean): ProgressState {
  if (indeterminate) return 'loading'
  if (value >= max) return 'complete'
  return 'idle'
}

export interface ProgressRootProps extends HTMLAttributes<HTMLDivElement> {
  value?: number
  max?: number
  indeterminate?: boolean
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, ProgressRootProps>(function ProgressRoot(
  { value = 0, max = 100, indeterminate = false, children, className, ...rest },
  ref,
) {
  const clampedValue = Math.min(Math.max(value, 0), max)
  const state = resolveProgressState(clampedValue, max, indeterminate)
  const ctx = useMemo(
    () => ({ value: clampedValue, max, indeterminate, state }),
    [clampedValue, max, indeterminate, state],
  )

  return (
    <ProgressCtx.Provider value={ctx}>
      <div
        ref={ref}
        className={className}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={indeterminate ? undefined : clampedValue}
        aria-busy={indeterminate || undefined}
        {...mergeProps(
          partAttrs(progressAnatomy.scope, progressAnatomy.root, { state }),
          rest,
        )}
      >
        {children}
      </div>
    </ProgressCtx.Provider>
  )
})

const Track = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ProgressTrack(
  props,
  ref,
) {
  return (
    <div ref={ref} {...mergeProps(partOnlyAttrs(progressAnatomy.track), props)} />
  )
})

const Range = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ProgressRange(
  { style, ...rest },
  ref,
) {
  const { value, max, indeterminate } = useProgressCtx()
  const width = indeterminate ? undefined : `${(value / max) * 100}%`

  return (
    <div
      ref={ref}
      {...mergeProps(partOnlyAttrs(progressAnatomy.range), rest, {
        style: { ...style, width },
      })}
    />
  )
})

const Label = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function ProgressLabel(
  props,
  ref,
) {
  return (
    <span ref={ref} {...mergeProps(partOnlyAttrs(progressAnatomy.label), props)} />
  )
})

export const Progress = { Root, Track, Range, Label }
