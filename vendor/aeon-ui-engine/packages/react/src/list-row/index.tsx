import { listRowAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'

export interface ListRowRootProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  as?: 'button' | 'div' | 'a'
  children?: ReactNode
}

/**
 * ListRow — settings / account menu row.
 * Leading icon · label · optional description · trailing control.
 * Full-width hit target (~h-12).
 */
const Root = forwardRef<HTMLElement, ListRowRootProps>(function ListRowRoot(
  { as: Tag = 'button', type, children, ...rest },
  ref,
) {
  const buttonType = Tag === 'button' ? (type ?? 'button') : undefined
  return (
    <Tag
      ref={ref as never}
      type={buttonType as never}
      {...mergeProps(scopeAttrs(listRowAnatomy.scope, listRowAnatomy.root), rest)}
    >
      {children}
    </Tag>
  )
})

const Leading = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function ListRowLeading(
  props,
  ref,
) {
  return (
    <span
      ref={ref}
      {...mergeProps(partAttrs(listRowAnatomy.scope, listRowAnatomy.leading), props)}
    />
  )
})

const Label = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function ListRowLabel(
  props,
  ref,
) {
  return (
    <span ref={ref} {...mergeProps(partAttrs(listRowAnatomy.scope, listRowAnatomy.label), props)} />
  )
})

const Description = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function ListRowDescription(props, ref) {
    return (
      <span
        ref={ref}
        {...mergeProps(partAttrs(listRowAnatomy.scope, listRowAnatomy.description), props)}
      />
    )
  },
)

const Trailing = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function ListRowTrailing(props, ref) {
    return (
      <span
        ref={ref}
        {...mergeProps(partAttrs(listRowAnatomy.scope, listRowAnatomy.trailing), props)}
      />
    )
  },
)

export const ListRow = {
  Root,
  Leading,
  Label,
  Description,
  Trailing,
}
