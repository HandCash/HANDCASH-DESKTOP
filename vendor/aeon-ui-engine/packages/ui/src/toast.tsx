import { Toast as Headless, useToast } from '@aeon-ui/react'
import { aeonToast } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const toast = aeonToast()

export const Toast = {
  Provider: Headless.Provider,
  Viewport: ({
    className,
    placement = 'bottom-end',
    ...props
  }: ComponentProps<typeof Headless.Viewport>) => (
    <Headless.Viewport
      className={cn(toast.viewport, className)}
      placement={placement}
      {...props}
    />
  ),
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(toast.root, className)} {...props} />
  ),
  Title: ({ className, ...props }: ComponentProps<typeof Headless.Title>) => (
    <Headless.Title className={cn(toast.title, className)} {...props} />
  ),
  Description: ({ className, ...props }: ComponentProps<typeof Headless.Description>) => (
    <Headless.Description className={cn(toast.description, className)} {...props} />
  ),
  CloseTrigger: ({ className, ...props }: ComponentProps<typeof Headless.CloseTrigger>) => (
    <Headless.CloseTrigger className={cn(toast.closeTrigger, className)} {...props} />
  ),
  Show: Headless.Show,
}

export { useToast }
