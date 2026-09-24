import { Popover } from '@aeon-ui/react'
import type { ReactNode, RefObject } from 'react'

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
   * Align the panel to this region instead of the trigger. A narrow shell can
   * hand over the bar the toggle sits in, so the panel hangs under the whole
   * bar rather than off the edge the toggle is pinned to.
   */
  anchorRef?: RefObject<HTMLElement | null>
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
  anchorRef,
}: Props) {
  return (
    <Popover.Root className={className}>
      <Popover.Trigger
        className={triggerClassName}
        aria-label={ariaLabel}
        title={title}
        data-active={active ? '' : undefined}
        onClick={onTrigger}
      >
        {trigger}
      </Popover.Trigger>
      <Popover.Positioner placement="bottom-end" anchorRef={anchorRef}>
        <Popover.Content className={contentClassName}>{children}</Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  )
}
