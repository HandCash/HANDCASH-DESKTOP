import { Dialog as Headless } from '@aeon-ui/react'
import { aeonDialog } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const dialog = aeonDialog()

export const Dialog = {
  Root: Headless.Root,
  Trigger: ({ className, ...props }: ComponentProps<typeof Headless.Trigger>) => (
    <Headless.Trigger className={cn(dialog.trigger, className)} {...props} />
  ),
  Portal: Headless.Portal,
  Backdrop: ({ className, ...props }: ComponentProps<typeof Headless.Backdrop>) => (
    <Headless.Backdrop className={cn(dialog.backdrop, className)} {...props} />
  ),
  Positioner: ({ className, ...props }: ComponentProps<typeof Headless.Positioner>) => (
    <Headless.Positioner className={cn(dialog.positioner, className)} {...props} />
  ),
  Content: ({ className, ...props }: ComponentProps<typeof Headless.Content>) => (
    <Headless.Content className={cn(dialog.content, className)} {...props} />
  ),
  Title: ({ className, ...props }: ComponentProps<typeof Headless.Title>) => (
    <Headless.Title className={cn(dialog.title, className)} {...props} />
  ),
  Description: ({ className, ...props }: ComponentProps<typeof Headless.Description>) => (
    <Headless.Description className={cn(dialog.description, className)} {...props} />
  ),
  CloseTrigger: ({ className, ...props }: ComponentProps<typeof Headless.CloseTrigger>) => (
    <Headless.CloseTrigger className={cn(dialog.closeTrigger, className)} {...props} />
  ),
}
