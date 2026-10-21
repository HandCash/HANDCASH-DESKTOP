import type { ForwardedRef } from 'react'

/** Hands a node to a forwarded ref of either shape. */
export function assignRef<T>(ref: ForwardedRef<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node)
  else if (ref) ref.current = node
}
