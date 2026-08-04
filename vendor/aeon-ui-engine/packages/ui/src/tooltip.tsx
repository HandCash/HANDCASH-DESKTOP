import { Tooltip as Headless } from '@aeon-ui/react'
import { aeonTooltip } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const tooltip = aeonTooltip()

export const Tooltip = {
  Root: Headless.Root,
  Trigger: ({ className, ...props }: ComponentProps<typeof Headless.Trigger>) => (
    <Headless.Trigger className={cn(tooltip.trigger, className)} {...props} />
  ),
  Positioner: ({ className, ...props }: ComponentProps<typeof Headless.Positioner>) => (
    <Headless.Positioner className={cn(tooltip.positioner, className)} {...props} />
  ),
  Content: ({ className, ...props }: ComponentProps<typeof Headless.Content>) => (
    <Headless.Content className={cn(tooltip.content, className)} {...props} />
  ),
}
