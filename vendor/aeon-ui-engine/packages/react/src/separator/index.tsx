import { partAttrs, separatorAnatomy } from '@aeon-ui/core'
import { forwardRef, type HTMLAttributes } from 'react'
import { mergeProps } from '../utils/merge-props.js'

export interface SeparatorRootProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical'
}

const Root = forwardRef<HTMLDivElement, SeparatorRootProps>(function SeparatorRoot(
  { orientation = 'horizontal', ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={orientation}
      {...mergeProps(partAttrs(separatorAnatomy.scope, separatorAnatomy.root), rest)}
    />
  )
})

export const Separator = { Root }
