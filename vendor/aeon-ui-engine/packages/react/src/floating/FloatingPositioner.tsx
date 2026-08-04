import { partAttrs } from '@aeon-ui/core'
import { forwardRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { useAnchorPosition, type AnchorPlacement } from '../hooks/use-anchor-position.js'
import { renderPortalled, usePortalledMount } from '../hooks/use-portalled.js'
import { mergeProps } from '../utils/merge-props.js'

export interface FloatingPositionerProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean
  scope: string
  part: string
  triggerRef: RefObject<HTMLElement | null>
  positionerRef: RefObject<HTMLDivElement | null>
  portalled?: boolean
  placement?: AnchorPlacement
  matchAnchorWidth?: boolean
  children?: ReactNode
}

export const FloatingPositioner = forwardRef<HTMLDivElement, FloatingPositionerProps>(
  function FloatingPositioner(
    {
      open,
      scope,
      part,
      triggerRef,
      positionerRef,
      portalled = true,
      placement = 'bottom-start',
      matchAnchorWidth = false,
      children,
      className,
      ...rest
    },
    ref,
  ) {
    const mounted = usePortalledMount()
    useAnchorPosition(triggerRef, positionerRef, open && portalled, placement, {
      matchWidth: matchAnchorWidth,
    })

    if (!open) return null

    const node = (
      <div
        ref={(el) => {
          positionerRef.current = el
          if (typeof ref === 'function') ref(el)
          else if (ref) ref.current = el
        }}
        className={className}
        {...mergeProps(partAttrs(scope, part, { state: 'open' }), rest)}
      >
        {children}
      </div>
    )

    return renderPortalled(node, portalled, mounted)
  },
)
