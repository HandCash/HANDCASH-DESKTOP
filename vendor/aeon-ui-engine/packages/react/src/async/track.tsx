import { asyncAnatomy, partOnlyAttrs } from '@aeon-ui/core'
import { ASYNC_LIFECYCLE_STATES } from '@aeon-ui/primitives'
import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react'
import { mergeProps } from '../utils/merge-props.js'
import { useAsyncContext } from './context.js'

type SegmentPhase = 'past' | 'active' | 'future'

function segmentPhase(index: number, activeIndex: number): SegmentPhase {
  if (activeIndex === -1) return 'future'
  if (index === activeIndex) return 'active'
  if (index < activeIndex) return 'past'
  return 'future'
}

export interface AsyncTrackProps extends HTMLAttributes<HTMLDivElement> {
  states?: readonly string[]
}

export const AsyncTrack = forwardRef<HTMLDivElement, AsyncTrackProps>(function AsyncTrack(
  { states = ASYNC_LIFECYCLE_STATES, className, ...rest },
  ref,
) {
  const { status } = useAsyncContext()
  const activeIndex = states.indexOf(status)
  const { style, ...restWithoutStyle } = rest

  return (
    <div
      ref={ref}
      role="list"
      aria-label="Async lifecycle states"
      className={className}
      style={
        {
          ...style,
          ['--aeon-state-track-count' as string]: states.length,
        } as CSSProperties
      }
      {...mergeProps(partOnlyAttrs(asyncAnatomy.track), restWithoutStyle)}
    >
      {states.map((id, index) => {
        const phase = segmentPhase(index, activeIndex)
        return (
          <span
            key={id}
            role="listitem"
            aria-current={phase === 'active' ? 'step' : undefined}
            title={id}
            className={`state-track__seg state-track__seg--${id} state-track__seg--${phase}`}
            {...partOnlyAttrs(asyncAnatomy.segment, { state: `${id} ${phase}` })}
          >
            {id}
          </span>
        )
      })}
    </div>
  )
})
