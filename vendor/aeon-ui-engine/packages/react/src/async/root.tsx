import { asyncAnatomy, partAttrs } from '@aeon-ui/core'
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'
import { AsyncProvider, useAsyncContext } from './context.js'

export interface AsyncRootProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  className?: string
}

const AsyncRootInner = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function AsyncRootInner(
  { children, className, ...rest },
  ref,
) {
  const { stateAttr } = useAsyncContext()

  return (
    <div
      ref={ref}
      className={className}
      {...mergeProps(partAttrs(asyncAnatomy.scope, asyncAnatomy.root, { state: stateAttr }), rest)}
    >
      {children}
    </div>
  )
})

export const AsyncRoot = forwardRef<HTMLDivElement, AsyncRootProps>(function AsyncRoot(
  { children, className, ...rest },
  ref,
) {
  return (
    <AsyncProvider>
      <AsyncRootInner ref={ref} className={className} {...rest}>
        {children}
      </AsyncRootInner>
    </AsyncProvider>
  )
})
