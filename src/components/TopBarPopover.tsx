import { Popover } from '@aeon-ui/react'
import type { ReactNode, RefObject } from 'react'
import { useCompactShell } from '../wallet/isCompactShell'

type Props = {
  ariaLabel: string
  title?: string
  trigger: ReactNode
  children: ReactNode
  active?: boolean
  className?: string
  triggerClassName?: string
  contentClassName?: string
  onTrigger?: () => void
  /**
   * Region to anchor and size the panel to **on a compact shell**.
   *
   * A top bar toggle is a ~28px control pinned to one edge. On a phone that is
   * the wrong thing to hang a wide panel off: it lands against the screen edge
   * and the clamp can only push it back. Given the bar the toggle sits in, the
   * panel spans that bar instead. Roomy shells keep the trigger-anchored
   * default.
   */
  compactAnchorRef?: RefObject<HTMLElement | null>
}

function withPanelAnchored(base: string | undefined): string | undefined {
  return base ? `${base} is-panel-anchored` : 'is-panel-anchored'
}

/**
 * Reusable top-bar extension. The Aeon popover chart owns open/closed state;
 * its portalled positioner lets the selected control extend over page content
 * without moving the bar or the content beneath it.
 */
export function TopBarPopover({
  ariaLabel,
  title,
  trigger,
  children,
  active = false,
  className,
  triggerClassName,
  contentClassName,
  onTrigger,
  compactAnchorRef,
}: Props) {
  // Subscribed here rather than in the owning panel: this is a leaf, so a
  // layout change re-renders a popover instead of a long activity list.
  const compact = useCompactShell()
  const panelAnchored = compact && compactAnchorRef != null

  return (
    <Popover.Root
      className={panelAnchored ? withPanelAnchored(className) : className}
    >
      <Popover.Trigger
        className={triggerClassName}
        aria-label={ariaLabel}
        title={title}
        data-active={active ? '' : undefined}
        onClick={onTrigger}
      >
        {trigger}
      </Popover.Trigger>
      <Popover.Positioner
        placement="bottom-end"
        anchorRef={panelAnchored ? compactAnchorRef : undefined}
        matchAnchorWidth={panelAnchored}
      >
        <Popover.Content
          className={
            panelAnchored ? withPanelAnchored(contentClassName) : contentClassName
          }
        >
          {children}
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  )
}
