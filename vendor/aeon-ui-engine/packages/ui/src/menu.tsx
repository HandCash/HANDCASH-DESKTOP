import { Menu as Headless } from '@aeon-ui/react'
import { aeonMenu } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const menu = aeonMenu()

export const Menu = {
  Root: Headless.Root,
  Trigger: ({ className, ...props }: ComponentProps<typeof Headless.Trigger>) => (
    <Headless.Trigger className={cn(menu.trigger, className)} {...props} />
  ),
  Positioner: ({ className, ...props }: ComponentProps<typeof Headless.Positioner>) => (
    <Headless.Positioner className={cn(menu.positioner, className)} {...props} />
  ),
  Content: ({ className, ...props }: ComponentProps<typeof Headless.Content>) => (
    <Headless.Content className={cn(menu.content, className)} {...props} />
  ),
  Item: ({ className, ...props }: ComponentProps<typeof Headless.Item>) => (
    <Headless.Item className={cn(menu.item, className)} {...props} />
  ),
  Separator: ({ className, ...props }: ComponentProps<typeof Headless.Separator>) => (
    <Headless.Separator className={cn(menu.separator, className)} {...props} />
  ),
}
