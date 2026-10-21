import { partAttrs, proseAnatomy } from '@aeon-ui/core'
import { forwardRef, type HTMLAttributes } from 'react'
import { mergeProps } from '../utils/merge-props.js'

export type ProseRootProps = HTMLAttributes<HTMLDivElement>

const Root = forwardRef<HTMLDivElement, ProseRootProps>(function ProseRoot(props, ref) {
  return <div ref={ref} {...mergeProps(partAttrs(proseAnatomy.scope, proseAnatomy.root), props)} />
})

export const Prose = { Root }
