import { Popover } from '@aeon-ui/react'
import type { ReactNode } from 'react'

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
      <Popover.Positioner placement="bottom-end">
        <Popover.Content className={contentClassName}>{children}</Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  )
}
