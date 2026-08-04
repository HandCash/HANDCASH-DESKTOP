import { Tabs as Headless } from '@aeon-ui/react'
import { aeonTabs } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const tabs = aeonTabs()

export const Tabs = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(tabs.root, className)} {...props} />
  ),
  List: ({ className, ...props }: ComponentProps<typeof Headless.List>) => (
    <Headless.List className={cn(tabs.list, className)} {...props} />
  ),
  Trigger: ({ className, ...props }: ComponentProps<typeof Headless.Trigger>) => (
    <Headless.Trigger className={cn(tabs.trigger, className)} {...props} />
  ),
  Content: ({ className, ...props }: ComponentProps<typeof Headless.Content>) => (
    <Headless.Content className={cn(tabs.content, className)} {...props} />
  ),
  Indicator: Headless.Indicator,
}
