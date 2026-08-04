import { asyncAnatomy, partOnlyAttrs } from '@aeon-ui/core'
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'

export interface AsyncActionsProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export const AsyncActions = forwardRef<HTMLDivElement, AsyncActionsProps>(function AsyncActions(
  { children, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={className}
      {...mergeProps(partOnlyAttrs(asyncAnatomy.actions), rest)}
    >
      {children}
    </div>
  )
})
