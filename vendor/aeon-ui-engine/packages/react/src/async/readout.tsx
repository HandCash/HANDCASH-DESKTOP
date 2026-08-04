import { asyncAnatomy, partAttrs, partOnlyAttrs } from '@aeon-ui/core'
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'
import { useAsyncContext } from './context.js'

export interface AsyncReadoutProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode
}

export const AsyncReadout = forwardRef<HTMLDivElement, AsyncReadoutProps>(function AsyncReadout(
  { children, className, ...rest },
  ref,
) {
  const { stateAttr } = useAsyncContext()

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      className={className}
      {...mergeProps(partAttrs(asyncAnatomy.scope, asyncAnatomy.readout, { state: stateAttr }), rest)}
    >
      <span
        className="aeon-async-readout__rail"
        aria-hidden
        {...partOnlyAttrs(asyncAnatomy.readoutRail)}
      />
      <div className="aeon-async-readout__body" {...partOnlyAttrs(asyncAnatomy.readoutBody)}>
        {children}
      </div>
    </div>
  )
})
