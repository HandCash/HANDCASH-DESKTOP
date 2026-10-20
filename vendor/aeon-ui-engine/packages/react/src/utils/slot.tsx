import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { mergeProps } from './merge-props.js'

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === 'function') ref(node)
      else (ref as { current: T }).current = node
    }
  }
}

export type SlotProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode
}

/**
 * Radix-style Slot — merges Aeon attrs onto a single child element
 * (e.g. Next.js Link) instead of rendering a wrapper.
 */
export const Slot = forwardRef<HTMLElement, SlotProps>(function Slot(
  { children, ...props },
  forwardedRef,
) {
  const child = Children.only(children)
  if (!isValidElement(child)) {
    throw new Error('Slot expects a single React element child')
  }

  const childElement = child as ReactElement<HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> }>
  const childProps = childElement.props

  return cloneElement(childElement, {
    ...mergeProps(props, childProps),
    ref: mergeRefs(forwardedRef, childProps.ref),
  } as HTMLAttributes<HTMLElement>)
})
