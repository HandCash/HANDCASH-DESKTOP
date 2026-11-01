import { partAttrs, partOnlyAttrs, textOverflowAnatomy } from '@aeon-ui/core'
import type { TextOverflowMode, TextOverflowState } from '@aeon-ui/core'
import {
  createContext,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { mergeProps } from '../utils/merge-props.js'
import { useTextOverflowState } from './use-text-overflow-state.js'

interface TextOverflowContextValue {
  mode: TextOverflowMode
  state: TextOverflowState
  setPaused: (paused: boolean) => void
  trackRef: React.RefObject<HTMLSpanElement | null>
}

const TextOverflowCtx = createContext<TextOverflowContextValue | null>(null)

export interface TextOverflowRootProps extends HTMLAttributes<HTMLSpanElement> {
  /** Overflow treatment when the label does not fit. Default truncate. */
  mode?: TextOverflowMode
  /** Re-measure when this changes (label string, etc.). */
  watch?: unknown
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLSpanElement, TextOverflowRootProps>(function TextOverflowRoot(
  {
    mode = 'truncate',
    watch,
    children,
    className,
    onMouseEnter,
    onMouseLeave,
    onFocusCapture,
    onBlurCapture,
    ...rest
  },
  ref,
) {
  const viewportRef = useRef<HTMLSpanElement | null>(null)
  const trackRef = useRef<HTMLSpanElement | null>(null)
  const [userPaused, setUserPaused] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReducedMotion(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  const paused = userPaused || reducedMotion
  const state = useTextOverflowState(viewportRef, trackRef, mode, paused, watch)

  const setPaused = useCallback((next: boolean) => {
    setUserPaused(next)
  }, [])

  const ctx = useMemo(
    () => ({ mode, state, setPaused, trackRef }),
    [mode, state, setPaused],
  )

  const looping = mode === 'carousel' && (state === 'carousel' || state === 'paused')

  return (
    <TextOverflowCtx.Provider value={ctx}>
      <span
        ref={(node) => {
          viewportRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        className={className}
        {...mergeProps(
          partAttrs(textOverflowAnatomy.scope, textOverflowAnatomy.root, {
            state,
          }),
          {
            'data-aeon-overflow': mode,
            onMouseEnter: (e: React.MouseEvent<HTMLSpanElement>) => {
              if (mode === 'carousel') setPaused(true)
              onMouseEnter?.(e)
            },
            onMouseLeave: (e: React.MouseEvent<HTMLSpanElement>) => {
              if (mode === 'carousel') setPaused(false)
              onMouseLeave?.(e)
            },
            onFocusCapture: (e: React.FocusEvent<HTMLSpanElement>) => {
              if (mode === 'carousel') setPaused(true)
              onFocusCapture?.(e)
            },
            onBlurCapture: (e: React.FocusEvent<HTMLSpanElement>) => {
              if (mode === 'carousel') setPaused(false)
              onBlurCapture?.(e)
            },
          },
          rest,
        )}
      >
        <span {...partOnlyAttrs(textOverflowAnatomy.viewport)}>
          <span
            ref={trackRef}
            {...partOnlyAttrs(textOverflowAnatomy.track, { state })}
          >
            <span {...partOnlyAttrs(textOverflowAnatomy.item)}>{children}</span>
            {looping ? (
              <span {...partOnlyAttrs(textOverflowAnatomy.item)} aria-hidden="true">
                {children}
              </span>
            ) : null}
          </span>
        </span>
      </span>
    </TextOverflowCtx.Provider>
  )
})

export const TextOverflow = { Root }

export type { TextOverflowMode, TextOverflowState }
