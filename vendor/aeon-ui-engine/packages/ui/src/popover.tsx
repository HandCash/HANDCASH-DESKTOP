import { Popover as Headless } from '@aeon-ui/react'
import { aeonPopover } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const popover = aeonPopover()

export const Popover = {
  Root: Headless.Root,
  Trigger: ({ className, ...props }: ComponentProps<typeof Headless.Trigger>) => (
    <Headless.Trigger className={cn(popover.trigger, className)} {...props} />
  ),
  Positioner: ({ className, ...props }: ComponentProps<typeof Headless.Positioner>) => (
    <Headless.Positioner className={cn(popover.positioner, className)} {...props} />
  ),
  Content: ({ className, ...props }: ComponentProps<typeof Headless.Content>) => (
    <Headless.Content className={cn(popover.content, className)} {...props} />
  ),
  CloseTrigger: ({ className, ...props }: ComponentProps<typeof Headless.CloseTrigger>) => (
    <Headless.CloseTrigger className={cn(popover.closeTrigger, className)} {...props} />
  ),
}
